import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { z } from "zod";

const environmentMap = z.record(z.string().min(1), z.string());
const httpUrl = z.url().refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash;
}, "HTTP(S)-URL ohne Zugangsdaten oder Fragment erwartet");

const oauthSchema = z.strictObject({
  type: z.literal("oauth"),
  clientId: z.string().min(1).optional(),
  clientMetadataUrl: z.url().refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname !== "/" && !url.username && !url.password && !url.hash;
  }).optional(),
  scopes: z.array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/)).optional(),
  redirectPort: z.number().int().min(1).max(65535).optional(),
});

const mcpServerSchema = z.discriminatedUnion("transport", [
  z.strictObject({
    enabled: z.boolean().default(true),
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: environmentMap.optional(),
  }),
  z.strictObject({
    enabled: z.boolean().default(true),
    transport: z.literal("http"),
    url: httpUrl,
    headers: environmentMap.optional(),
    auth: oauthSchema.optional(),
  }),
]).superRefine((server, context) => {
  if (server.transport === "http" && server.auth) {
    if (Object.keys(server.headers ?? {}).some((key) => key.toLowerCase() === "authorization")) {
      context.addIssue({ code: "custom", message: "OAuth und Authorization-Header dürfen nicht kombiniert werden", path: ["headers"] });
    }
    const url = URL.canParse(server.url) ? new URL(server.url) : undefined;
    if (url && url.protocol !== "https:" && !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) {
      context.addIssue({ code: "custom", message: "OAuth erfordert HTTPS (außer auf Loopback-Adressen)", path: ["url"] });
    }
  }
});

const configSchema = z.strictObject({
  mcpServers: z.record(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/), mcpServerSchema).default({}),
  agents: z.strictObject({
    "task-collector": z.strictObject({
      enabled: z.boolean().default(true),
    }).prefault({}),
  }).prefault({}),
});

export type Config = z.infer<typeof configSchema>;
export type McpServerConfig = Config["mcpServers"][string];
export type HttpMcpServerConfig = Extract<McpServerConfig, { transport: "http" }>;

export function resolveMcpEnvironment(
  values: Record<string, string> | undefined,
  serverName: string,
): Record<string, string> | undefined {
  if (!values) return undefined;
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key,
    value.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_match, name: string) => {
      const resolved = process.env[name];
      if (resolved === undefined) {
        throw new Error(`MCP-Server "${serverName}": Umgebungsvariable ${name} fehlt.`);
      }
      return resolved;
    }),
  ]));
}

export function getConfigDirectory(): string {
  return join(homedir(), ".config", "ga-agent");
}

export function loadEnv(
  path = join(getConfigDirectory(), ".env"),
): void {
  try {
    loadEnvFile(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw new Error(`Umgebungsvariablen aus ${path} konnten nicht geladen werden.`, {
      cause: error,
    });
  }
}

export async function loadConfig(
  path = join(getConfigDirectory(), "config.json"),
): Promise<Config> {
  let content: string;

  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return configSchema.parse({});
    }

    throw new Error(`Konfiguration in ${path} konnte nicht gelesen werden.`, {
      cause: error,
    });
  }

  try {
    return configSchema.parse(JSON.parse(content));
  } catch (error) {
    // Zod/JSON parser messages may contain credential values from the input.
    const detail = error instanceof z.ZodError
      ? error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.code}`).join("; ")
      : "Ungültiges JSON";
    throw new Error(`Ungültige Konfiguration in ${path}: ${detail}`);
  }
}
