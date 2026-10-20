import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installExampleAgent } from "./helpers/agent.js";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const modelFixture = fileURLToPath(new URL("./fixtures/llm-fetch.mjs", import.meta.url));
const modelConfiguration = {
  models: { fast: { provider: "openrouter", model: "vendor/model-a" } },
};
const answer = "Aufgaben gesammelt mit vendor/model-a.\n";

describe("CLI", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ga-agent-cli-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function run(...args: string[]) { return runWithEnv(args); }

  function runWithEnv(args: string[], environment: NodeJS.ProcessEnv = {}) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--import", modelFixture, cliPath, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        LANGSMITH_TRACING: "false",
        LANGCHAIN_TRACING_V2: "false",
        OPENROUTER_API_KEY: "test-only",
        GA_TEST_LLM_MODE: "",
        ...environment,
      },
    });
    expect(result.error).toBeUndefined();
    return result;
  }

  async function writeConfig(content: string) {
    const directory = join(home, ".config", "ga-agent");
    await installExampleAgent(directory);
    await writeFile(join(directory, "config.json"), content);
  }

  async function writeAgent(settings: Parameters<typeof installExampleAgent>[1] = {}) {
    await installExampleAgent(join(home, ".config", "ga-agent"), settings);
  }

  it("shows help without reading invalid configuration", async () => {
    await writeConfig("{");
    const result = run("--help");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("list");
    expect(result.stdout).toContain("run");
    expect(result.stderr).toBe("");
  });

  it("lists no agents without creating user files", async () => {
    const result = run("list");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(await readdir(home)).toEqual([]);
  });

  it("has no built-in agent and does not create user files", async () => {
    const result = run("run", "task-collector");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unbekannter Agent: task-collector");
    expect(await readdir(home)).toEqual([]);
  });

  it("lists installed agents without model profiles but requires a profile for run", async () => {
    await writeAgent();
    expect(runWithEnv(["list"], { OPENROUTER_API_KEY: "" }).stdout).toBe("task-collector\taktiviert\n");
    const result = run("run", "task-collector");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("models.fast");
    expect(result.stderr).toContain("task-collector.md");
    expect(await readdir(join(home, ".config", "ga-agent"))).toEqual(["agents"]);
  });

  it("selects the agent's named model and applies configuration changes without a build", async () => {
    const models = {
      fast: { provider: "openrouter", model: "vendor/model-a" },
      thorough: { provider: "openrouter", model: "vendor/model-b" },
    };
    for (const [model, id] of [["fast", "vendor/model-a"], ["thorough", "vendor/model-b"]]) {
      await writeConfig(JSON.stringify({ models }));
      await writeAgent({ model });
      const result = run("run", "task-collector");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`Aufgaben gesammelt mit ${id}.\n`);
      expect(result.stderr).toBe("");
    }
  });

  it("requires a nonempty API key only for run, not list or help", async () => {
    await writeConfig(JSON.stringify(modelConfiguration));
    const result = runWithEnv(["run", "task-collector"], { OPENROUTER_API_KEY: "" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OPENROUTER_API_KEY fehlt oder ist leer");
    for (const args of [["list"], ["--help"], ["run", "--help"]]) {
      expect(runWithEnv(args, { OPENROUTER_API_KEY: "" }).status).toBe(0);
    }
  });

  it("loads the OpenRouter key from the configured .env and preserves an empty process value", async () => {
    await writeConfig(JSON.stringify(modelConfiguration));
    await writeFile(join(home, ".config", "ga-agent", ".env"), "OPENROUTER_API_KEY=from-file\n");
    const loaded = runWithEnv(["run", "task-collector"], { OPENROUTER_API_KEY: undefined });
    expect(loaded.status).toBe(0);
    expect(loaded.stdout).toBe(answer);
    const empty = runWithEnv(["run", "task-collector"], { OPENROUTER_API_KEY: "" });
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("OPENROUTER_API_KEY fehlt oder ist leer");
  });

  it("does not expose provider errors or secrets in CLI output", async () => {
    await writeConfig(JSON.stringify(modelConfiguration));
    const result = runWithEnv(["run", "task-collector"], { GA_TEST_LLM_MODE: "error" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("API-Key ungültig");
    expect(result.stderr).not.toContain("SECRET");
    expect(result.stderr).not.toContain("test-only");
    expect(result.stdout).toBe("");
  });

  it("activates a skill from the user configuration directory", async () => {
    await writeConfig(JSON.stringify(modelConfiguration));
    const path = join(home, ".config", "ga-agent", "skills", "tasks");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), "---\nname: tasks\ndescription: Collect tasks.\n---\nCollect tasks from notes.");

    const defaultRun = run("run", "task-collector");
    expect(defaultRun.status).toBe(0);
    expect(defaultRun.stdout).toBe(answer);
    expect(defaultRun.stderr).toBe("");

    const result = run("run", "task-collector", "--skill", "tasks");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(answer);
    expect(result.stderr).toBe("");
  });

  it.each(["unknown", "__proto__"])("rejects an unknown requested skill %s", async (name) => {
    await writeConfig(JSON.stringify(modelConfiguration));
    const result = run("run", "task-collector", "--skill", name);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Unbekannter oder ungültiger Skill: ${name}`);
  });

  it("warns about invalid skills and fails when one is explicitly requested", async () => {
    await writeConfig(JSON.stringify(modelConfiguration));
    const path = join(home, ".config", "ga-agent", "skills", "broken");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), "invalid");
    const defaultRun = run("run", "task-collector");
    expect(defaultRun.status).toBe(0);
    expect(defaultRun.stderr).toContain(`Warnung: Ungültiger Skill in ${join(path, "SKILL.md")}`);

    const result = run("run", "task-collector", "--skill", "broken");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unbekannter oder ungültiger Skill: broken");
  });

  it.each([["list"], ["--help"], ["run", "--help"]])("does not discover skills for %j", async (...args) => {
    const directory = join(home, ".config", "ga-agent");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "skills"), "not a directory");
    const result = run(...args);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("reports skill root read failures when running an enabled agent", async () => {
    const directory = join(home, ".config", "ga-agent");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "skills");
    await writeFile(path, "not a directory");
    await writeConfig(JSON.stringify(modelConfiguration));
    const result = run("run", "task-collector");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Skills in ${path} konnten nicht geladen werden.`);
  });

  it("checks agent activation before discovering skills", async () => {
    await writeAgent({ enabled: false });
    await writeFile(join(home, ".config", "ga-agent", "skills"), "not a directory");
    const result = run("run", "task-collector", "--skill", "tasks");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Agent "task-collector" ist deaktiviert.');
    expect(result.stderr).not.toContain("Skills in");
  });

  it("requires a value for --skill", () => {
    const result = run("run", "task-collector", "--skill");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("argument missing");
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
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--import", modelFixture, scriptPath], {
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
    expect(result.status).toBe(args[0] === "list" ? 0 : 1);
    expect(result.stdout).toBe("");
    if (args[0] === "list") expect(result.stderr).toBe("");
    else expect(result.stderr).toContain("Unbekannter Agent: task-collector");
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
    await writeAgent({ enabled: false });
    const result = run("list");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("task-collector\tdeaktiviert\n");
  });

  it("does not run disabled agents", async () => {
    await writeAgent({ enabled: false });
    const result = run("run", "task-collector");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('Agent "task-collector" ist deaktiviert.');
  });

  it.each(["unknown-agent", "__proto__"])("rejects unknown agent %s", async (name) => {
    await writeAgent();
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

  it("discovers a new Markdown agent and rereads its prompt without a build", async () => {
    await writeConfig(JSON.stringify(modelConfiguration));
    const path = join(home, ".config", "ga-agent", "agents", "new-agent.md");
    for (const prompt of ["Erste Aufgabe.", "Geänderte Aufgabe."]) {
      await writeFile(path, `---\nmodel: fast\nmcp: false\n---\n${prompt}\n`);
      const listed = run("list");
      expect(listed.status).toBe(0);
      expect(listed.stdout).toBe("new-agent\taktiviert\ntask-collector\taktiviert\n");
      const result = runWithEnv(["run", "new-agent"], { GA_TEST_LLM_MODE: "prompt" });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${prompt}\n`);
      expect(result.stderr).toBe("");
    }
  });

  it.each(["missing", "constructor", "toString"])("rejects unknown profile %s before starting MCP or the model", async (model) => {
    const marker = join(home, "must-not-start");
    await writeConfig(JSON.stringify({ mcpServers: { local: {
      transport: "stdio", command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
    } } }));
    await writeAgent({ model, mcp: true });
    const result = runWithEnv(["run", "task-collector"], { GA_TEST_LLM_MARKER: marker });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Unbekannte Modellkonfiguration "${model}"`);
    expect(result.stderr).toContain("task-collector.md");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails on invalid Markdown for list and run without invoking a model", async () => {
    await writeConfig(JSON.stringify(modelConfiguration));
    const path = join(home, ".config", "ga-agent", "agents", "broken.md");
    await writeFile(path, "invalid");
    const marker = join(home, "must-not-start");
    for (const args of [["list"], ["run", "task-collector"]]) {
      const result = runWithEnv(args, { GA_TEST_LLM_MARKER: marker });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(path);
    }
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not read invalid Markdown for help", async () => {
    await writeAgent();
    await writeFile(join(home, ".config", "ga-agent", "agents", "broken.md"), "invalid");
    for (const args of [["--help"], ["list", "--help"], ["run", "--help"], ["mcp", "login", "--help"]]) {
      const result = run(...args);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    }
  });

  it("reports legacy agent configuration with a migration hint", async () => {
    await writeConfig(JSON.stringify({ agents: { "task-collector": { model: "fast" } } }));
    const result = run("list");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("agents/<name>.md");
    expect(result.stderr).toContain('Abschnitt "agents" aus config.json entfernen');
  });

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
