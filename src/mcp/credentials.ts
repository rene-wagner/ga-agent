import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OAuthClientInformationSchema, OAuthMetadataSchema, OAuthProtectedResourceMetadataSchema, OAuthTokensSchema, OpenIdProviderDiscoveryMetadataSchema } from "@modelcontextprotocol/core";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { getConfigDirectory, type HttpMcpServerConfig } from "../config.js";

const credentialsSchema = z.object({
  version: z.literal(1),
  binding: z.string(),
  redirectUrl: z.url().refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return url.origin.startsWith("http://127.0.0.1:") && url.pathname === "/oauth/callback" && !url.username && !url.password && !url.search && !url.hash;
  }),
  clientInformation: OAuthClientInformationSchema.extend({ issuer: z.string() }).optional(),
  tokens: OAuthTokensSchema.extend({ issuer: z.string() }).optional(),
  expiresAt: z.number().finite().optional(),
  discovery: z.object({
    authorizationServerUrl: z.url(),
    resourceMetadataUrl: z.url().optional(),
    authorizationServerMetadata: z.union([OAuthMetadataSchema, OpenIdProviderDiscoveryMetadataSchema.extend({ revocation_endpoint: z.url().optional() })]).optional(),
    resourceMetadata: OAuthProtectedResourceMetadataSchema.optional(),
  }).optional(),
});

export type Credentials = z.infer<typeof credentialsSchema>;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class CredentialStore {
  readonly path: string;
  readonly binding: string;
  private lockLost = false;

  constructor(
    readonly serverName: string,
    server: HttpMcpServerConfig,
    readonly directory = join(getConfigDirectory(), "auth"),
  ) {
    this.path = join(directory, `${createHash("sha256").update(serverName).digest("hex")}.json`);
    this.binding = createHash("sha256").update(JSON.stringify([new URL(server.url).href, server.auth])).digest("hex");
  }

  private async checkDirectory(create = false): Promise<boolean> {
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let stat;
    try {
      stat = await lstat(this.directory);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return false;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("Auth-Verzeichnis muss dem Benutzer gehören, ein echtes Verzeichnis sein und Rechte 0700 haben.");
    }
    return true;
  }

  async read(): Promise<Credentials | undefined> {
    if (!await this.checkDirectory()) return undefined;
    let file;
    try {
      file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
        throw new Error("Unsichere Dateirechte");
      }
      const data = credentialsSchema.parse(JSON.parse(await file.readFile("utf8")));
      return data.binding === this.binding ? data : undefined;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw new Error(`OAuth-Daten für "${this.serverName}" sind unlesbar, ungültig oder nicht mit Rechten 0600 geschützt.`);
    } finally {
      await file?.close();
    }
  }

  // Call while holding withLock; rename prevents partially written token sets.
  async write(data: Credentials): Promise<void> {
    if (this.lockLost) throw new Error("OAuth-Sperre wurde verloren; Tokens werden nicht überschrieben.");
    const parsed = credentialsSchema.safeParse(data);
    if (!parsed.success) throw new Error(`OAuth-Daten für "${this.serverName}" sind ungültig.`);
    await this.checkDirectory(true);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(parsed.data), { flag: "wx", mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async remove(): Promise<void> {
    await rm(this.path, { force: true });
  }

  async withLock<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.checkDirectory(true);
    const started = Date.now();
    let release: () => Promise<void>;
    while (true) {
      signal?.throwIfAborted();
      try {
        release = await lockfile.lock(this.path, {
          realpath: false, retries: 0, stale: 60_000, update: 10_000,
          onCompromised: () => { this.lockLost = true; },
        });
        this.lockLost = false;
        break;
      } catch (error) {
        if (!hasCode(error, "ELOCKED")) throw new Error(`OAuth-Daten für "${this.serverName}" konnten nicht gesperrt werden.`);
        if (Date.now() - started > 10_000) throw new Error(`OAuth-Daten für "${this.serverName}" werden bereits verwendet. Login/Refresh zuerst beenden.`);
        await delay(50, undefined, { signal });
      }
    }
    try {
      signal?.throwIfAborted();
      const result = await run();
      if (this.lockLost) throw new Error("OAuth-Sperre wurde verloren.");
      return result;
    } finally {
      await release().catch(() => {});
    }
  }
}
