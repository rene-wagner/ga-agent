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
