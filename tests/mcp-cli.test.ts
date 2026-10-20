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
const modelFixture = fileURLToPath(new URL("./fixtures/llm-fetch.mjs", import.meta.url));
const modelConfiguration = {
  models: { fast: { provider: "openrouter", model: "vendor/model-a" } },
  agents: { "task-collector": { model: "fast" } },
};

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
      OPENROUTER_API_KEY: "test-only", GA_TEST_LLM_MODE: "",
    };
  }
  function run(...args: string[]) {
    return execute(process.execPath, ["--import", "tsx", "--import", modelFixture, cliPath, ...args], { env: env(), timeout: 10_000 });
  }
  async function configure() {
    await writeFile(join(configDirectory, "config.json"), JSON.stringify({ ...modelConfiguration, mcpServers: { remote: service.config } }));
  }

  it("supports login/logout independently of the plain LLM agent", async () => {
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
    for (const result of results) expect(result.stdout).toBe("Aufgaben gesammelt mit vendor/model-a.\n");
    expect((await run("mcp", "logout", "remote")).stdout).toBe('MCP-Server "remote": abgemeldet.\n');
    expect(await readdir(join(configDirectory, "auth"))).toEqual([]);
    expect(service.counts).toMatchObject({ registration: 1, exchange: 1, refresh: 0, revocation: 1, calls: 0 });
    expect((await run("run", "task-collector")).stdout).toContain("Aufgaben gesammelt");
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
    await writeFile(join(configDirectory, "config.json"), JSON.stringify({ ...modelConfiguration, mcpServers: { remote: { ...service.config, enabled: false } } }));
    expect((await run("run", "task-collector")).stdout).toContain("Aufgaben gesammelt");
    expect(await readdir(configDirectory)).toEqual(["config.json"]);
  });

  it.each([["SIGINT", 130], ["SIGTERM", 143]] as const)("handles %s during a model request without starting MCP", async (signal, code) => {
    const pidFile = join(home, "pid");
    const marker = join(home, "model-started");
    const server = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
    await writeFile(join(configDirectory, "config.json"), JSON.stringify({
      ...modelConfiguration,
      mcpServers: { local: { transport: "stdio", command: process.execPath, args: [server], env: { TEST_PID_FILE: pidFile } } },
    }));
    const child = spawn(process.execPath, ["--import", "tsx", "--import", modelFixture, cliPath, "run", "task-collector"], {
      env: { ...env(), GA_TEST_LLM_MODE: "hang", GA_TEST_LLM_MARKER: marker }, stdio: "ignore",
    });
    const finished = new Promise<number | null>((resolve) => child.once("exit", resolve));
    try {
      await vi.waitFor(async () => expect(await readFile(marker, "utf8")).toBe("started"), { timeout: 3000 });
      child.kill(signal);
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      try { expect(await finished).toBe(code); }
      finally { clearTimeout(timer); }
      await expect(readFile(pidFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      child.kill("SIGKILL");
      await finished;
    }
  });

  it("does not start nonresponsive MCP servers for task-collector", async () => {
    const pidFile = join(home, "pid");
    await writeFile(join(configDirectory, "config.json"), JSON.stringify({ ...modelConfiguration, mcpServers: { silent: {
      transport: "stdio", command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdin.resume();`],
    } } }));
    expect((await run("run", "task-collector")).stdout).toContain("Aufgaben gesammelt");
    await expect(readFile(pidFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
