import type { StructuredToolInterface } from "@langchain/core/tools";
import { loadMcpTools } from "@langchain/mcp-adapters";
import { Client, StreamableHTTPClientTransport, type AuthProvider, type Transport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { type Config, resolveMcpEnvironment } from "../config.js";

export const MCP_TIMEOUT_MS = 30_000;

export function mcpError(server: string, action: string, oauth = false): Error {
  const hint = oauth ? ` Bei fehlender oder abgelaufener Anmeldung: ga-agent mcp login ${server}` : "";
  return new Error(`MCP-Server "${server}": ${action}.${hint}`);
}

export function validateToolNames(tools: StructuredToolInterface[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || names.has(tool.name)) {
      throw new Error("MCP-/Agent-Tools enthalten ungültige oder doppelte Namen (maximal 64 Zeichen).");
    }
    names.add(tool.name);
  }
}

interface McpOptions {
  signal?: AbortSignal;
  authProviders?: Record<string, AuthProvider> | ((signal: AbortSignal) => Record<string, AuthProvider>);
  timeoutMs?: number;
}

export async function withMcpTools<T>(
  servers: Config["mcpServers"],
  { signal, authProviders = {}, timeoutMs = MCP_TIMEOUT_MS }: McpOptions,
  run: (tools: StructuredToolInterface[]) => Promise<T>,
): Promise<T> {
  const connections: { client: Client; transport: Transport }[] = [];
  const controller = new AbortController();
  const sessionSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    // Attempt both even if either close fails; also abort in-flight connects.
    const results = await Promise.allSettled(connections.flatMap(({ client, transport }) => [transport.close(), client.close()]));
    if (results.some((result) => result.status === "rejected")) {
      throw new Error("MCP-Verbindungen konnten nicht vollständig geschlossen werden.");
    }
  })();
  const onAbort = () => { void close().catch(() => {}); };
  sessionSignal.addEventListener("abort", onAbort, { once: true });
  let failed = false;

  try {
    sessionSignal.throwIfAborted();
    const providers = typeof authProviders === "function" ? authProviders(sessionSignal) : authProviders;
    const tools: StructuredToolInterface[] = [];
    for (const [name, server] of Object.entries(servers)) {
      if (!server.enabled) continue;
      const environment = resolveMcpEnvironment(server.transport === "stdio" ? server.env : server.headers, name);
      const authProvider = Object.hasOwn(providers, name) ? providers[name] : undefined;
      try {
        sessionSignal.throwIfAborted();
        if (server.transport === "http" && server.auth && !authProvider) {
          throw mcpError(name, "OAuth-Anmeldung fehlt", true);
        }
        const transport = server.transport === "stdio"
          ? new StdioClientTransport({
            command: server.command,
            args: server.args,
            env: environment,
            // Do not forward arbitrary server stderr (which may contain secrets).
            stderr: "ignore",
          })
          : new StreamableHTTPClientTransport(new URL(server.url), {
            requestInit: { headers: environment },
            authProvider,
            onInsufficientScope: "throw",
            reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
            fetch: (input, init) => fetch(input, {
              ...init,
              signal: AbortSignal.any([sessionSignal, AbortSignal.timeout(timeoutMs), ...(init?.signal ? [init.signal] : [])]),
            }),
          });
        const client = new Client({ name: "ga-agent", version: "0.1.0" }, {
          versionNegotiation: { mode: "auto", probe: { timeoutMs: 1000 } },
        });
        connections.push({ client, transport });
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          await client.connect(transport, { signal: sessionSignal, timeout: timeoutMs });
          const loaded = await loadMcpTools(name, client, {
            prefixToolNameWithServerName: true,
            additionalToolNamePrefix: "mcp",
            defaultToolTimeout: timeoutMs,
            elicitation: false,
          });
          for (const tool of loaded) {
            const invoke = tool.func;
            tool.func = async (input, manager, config) => {
              try {
                sessionSignal.throwIfAborted();
                return await invoke(input, manager, {
                  ...config,
                  signal: config?.signal ? AbortSignal.any([sessionSignal, config.signal]) : sessionSignal,
                });
              } catch {
                throw mcpError(name, "Tool-Aufruf fehlgeschlagen", server.transport === "http" && !!server.auth);
              }
            };
          }
          tools.push(...loaded);
        } finally {
          clearTimeout(timer);
        }
      } catch {
        throw mcpError(name, "Verbindung oder Tool-Discovery fehlgeschlagen", server.transport === "http" && !!server.auth);
      }
    }
    validateToolNames(tools);
    sessionSignal.throwIfAborted();
    return await run(tools);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    sessionSignal.removeEventListener("abort", onAbort);
    controller.abort();
    if (failed) await close().catch(() => {});
    else await close();
  }
}
