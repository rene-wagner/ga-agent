import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import {
  auth, discoverOAuthServerInfo, extractWWWAuthenticateParams, refreshAuthorization, selectResourceURL,
  type AuthProvider, type FetchLike, type OAuthClientProvider, type OAuthDiscoveryState,
  type OAuthClientInformationContext, type StoredOAuthClientInformation, type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { resolveMcpEnvironment, type Config, type HttpMcpServerConfig } from "../config.js";
import { CredentialStore, type Credentials } from "./credentials.js";
import { MCP_TIMEOUT_MS, mcpError } from "./index.js";

function requireSecureUrl(value: string | URL): void {
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))) {
    throw new Error("OAuth erfordert HTTPS (außer auf Loopback-Adressen).");
  }
}

// No MCP headers are forwarded to the authorization server. Untrusted OAuth
// error descriptions are removed before the SDK can include them in warnings.
export function oauthFetch(signal?: AbortSignal): FetchLike {
  return async (input, init) => {
    requireSecureUrl(input instanceof Request ? input.url : String(input));
    const response = await fetch(input, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(MCP_TIMEOUT_MS), ...(signal ? [signal] : []), ...(init?.signal ? [init.signal] : [])]),
    });
    if (response.ok) return response;
    const body = await response.json().catch(() => ({})) as { error?: unknown };
    const allowed = ["invalid_grant", "invalid_client", "unauthorized_client", "access_denied", "invalid_request", "invalid_scope", "unsupported_grant_type", "invalid_client_metadata", "server_error", "temporarily_unavailable"];
    return new Response(JSON.stringify({ error: typeof body.error === "string" && allowed.includes(body.error) ? body.error : "server_error" }), {
      status: response.status,
      headers: { "Content-Type": "application/json", ...(response.headers.has("www-authenticate") ? { "WWW-Authenticate": response.headers.get("www-authenticate")! } : {}) },
    });
  };
}

class FileOAuthProvider implements OAuthClientProvider {
  private verifier?: string;
  constructor(
    readonly store: CredentialStore,
    readonly server: HttpMcpServerConfig,
    readonly data: Credentials,
    private readonly onRedirect: (url: URL) => void | Promise<void>,
    private readonly loginState?: string,
  ) {}

  get redirectUrl() { return this.data.redirectUrl; }
  get clientMetadataUrl() { return this.server.auth?.clientMetadataUrl; }
  get clientMetadata() {
    return {
      client_name: "ga-agent", application_type: "native",
      redirect_uris: [this.redirectUrl], response_types: ["code"],
      grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none",
      ...(this.server.auth?.scopes ? { scope: this.server.auth.scopes.join(" ") } : {}),
    };
  }
  state() {
    if (!this.loginState) throw mcpError(this.store.serverName, "Neue Anmeldung erforderlich", true);
    return this.loginState;
  }
  clientInformation(context?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
    if (this.server.auth?.clientId) return { client_id: this.server.auth.clientId, ...(context ? { issuer: context.issuer } : {}) };
    const client = this.data.clientInformation;
    return !context || client?.issuer === context.issuer ? client : undefined;
  }
  saveClientInformation(client: StoredOAuthClientInformation, context?: OAuthClientInformationContext) {
    const issuer = context?.issuer ?? client.issuer;
    if (!issuer) throw new Error("OAuth-Client ohne Issuer.");
    this.data.clientInformation = { ...client, issuer };
  }
  tokens(context?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    const tokens = this.data.tokens;
    return !context || tokens?.issuer === context.issuer ? tokens : undefined;
  }
  async saveTokens(tokens: StoredOAuthTokens, context?: OAuthClientInformationContext) {
    const issuer = context?.issuer ?? tokens.issuer;
    if (!issuer || issuer !== (this.data.discovery?.authorizationServerMetadata?.issuer ?? this.data.discovery?.authorizationServerUrl)) {
      throw new Error("OAuth-Tokens ohne passenden Issuer.");
    }
    this.data.tokens = { ...tokens, issuer };
    this.data.expiresAt = tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000;
    await this.store.write(this.data);
  }
  redirectToAuthorization(url: URL) { return this.onRedirect(url); }
  saveCodeVerifier(verifier: string) { this.verifier = verifier; }
  codeVerifier() {
    if (!this.verifier) throw new Error("OAuth-PKCE-Verifier fehlt.");
    return this.verifier;
  }
  saveDiscoveryState(discovery: OAuthDiscoveryState) {
    const metadata = discovery.authorizationServerMetadata;
    if (!metadata?.code_challenge_methods_supported?.includes("S256")) {
      throw new Error("OAuth-Server muss PKCE/S256 unterstützen und bekanntgeben.");
    }
    requireSecureUrl(discovery.authorizationServerUrl);
    if (metadata.authorization_endpoint) requireSecureUrl(metadata.authorization_endpoint);
    if (metadata.token_endpoint) requireSecureUrl(metadata.token_endpoint);
    if (metadata.registration_endpoint) requireSecureUrl(metadata.registration_endpoint);
    this.data.discovery = discovery;
  }
  discoveryState() { return this.data.discovery; }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "tokens") { delete this.data.tokens; delete this.data.expiresAt; }
    if (scope === "all" || scope === "client") delete this.data.clientInformation;
    if (scope === "all" || scope === "discovery") delete this.data.discovery;
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
  }
}

export async function startOAuthCallback(state: string, { port = 0, signal, timeoutMs = 300_000 }: {
  port?: number; signal?: AbortSignal; timeoutMs?: number;
} = {}) {
  signal?.throwIfAborted();
  let resolve!: (params: URLSearchParams) => void;
  let reject!: (error: Error) => void;
  let consumed = false;
  let redirectUrl = "";
  const result = new Promise<URLSearchParams>((accept, decline) => { resolve = accept; reject = decline; });
  // The callback may arrive (or time out) before discovery finishes.
  void result.catch(() => {});
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    let url: URL;
    try { url = new URL(request.url ?? "/", redirectUrl); } catch {
      response.writeHead(400).end("Ungültige Anfrage.");
      return;
    }
    if (request.method !== "GET" || request.headers.host !== new URL(redirectUrl).host || url.origin !== new URL(redirectUrl).origin || url.pathname !== "/oauth/callback") {
      response.writeHead(404).end("Nicht gefunden.");
      return;
    }
    const received = url.searchParams.get("state") ?? "";
    if (consumed || url.searchParams.getAll("state").length !== 1 || Buffer.byteLength(received) !== Buffer.byteLength(state) || !timingSafeEqual(Buffer.from(received), Buffer.from(state))) {
      response.writeHead(400).end("Ungültige oder bereits verwendete OAuth-Anfrage.");
      return;
    }
    consumed = true;
    if (url.searchParams.has("error") || url.searchParams.getAll("code").length !== 1 || !url.searchParams.get("code") || url.searchParams.getAll("iss").length > 1) {
      response.writeHead(400).end("Anmeldung fehlgeschlagen oder abgelehnt.");
      reject(new Error("OAuth-Anmeldung fehlgeschlagen oder abgelehnt."));
      return;
    }
    response.end("Antwort empfangen. Bitte das Ergebnis im Terminal prüfen; dieses Fenster kann geschlossen werden.");
    resolve(url.searchParams);
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.setTimeout(5000, (socket) => socket.destroy());
  try {
    await new Promise<void>((accept, decline) => {
      server.once("error", decline);
      server.listen(port, "127.0.0.1", () => { server.removeListener("error", decline); accept(); });
    });
  } catch {
    server.close();
    throw new Error("OAuth-Callback konnte nicht auf der Loopback-Adresse gestartet werden. Ist der Port bereits belegt?");
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OAuth-Callback-Adresse fehlt.");
  redirectUrl = `http://127.0.0.1:${address.port}/oauth/callback`;
  const timer = setTimeout(() => { consumed = true; reject(new Error("OAuth-Anmeldung hat das Zeitlimit überschritten.")); }, timeoutMs);
  const abort = () => { consumed = true; reject(new Error("OAuth-Anmeldung abgebrochen.")); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return {
    redirectUrl,
    result,
    async close() {
      consumed = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      server.closeAllConnections();
      await new Promise<void>((accept) => server.close(() => accept()));
    },
  };
}

async function openBrowser(url: URL): Promise<void> {
  const [command, args] = process.platform === "darwin" ? ["open", [url.href]]
    : process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url.href]]
      : ["xdg-open", [url.href]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

interface OAuthOptions {
  authDirectory?: string;
  signal?: AbortSignal;
}

export async function loginMcpServer(name: string, server: HttpMcpServerConfig, {
  authDirectory, signal, open = openBrowser,
  onAuthorizationUrl = (url) => console.error(`OAuth im Browser öffnen:\n${url.href}`),
  timeoutMs = 300_000,
}: OAuthOptions & { open?: (url: URL) => Promise<void>; onAuthorizationUrl?: (url: URL) => void; timeoutMs?: number } = {}): Promise<void> {
  if (!server.enabled || !server.auth) throw mcpError(name, "Kein aktivierter OAuth-HTTP-Server");
  requireSecureUrl(server.url);
  const headers = resolveMcpEnvironment(server.headers, name);
  const store = new CredentialStore(name, server, authDirectory);
  const deadline = AbortSignal.timeout(timeoutMs);
  const loginSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  await store.withLock(async () => {
    const saved = await store.read();
    const state = randomBytes(32).toString("base64url");
    const savedPort = saved ? Number(new URL(saved.redirectUrl).port) : undefined;
    const callback = await startOAuthCallback(state, { port: server.auth?.redirectPort ?? savedPort, signal: loginSignal, timeoutMs });
    try {
      const data: Credentials = {
        version: 1, binding: store.binding, redirectUrl: callback.redirectUrl,
        clientInformation: saved?.clientInformation,
      };
      const provider = new FileOAuthProvider(store, server, data, async (url) => {
        requireSecureUrl(url);
        onAuthorizationUrl(url);
        await open(url).catch(() => {}); // The displayed URL remains usable manually.
      }, state);
      const fetchFn = oauthFetch(loginSignal);
      const probe = await fetchFn(server.url, { method: "GET", headers: { ...headers, Accept: "application/json, text/event-stream" } });
      const { resourceMetadataUrl } = extractWWWAuthenticateParams(probe);
      await probe.body?.cancel();
      if (await auth(provider, { serverUrl: server.url, resourceMetadataUrl, scope: server.auth?.scopes?.join(" "), fetchFn, forceReauthorization: true }) !== "REDIRECT") {
        throw new Error("OAuth-Server hat keinen Browser-Login angeboten.");
      }
      const params = await callback.result;
      await auth(provider, {
        serverUrl: server.url, authorizationCode: params.get("code")!, iss: params.get("iss") ?? undefined,
        scope: server.auth?.scopes?.join(" "), fetchFn,
      });
      if (!data.tokens) throw new Error("OAuth-Server hat keine Tokens geliefert.");
    } catch {
      throw mcpError(name, loginSignal.aborted ? "OAuth-Anmeldung abgebrochen oder Zeitlimit überschritten" : "OAuth-Anmeldung fehlgeschlagen (Discovery, Registrierung, PKCE oder Callback prüfen)");
    } finally {
      await callback.close();
    }
  }, loginSignal);
}

export function createOAuthAuthProvider(name: string, server: HttpMcpServerConfig, { authDirectory, signal }: OAuthOptions = {}): AuthProvider {
  requireSecureUrl(server.url);
  const store = new CredentialStore(name, server, authDirectory);
  let lastToken: string | undefined;
  const token = async (force: boolean, resourceMetadataUrl?: URL) => {
    if (!(await store.read())?.tokens) throw mcpError(name, "OAuth-Anmeldung fehlt", true);
    return store.withLock(async () => {
      const data = await store.read();
      if (!data?.tokens) throw mcpError(name, "OAuth-Anmeldung fehlt", true);
      if ((!force || data.tokens.access_token !== lastToken) && (data.expiresAt === undefined || data.expiresAt > Date.now() + 30_000)) return data.tokens.access_token;
      if (!data.tokens.refresh_token) throw mcpError(name, "OAuth-Anmeldung ist abgelaufen", true);
      try {
        const fetchFn = oauthFetch(signal);
        const discovery = await discoverOAuthServerInfo(server.url, { resourceMetadataUrl, fetchFn });
        const issuer = discovery.authorizationServerMetadata?.issuer ?? discovery.authorizationServerUrl;
        if (issuer !== data.tokens.issuer) throw new Error("Authorization-Issuer hat sich geändert.");
        const provider = new FileOAuthProvider(store, server, data, () => { throw mcpError(name, "Neue Anmeldung erforderlich", true); });
        provider.saveDiscoveryState(discovery);
        const clientInformation = provider.clientInformation({ issuer });
        if (!clientInformation) throw new Error("OAuth-Client fehlt.");
        const resource = await selectResourceURL(server.url, provider, discovery.resourceMetadata);
        const refreshed = await refreshAuthorization(discovery.authorizationServerUrl, {
          metadata: discovery.authorizationServerMetadata, clientInformation,
          refreshToken: data.tokens.refresh_token, resource, fetchFn,
        });
        await provider.saveTokens({ ...refreshed, issuer });
        return data.tokens.access_token;
      } catch {
        throw mcpError(name, "OAuth-Token konnte nicht erneuert werden; Anmeldung und Verbindung prüfen", true);
      }
    }, signal);
  };
  return {
    async token() { lastToken = await token(false); return lastToken; },
    async onUnauthorized(context) {
      const { resourceMetadataUrl } = extractWWWAuthenticateParams(context.response);
      await token(true, resourceMetadataUrl);
    },
  };
}

export function createOAuthAuthProviders(servers: Config["mcpServers"], options: OAuthOptions = {}): Record<string, AuthProvider> {
  return Object.fromEntries(Object.entries(servers)
    .filter((entry): entry is [string, HttpMcpServerConfig] => entry[1].enabled && entry[1].transport === "http" && !!entry[1].auth)
    .map(([name, server]) => [name, createOAuthAuthProvider(name, server, options)]));
}

export async function logoutMcpServer(name: string, server: HttpMcpServerConfig, { authDirectory, signal }: OAuthOptions = {}): Promise<void> {
  const store = new CredentialStore(name, server, authDirectory);
  await store.withLock(async () => {
    try {
      const data = await store.read();
      const endpoint = data?.discovery?.authorizationServerMetadata?.revocation_endpoint;
      if (data?.tokens && typeof endpoint === "string") {
        const token = data.tokens.refresh_token ?? data.tokens.access_token;
        const params = new URLSearchParams({ token, token_type_hint: data.tokens.refresh_token ? "refresh_token" : "access_token" });
        const client = data.clientInformation;
        const clientId = server.auth?.clientId ?? client?.client_id;
        if (clientId) params.set("client_id", clientId);
        if (client?.client_secret) params.set("client_secret", client.client_secret);
        const response = await oauthFetch(signal)(endpoint, { method: "POST", body: params });
        await response.body?.cancel();
        if (!response.ok) throw new Error("Widerruf abgewiesen");
      }
    } catch {
      throw mcpError(name, "Serverseitiger Widerruf fehlgeschlagen; lokale Anmeldung wird trotzdem gelöscht");
    } finally {
      await store.remove();
    }
  }, signal);
}
