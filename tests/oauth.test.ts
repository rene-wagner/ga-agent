import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent, type AgentContext } from "../src/agents/runtime.js";
import { CredentialStore } from "../src/mcp/credentials.js";
import { withMcpTools } from "../src/mcp/index.js";
import { createOAuthAuthProvider, loginMcpServer, logoutMcpServer, startOAuthCallback } from "../src/mcp/oauth.js";
import { startMcpHttp } from "./helpers/mcp-http.js";

describe("MCP OAuth", () => {
  let directory: string;
  let authDirectory: string;
  let service: Awaited<ReturnType<typeof startMcpHttp>>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ga-agent-oauth-"));
    authDirectory = join(directory, "auth");
    service = await startMcpHttp();
    vi.stubEnv("LANGSMITH_TRACING", "false");
    vi.stubEnv("LANGCHAIN_TRACING_V2", "false");
  });
  afterEach(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function store() { return new CredentialStore("remote", service.config, authDirectory); }
  function login() {
    return loginMcpServer("remote", service.config, {
      authDirectory, timeoutMs: 2000, onAuthorizationUrl: () => {},
      open: async (url) => { await service.authorize(url); },
    });
  }
  function provider() { return createOAuthAuthProvider("remote", service.config, { authDirectory }); }

  it("logs in via discovery, DCR, browser callback and PKCE, then invokes an HTTP tool", async () => {
    await login();
    expect(service.counts).toMatchObject({ registration: 1, exchange: 1 });
    const saved = await store().read();
    expect(saved?.tokens?.issuer).toBe(service.base);
    expect((await lstat(authDirectory)).mode & 0o777).toBe(0o700);
    expect((await lstat(store().path)).mode & 0o777).toBe(0o600);
    const content = await readFile(store().path, "utf8");
    expect(content).not.toContain("code_verifier");
    await withMcpTools({ remote: service.config }, { authProviders: { remote: provider() } }, async (tools) => {
      expect(tools.map((tool) => tool.name)).toEqual(["mcp__remote_echo"]);
      expect(JSON.stringify(await tools[0].invoke({ text: "authenticated" }))).toContain("authenticated");
    });
    expect(service.counts.calls).toBe(1);
  });

  it("sends configured MCP headers only to the resource server, not OAuth endpoints", async () => {
    vi.stubEnv("GA_OAUTH_HEADER_TEST", "resource-only");
    service.config.headers = { "X-Mcp-Secret": "${GA_OAUTH_HEADER_TEST}" };
    await login();
    await withMcpTools({ remote: service.config }, { authProviders: { remote: provider() } }, async () => {});
    expect(service.requests.some((request) => request.path === "/mcp" && request.mcpHeader === "resource-only")).toBe(true);
    expect(service.requests.filter((request) => request.path !== "/mcp").every((request) => request.mcpHeader === "")).toBe(true);
  });

  it("shares one login between different agents without agent-specific OAuth wiring", async () => {
    await login();
    for (const name of ["first", "second"]) {
      const invoke = async (_input: Record<string, never>, { context }: { context: AgentContext }) => {
        expect(JSON.stringify(await context.mcpTools[0].invoke({ text: name }))).toContain(name);
        return { message: name };
      };
      expect(await runAgent({ name, graph: { invoke } }, {
        mcpServers: { remote: service.config }, authDirectory, skillsPath: join(directory, "missing-skills"),
      })).toEqual({ message: name });
    }
    expect(service.counts).toMatchObject({ registration: 1, exchange: 1, calls: 2 });
  });

  it("reuses client registration and the registered loopback port on another login", async () => {
    await login();
    const redirect = (await store().read())?.redirectUrl;
    await login();
    expect((await store().read())?.redirectUrl).toBe(redirect);
    expect(service.counts.registration).toBe(1);
    expect(service.counts.exchange).toBe(2);
  });

  it("supports a pre-registered public client when DCR is unavailable", async () => {
    service.settings.registration = false;
    service.config.auth = { type: "oauth", clientId: "preregistered" };
    await login();
    expect(service.counts.registration).toBe(0);
    expect(service.counts.exchange).toBe(1);
  });

  it("refreshes expiring tokens once across independent providers and persists rotation", async () => {
    await login();
    const before = (await store().read())!;
    const oldRefresh = before.tokens!.refresh_token;
    before.expiresAt = Date.now() - 1000;
    await store().withLock(() => store().write(before));
    const tokens = await Promise.all([provider().token(), provider().token()]);
    expect(tokens[0]).toBe(tokens[1]);
    expect(service.counts.refresh).toBe(1);
    expect((await store().read())?.tokens?.refresh_token).not.toBe(oldRefresh);
    expect((await readdir(authDirectory)).filter((name) => name.endsWith(".lock") || name.endsWith(".tmp"))).toEqual([]);
  });

  it("aborts an in-flight OAuth refresh when MCP initialization times out", async () => {
    await login();
    const saved = (await store().read())!;
    saved.expiresAt = 0;
    await store().withLock(() => store().write(saved));
    service.settings.hangToken = true;
    await expect(withMcpTools({ remote: service.config }, {
      timeoutMs: 100,
      authProviders: (signal) => ({ remote: createOAuthAuthProvider("remote", service.config, { authDirectory, signal }) }),
    }, vi.fn())).rejects.toThrow("ga-agent mcp login remote");
    expect((await readdir(authDirectory)).some((name) => name.endsWith(".lock"))).toBe(false);
  });

  it("refreshes a rejected access token without starting a browser", async () => {
    await login();
    const saved = (await store().read())!;
    saved.tokens!.access_token = "rejected-access-token";
    await store().withLock(() => store().write(saved));
    await withMcpTools({ remote: service.config }, { authProviders: { remote: provider() } }, async (tools) => {
      expect(JSON.stringify(await tools[0].invoke({ text: "refreshed" }))).toContain("refreshed");
    });
    expect(service.counts.refresh).toBe(1);
    expect(service.counts.exchange).toBe(1);
  });

  it("requires explicit login for absent, unrefreshable or rejected credentials without leaking secrets", async () => {
    await expect(provider().token()).rejects.toThrow("ga-agent mcp login remote");
    await expect(lstat(authDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await login();
    const saved = (await store().read())!;
    saved.expiresAt = 0;
    await store().withLock(() => store().write(saved));
    service.settings.rejectRefresh = true;
    const error = await provider().token().catch((error: Error) => error);
    expect(String(error)).toContain("ga-agent mcp login remote");
    expect(String(error)).not.toContain("SECRET");
    expect(String(error)).not.toContain(saved.tokens!.refresh_token);
    delete saved.tokens!.refresh_token;
    await store().withLock(() => store().write(saved));
    await expect(provider().token()).rejects.toThrow("abgelaufen");
  });

  it("does not reuse credentials when the server URL or OAuth settings change", async () => {
    await login();
    const changed = new CredentialStore("remote", { ...service.config, url: `${service.base}/other` }, authDirectory);
    expect(await changed.read()).toBeUndefined();
    service.config.auth = { type: "oauth", scopes: ["different"] };
    await expect(provider().token()).rejects.toThrow("Anmeldung fehlt");
  });

  it("rejects an issuer change before sending a refresh token", async () => {
    await login();
    const saved = (await store().read())!;
    saved.expiresAt = 0;
    await store().withLock(() => store().write(saved));
    service.settings.issuer = "https://different.invalid";
    await expect(provider().token()).rejects.toThrow("ga-agent mcp login remote");
    expect(service.counts.refresh).toBe(0);
  });

  it("rejects a mismatched callback issuer before exchanging the code", async () => {
    await expect(loginMcpServer("remote", service.config, {
      authDirectory, timeoutMs: 2000, onAuthorizationUrl: () => {},
      open: async (url) => { await service.authorize(url, (callback) => callback.searchParams.set("iss", "https://wrong.invalid")); },
    })).rejects.toThrow("OAuth-Anmeldung fehlgeschlagen");
    expect(service.counts.exchange).toBe(0);
    expect(await store().read()).toBeUndefined();
  });

  it("rejects a failed PKCE exchange without exposing the authorization-server error body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(loginMcpServer("remote", service.config, {
        authDirectory, timeoutMs: 2000, onAuthorizationUrl: () => {},
        open: async (url) => {
          url.searchParams.set("code_challenge", "wrong-challenge");
          await service.authorize(url);
        },
      })).rejects.toThrow("OAuth-Anmeldung fehlgeschlagen");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET");
      expect(await store().read()).toBeUndefined();
    } finally { warn.mockRestore(); }
  });

  it("handles denied consent and a server without advertised S256", async () => {
    service.settings.deny = true;
    await expect(login()).rejects.toThrow("OAuth-Anmeldung fehlgeschlagen");
    expect(await store().read()).toBeUndefined();
    service.settings.deny = false;
    service.settings.pkce = false;
    await expect(login()).rejects.toThrow("OAuth-Anmeldung fehlgeschlagen");
    expect(service.counts.exchange).toBe(0);
  });

  it("revokes tokens on logout and removes local credentials even if revocation fails", async () => {
    await login();
    await logoutMcpServer("remote", service.config, { authDirectory });
    expect(service.counts.revocation).toBe(1);
    expect(await store().read()).toBeUndefined();
    await login();
    service.settings.failRevocation = true;
    await expect(logoutMcpServer("remote", service.config, { authDirectory })).rejects.toThrow("trotzdem gelöscht");
    expect(await store().read()).toBeUndefined();
  });

  it("removes corrupt local credentials on logout even when revocation cannot be attempted", async () => {
    await login();
    await writeFile(store().path, "invalid SECRET credentials");
    await expect(logoutMcpServer("remote", service.config, { authDirectory })).rejects.toThrow("trotzdem gelöscht");
    expect(await store().read()).toBeUndefined();
  });

  it("rejects permissive auth directories/files and symlinks", async () => {
    await mkdir(authDirectory, { mode: 0o755 });
    await expect(login()).rejects.toThrow("0700");
    await chmod(authDirectory, 0o700);
    await login();
    await chmod(store().path, 0o644);
    await expect(store().read()).rejects.toThrow("0600");
    await rm(store().path);
    const outside = join(directory, "outside");
    await writeFile(outside, "SECRET");
    await symlink(outside, store().path);
    await expect(store().read()).rejects.toThrow("OAuth-Daten");
    const linkedDirectory = join(directory, "linked-auth");
    await symlink(authDirectory, linkedDirectory);
    await expect(new CredentialStore("remote", service.config, linkedDirectory).read()).rejects.toThrow("0700");
  });

  it("cancels login, closes the callback listener and releases the credential lock", async () => {
    const controller = new AbortController();
    let callbackUrl = "";
    await expect(loginMcpServer("remote", service.config, {
      authDirectory, signal: controller.signal, onAuthorizationUrl: () => {},
      open: async (url) => {
        callbackUrl = url.searchParams.get("redirect_uri")!;
        controller.abort();
      },
    })).rejects.toThrow("abgebrochen");
    await expect(fetch(callbackUrl)).rejects.toThrow();
    expect((await readdir(authDirectory)).some((name) => name.endsWith(".lock"))).toBe(false);
  });

  it("accepts a valid callback only once and ignores wrong state", async () => {
    const callback = await startOAuthCallback("expected-state", { timeoutMs: 1000 });
    try {
      expect((await fetch(`${callback.redirectUrl}?state=wrong&code=abc`)).status).toBe(400);
      expect((await fetch(`${callback.redirectUrl}?state=expected-state&code=abc&iss=${encodeURIComponent(service.base)}`)).status).toBe(200);
      expect((await callback.result).get("code")).toBe("abc");
      expect((await fetch(`${callback.redirectUrl}?state=expected-state&code=abc`)).status).toBe(400);
    } finally { await callback.close(); }
    await expect(fetch(callback.redirectUrl)).rejects.toThrow();
  });

  it("bounds callback waiting time", async () => {
    const callback = await startOAuthCallback("state", { timeoutMs: 20 });
    try { await expect(callback.result).rejects.toThrow("Zeitlimit"); }
    finally { await callback.close(); }
  });
});
