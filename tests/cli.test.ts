import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("CLI", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ga-agent-cli-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function run(...args: string[]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        LANGSMITH_TRACING: "false",
        LANGCHAIN_TRACING_V2: "false",
      },
    });
    expect(result.error).toBeUndefined();
    return result;
  }

  async function writeConfig(content: string) {
    const directory = join(home, ".config", "ga-agent");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "config.json"), content);
  }

  it("shows help without reading invalid configuration", async () => {
    await writeConfig("{");
    const result = run("--help");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("list");
    expect(result.stdout).toContain("run");
    expect(result.stderr).toBe("");
  });

  it("lists the default agent without creating user files", async () => {
    const result = run("list");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("task-collector\taktiviert\n");
    expect(result.stderr).toBe("");
    expect(await readdir(home)).toEqual([]);
  });

  it("runs the dummy agent without configuration or API keys", async () => {
    const result = run("run", "task-collector");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("task-collector: Dummy erfolgreich ausgeführt.\n");
    expect(result.stderr).toBe("");
    expect(await readdir(home)).toEqual([]);
  });

  it.each([
    ["list"],
    ["run", "task-collector"],
  ])("loads the configuration .env for %s without config.json", async (...args) => {
    const directory = join(home, ".config", "ga-agent");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, ".env"), "GA_AGENT_DOTENV_TEST=from-file\nLANGSMITH_TRACING=true\n");
    await writeFile(join(home, ".env"), "GA_AGENT_CWD_ENV_TEST=must-not-load\n");

    const script = `
      import { strict as assert } from "node:assert";
      process.argv = ${JSON.stringify([process.execPath, cliPath, ...args])};
      await import(${JSON.stringify(cliPath)});
      assert.equal(process.env.GA_AGENT_DOTENV_TEST, "from-file");
      assert.equal(process.env.GA_AGENT_CWD_ENV_TEST, undefined);
      assert.equal(process.env.LANGSMITH_TRACING, "false");
    `;
    const scriptPath = join(home, "check-env.mjs");
    await writeFile(scriptPath, script);
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), scriptPath], {
      encoding: "utf8",
      timeout: 10_000,
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        GA_AGENT_DOTENV_TEST: undefined,
        GA_AGENT_CWD_ENV_TEST: undefined,
        LANGSMITH_TRACING: "false",
        LANGCHAIN_TRACING_V2: "false",
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(args[0] === "list"
      ? "task-collector\taktiviert\n"
      : "task-collector: Dummy erfolgreich ausgeführt.\n");
  });

  it.each([
    ["list"],
    ["run", "task-collector"],
  ])("reports .env read failures for %s", async (...args) => {
    const path = join(home, ".config", "ga-agent", ".env");
    await mkdir(path, { recursive: true });
    const result = run(...args);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Umgebungsvariablen aus ${path} konnten nicht geladen werden.`);
  });

  it.each([
    ["--help"],
    ["list", "--help"],
    ["run", "--help"],
  ])("shows help without reading an unreadable .env: %j", async (...args) => {
    await mkdir(join(home, ".config", "ga-agent", ".env"), { recursive: true });
    const result = run(...args);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stderr).toBe("");
  });

  it("lists disabled agents", async () => {
    await writeConfig('{"agents":{"task-collector":{"enabled":false}}}');
    const result = run("list");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("task-collector\tdeaktiviert\n");
  });

  it("does not run disabled agents", async () => {
    await writeConfig('{"agents":{"task-collector":{"enabled":false}}}');
    const result = run("run", "task-collector");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('Agent "task-collector" ist deaktiviert.');
  });

  it.each(["unknown-agent", "__proto__"])("rejects unknown agent %s", (name) => {
    const result = run("run", name);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Unbekannter Agent: ${name}`);
    expect(result.stderr).toContain("Verfügbare Agents: task-collector");
  });

  it.each(["{", '{"agents":{"task-collector":{"enabled":"false"}}}'])(
    "reports invalid user configuration: %s",
    async (content) => {
      await writeConfig(content);
      const result = run("run", "task-collector");

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Ungültige Konfiguration");
      expect(result.stderr).toContain(join(home, ".config", "ga-agent", "config.json"));
    },
  );

  it("rejects unknown commands", () => {
    const result = run("unknown-command");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown command");
  });

  it("requires an agent name", () => {
    const result = run("run");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing required argument");
  });
});
