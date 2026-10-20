import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { HttpMcpServerConfig } from "../../src/config.js";

export async function startMcpHttp({ oauth = true, header }: { oauth?: boolean; header?: string } = {}) {
  const settings = {
    deny: false, pkce: true, registration: true, rejectRefresh: false, rejectTokens: false,
    expiresIn: 3600, issuer: "", failRevocation: false, hangToken: false,
  };
  const counts = { registration: 0, exchange: 0, refresh: 0, revocation: 0, calls: 0 };
  const requests: { path: string; mcpHeader: string }[] = [];
  const codes = new Map<string, { challenge: string; redirect: string; clientId: string }>();
  const refreshTokens = new Set<string>();
  const accessTokens = new Set<string>();
  const mcp = createMcpHandler(() => {
    const server = new McpServer({ name: "http-test", version: "1.0.0" });
    server.registerTool("echo", { inputSchema: z.object({ text: z.string() }) }, async ({ text }) => {
      counts.calls++;
      return { content: [{ type: "text", text }] };
    });
    return server;
  });
  let base = "";
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", base);
      requests.push({ path: url.pathname, mcpHeader: String(request.headers["x-mcp-secret"] ?? "") });
      const json = (data: unknown, status = 200) => {
        response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
      };
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["read"] });
      } else if (url.pathname === "/.well-known/oauth-authorization-server") {
        json({
          issuer: settings.issuer || base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
          ...(settings.registration ? { registration_endpoint: `${base}/register` } : {}),
          revocation_endpoint: `${base}/revoke`, response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"],
          ...(settings.pkce ? { code_challenge_methods_supported: ["S256"] } : {}),
          authorization_response_iss_parameter_supported: true,
        });
      } else if (url.pathname === "/register") {
        counts.registration++;
        json({ ...JSON.parse(body), client_id: "test-client" }, 201);
      } else if (url.pathname === "/authorize") {
        const redirect = url.searchParams.get("redirect_uri")!;
        const callback = new URL(redirect);
        callback.searchParams.set("state", url.searchParams.get("state")!);
        if (settings.deny) {
          callback.searchParams.set("error", "access_denied");
          callback.searchParams.set("error_description", "SECRET must not appear in output");
        } else {
          const code = randomUUID();
          codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect, clientId: url.searchParams.get("client_id")! });
          callback.searchParams.set("code", code);
          callback.searchParams.set("iss", base);
        }
        response.writeHead(302, { Location: callback.href }).end();
      } else if (url.pathname === "/token") {
        if (settings.hangToken) return;
        const params = new URLSearchParams(body);
        if (params.get("grant_type") === "authorization_code") {
          const code = params.get("code")!;
          const pending = codes.get(code);
          codes.delete(code);
          if (!pending || pending.challenge !== createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url") || pending.redirect !== params.get("redirect_uri") || pending.clientId !== params.get("client_id")) {
            json({ error: "invalid_grant", error_description: "SECRET PKCE failure" }, 400);
            return;
          }
          counts.exchange++;
        } else if (params.get("grant_type") === "refresh_token") {
          counts.refresh++;
          if (settings.rejectRefresh || !refreshTokens.delete(params.get("refresh_token")!)) {
            json({ error: "invalid_grant", error_description: "SECRET refresh failure" }, 400);
            return;
          }
        } else {
          json({ error: "unsupported_grant_type" }, 400);
          return;
        }
        const access = randomUUID();
        const refresh = randomUUID();
        accessTokens.add(access);
        refreshTokens.add(refresh);
        json({ access_token: access, token_type: "Bearer", refresh_token: refresh, expires_in: settings.expiresIn, scope: "read" });
      } else if (url.pathname === "/revoke") {
        counts.revocation++;
        if (settings.failRevocation) json({ error: "server_error" }, 500);
        else {
          accessTokens.clear();
          refreshTokens.clear();
          json({});
        }
      } else if (url.pathname === "/mcp") {
        const bearer = request.headers.authorization?.replace(/^Bearer /, "");
        if ((oauth && (settings.rejectTokens || !bearer || !accessTokens.has(bearer))) || (header && request.headers.authorization !== header)) {
          response.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }).end();
          return;
        }
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) {
          if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        const webRequest = new Request(url, {
          method: request.method, headers,
          ...(request.method === "POST" ? { body } : {}),
        });
        const result = await mcp.fetch(webRequest);
        response.writeHead(result.status, Object.fromEntries(result.headers));
        if (result.body) for await (const chunk of result.body) response.write(chunk);
        response.end();
      } else json({}, 404);
    })().catch(() => { response.writeHead(500).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server address missing");
  base = `http://127.0.0.1:${address.port}`;
  return {
    base, settings, counts, requests,
    config: { enabled: true, transport: "http", url: `${base}/mcp`, ...(oauth ? { auth: { type: "oauth" } } : {}) } as HttpMcpServerConfig,
    async authorize(url: URL, modify?: (callback: URL) => void) {
      const redirect = await fetch(url, { redirect: "manual" });
      const callback = new URL(redirect.headers.get("location")!);
      modify?.(callback);
      return fetch(callback);
    },
    async close() {
      await mcp.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
