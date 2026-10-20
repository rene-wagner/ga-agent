import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../src/mcp/credentials.js";
import { startMcpHttp } from "./helpers/mcp-http.js";

const execute = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("MCP CLI", () => {
  let home: string;
  let configDirectory: string;
  let service: Awaited<ReturnType<typeof startMcpHttp>>;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ga-agent-mcp-cli-"));
    configDirectory = join(home, ".config", "ga-agent");
    await mkdir(configDirectory, { recursive: true });
    service = await startMcpHttp();
  });
  afterEach(async () => {
    await service.close();
    await rm(home, { recursive: true, force: true });
  });

  function env() {
    return {
      ...process.env, HOME: home, USERPROFILE: home,
      PATH: `${join(home, "bin")}${delimiter}${process.env.PATH}`,
      LANGSMITH_TRACING: "false", LANGCHAIN_TRACING_V2: "false",
    };
  }
  function run(...args: string[]) {
    return execute(process.execPath, ["--import", "tsx", cliPath, ...args], { env: env(), timeout: 10_000 });
  }
  async function configure() {
    await writeFile(join(configDirectory, "config.json"), JSON.stringify({ mcpServers: { remote: service.config } }));
  }

  it("completes browser login, runs with saved credentials, and logs out", async () => {
    await configure();
    await mkdir(join(home, "bin"));
    await writeFile(join(home, "bin", "xdg-open"), `#!/usr/bin/env node
(async () => {
  const response = await fetch(process.argv[2], { redirect: 'manual' });
  await fetch(response.headers.get('location'));
})().catch(() => { process.exitCode = 1; });
`, { mode: 0o755 });
    const login = await run("mcp", "login", "remote");
    expect(login.stdout).toBe('MCP-Server "remote": angemeldet.\n');
    expect(login.stderr).toContain("OAuth im Browser öffnen:");
    const store = new CredentialStore("remote", service.config, join(configDirectory, "auth"));
    const credentials = (await store.read())!;
    expect(login.stderr).not.toContain(credentials.tokens!.access_token);
    credentials.expiresAt = 0;
    await store.withLock(() => store.write(credentials));
    const results = await Promise.all([run("run", "task-collector"), run("run", "task-collector")]);
    for (const result of results) expect(result.stdout).toBe("task-collector: Dummy erfolgreich ausgeführt.\n");
    expect((await run("mcp", "logout", "remote")).stdout).toBe('MCP-Server "remote": abgemeldet.\n');
    expect(await readdir(join(configDirectory, "auth"))).toEqual([]);
    expect(service.counts).toMatchObject({ registration: 1, exchange: 1, refresh: 1, revocation: 1 });
    await expect(run("run", "task-collector")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("ga-agent mcp login remote") });
  });

  it("does not connect or create credentials for listing and help", async () => {
    await configure();
    for (const args of [["list"], ["--help"], ["mcp", "--help"], ["mcp", "login", "--help"]]) {
      expect((await run(...args)).stderr).toBe("");
    }
    expect(await readdir(configDirectory)).toEqual(["config.json"]);
    expect(service.counts.registration).toBe(0);
  });

  it("rejects unknown servers, non-OAuth servers and disabled logins without side effects", async () => {
    await writeFile(join(configDirectory, "config.json"), JSON.stringify({ mcpServers: {
      local: { transport: "stdio", command: "missing" },
      disabled: { ...service.config, enabled: false },
    } }));
    for (const name of ["unknown", "__proto__", "local", "disabled"]) {
      await expect(run("mcp", "login", name)).rejects.toMatchObject({ code: 1 });
    }
    expect(await readdir(configDirectory)).toEqual(["config.json"]);
  });

  it("checks agent activation before MCP and skips disabled servers", async () => {
    await writeFile(join(configDirectory, "config.json"), JSON.stringify({
      agents: { "task-collector": { enabled: false } }, mcpServers: { remote: service.config },
    }));
    await expect(run("run", "task-collector")).rejects.toMatchObject({ stderr: expect.stringContaining("deaktiviert") });
    await writeFile(join(configDirectory, "config.json"), JSON.stringify({ mcpServers: { remote: { ...service.config, enabled: false } } }));
    expect((await run("run", "task-collector")).stdout).toContain("Dummy erfolgreich");
    expect(await readdir(configDirectory)).toEqual(["config.json"]);
  });

  it("handles SIGTERM during initialization and stops its stdio subprocess", async () => {
    const pidFile = join(home, "pid");
    await writeFile(join(configDirectory, "config.json"), JSON.stringify({ mcpServers: { silent: {
      transport: "stdio", command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdin.resume();`],
    } } }));
    const child = spawn(process.execPath, ["--import", "tsx", cliPath, "run", "task-collector"], { env: env(), stdio: "ignore" });
    const finished = new Promise<number | null>((resolve) => child.once("exit", resolve));
    try {
      await vi.waitFor(async () => expect(Number(await readFile(pidFile, "utf8"))).toBeGreaterThan(0), { timeout: 3000 });
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      try { expect(await finished).toBe(143); }
      finally { clearTimeout(timer); }
      const pid = Number(await readFile(pidFile, "utf8"));
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    } finally {
      child.kill("SIGKILL");
      await finished;
    }
  });
});
