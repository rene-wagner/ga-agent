import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, loadEnv } from "../src/config.js";

describe("loadEnv", () => {
  const key = "GA_AGENT_DOTENV_TEST";
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ga-agent-env-"));
    path = join(directory, "ga-agent", ".env");
    vi.stubEnv(key, undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  async function writeEnv(content: string) {
    await mkdir(join(directory, "ga-agent"), { recursive: true });
    await writeFile(path, content);
  }

  it("ignores a missing directory without creating user files", async () => {
    expect(() => loadEnv(path)).not.toThrow();
    expect(process.env[key]).toBeUndefined();
    await expect(access(join(directory, "ga-agent"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("ignores a missing file in an existing directory", async () => {
    await mkdir(join(directory, "ga-agent"));
    expect(() => loadEnv(path)).not.toThrow();
    expect(process.env[key]).toBeUndefined();
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    [`${key}=value\n`, "value"],
    [`# comment\n${key}=value # inline comment\n`, "value"],
    [`${key}="value with spaces # quoted"\n`, "value with spaces # quoted"],
    [`${key}='single quoted value'\n`, "single quoted value"],
    [`${key}=\n`, ""],
  ])("loads dotenv syntax: %s", async (content, expected) => {
    await writeEnv(content);
    loadEnv(path);
    expect(process.env[key]).toBe(expected);
    await expect(access(join(directory, "ga-agent", "config.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["existing", ""])("preserves an existing environment value: %j", async (value) => {
    vi.stubEnv(key, value);
    await writeEnv(`${key}=from-file\n`);
    loadEnv(path);
    expect(process.env[key]).toBe(value);
  });

  it("reports read failures without changing the environment", async () => {
    await mkdir(path, { recursive: true });
    expect(() => loadEnv(path)).toThrow(
      `Umgebungsvariablen aus ${path} konnten nicht geladen werden.`,
    );
    expect(process.env[key]).toBeUndefined();
  });
});

describe("loadConfig", () => {
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ga-agent-config-"));
    path = join(directory, "ga-agent", "config.json");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function writeConfig(content: string) {
    await mkdir(join(directory, "ga-agent"), { recursive: true });
    await writeFile(path, content);
  }

  it("uses defaults without creating a configuration directory", async () => {
    expect(await loadConfig(path)).toEqual({
      agents: { "task-collector": { enabled: true } },
    });
    await expect(access(join(directory, "ga-agent"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    {},
    { agents: {} },
    { agents: { "task-collector": {} } },
  ])("fills in omitted settings for %j", async (config) => {
    await writeConfig(JSON.stringify(config));
    expect(await loadConfig(path)).toEqual({
      agents: { "task-collector": { enabled: true } },
    });
  });

  it("reads an explicitly disabled agent", async () => {
    await writeConfig('{"agents":{"task-collector":{"enabled":false}}}');
    expect((await loadConfig(path)).agents["task-collector"].enabled).toBe(false);
  });

  it.each([
    "{",
    "null",
    "[]",
    '{"agents":null}',
    '{"agents":{"task-collector":{"enabled":"false"}}}',
    '{"agents":{"task-collector":{"enabled":null}}}',
    '{"agents":{"unknown-agent":{"enabled":true}}}',
    '{"unexpected":true}',
  ])("rejects invalid configuration: %s", async (content) => {
    await writeConfig(content);
    await expect(loadConfig(path)).rejects.toThrow(
      `Ungültige Konfiguration in ${path}`,
    );
  });

  it("reports read failures instead of silently using defaults", async () => {
    await mkdir(path, { recursive: true });
    await expect(loadConfig(path)).rejects.toThrow(
      `Konfiguration in ${path} konnte nicht gelesen werden.`,
    );
  });
});
