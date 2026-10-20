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
      models: {},
      mcpServers: {},
    });
    await expect(access(join(directory, "ga-agent"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    {},
    { models: {} },
    { mcpServers: {} },
  ])("fills in omitted settings for %j", async (config) => {
    await writeConfig(JSON.stringify(config));
    expect(await loadConfig(path)).toEqual({
      models: {},
      mcpServers: {},
    });
  });

  it.each([{}, { "task-collector": { enabled: false, model: "fast" } }])("rejects legacy agent settings with a migration hint: %j", async (agents) => {
    await writeConfig(JSON.stringify({ agents }));
    await expect(loadConfig(path)).rejects.toThrow('Agent-Einstellungen nach agents/<name>.md verschieben und den Abschnitt "agents" aus config.json entfernen');
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

  it("loads shared named models", async () => {
    await writeConfig(JSON.stringify({
      models: {
        fast: { provider: "openrouter", model: "vendor/model-a" },
        thorough: { provider: "openrouter", model: "vendor/model-b", maxOutputTokens: 4096, temperature: 0.5 },
      },
    }));
    const config = await loadConfig(path);
    expect(config.models.fast).toEqual({ provider: "openrouter", model: "vendor/model-a", maxOutputTokens: 2048 });
    expect(config.models.thorough).toEqual({ provider: "openrouter", model: "vendor/model-b", maxOutputTokens: 4096, temperature: 0.5 });
  });

  it.each([
    { provider: "unknown", model: "model" },
    { provider: "openrouter", model: " " },
    { provider: "openrouter", model: "model", maxOutputTokens: 0 },
    { provider: "openrouter", model: "model", maxOutputTokens: 1.5 },
    { provider: "openrouter", model: "model", temperature: 3 },
    { provider: "openrouter", model: "model", apiKey: "SECRET" },
    { provider: "openrouter", model: "model", baseURL: "https://SECRET.invalid" },
  ])("rejects invalid model settings without leaking values: %j", async (model) => {
    await writeConfig(JSON.stringify({ models: { test: model } }));
    const error = await loadConfig(path).catch((error: Error) => error);
    expect(String(error)).toContain("models.test");
    expect(String(error)).not.toContain("SECRET");
  });

  it("loads global MCP servers and transport defaults", async () => {
    await writeConfig(JSON.stringify({ mcpServers: {
      local: { transport: "stdio", command: "node", env: { TOKEN: "${TOKEN}" } },
      remote: { transport: "http", url: "https://example.com/mcp", auth: { type: "oauth", clientId: "client", scopes: ["read"], redirectPort: 8090 } },
      disabled: { enabled: false, transport: "stdio", command: "missing" },
    } }));
    const { mcpServers } = await loadConfig(path);
    expect(mcpServers.local).toMatchObject({ enabled: true, args: [], env: { TOKEN: "${TOKEN}" } });
    expect(mcpServers.remote).toMatchObject({ enabled: true, auth: { type: "oauth", clientId: "client" } });
    expect(mcpServers.disabled.enabled).toBe(false);
  });

  it.each([
    { transport: "stdio", command: "node", url: "https://example.com" },
    { transport: "http", url: "file:///secret" },
    { transport: "http", url: "https://user:SECRET@example.com" },
    { transport: "http", url: "https://example.com", command: "node" },
    { transport: "http", url: "https://example.com", auth: { type: "oauth", redirectPort: 0 } },
    { transport: "http", url: "https://example.com", auth: { type: "oauth" }, headers: { aUtHoRiZaTiOn: "SECRET" } },
    { transport: "http", url: "https://example.com", auth: { type: "oauth", scopes: ["bad scope"] } },
    { transport: "stdio", command: "node", auth: { type: "oauth" } },
  ])("rejects invalid MCP configuration without exposing secrets: %j", async (server) => {
    await writeConfig(JSON.stringify({ mcpServers: { service: server } }));
    const error = await loadConfig(path).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("Ungültige Konfiguration");
    expect(String(error)).not.toContain("SECRET");
  });

  it("rejects invalid server names", async () => {
    await writeConfig(JSON.stringify({ mcpServers: { "../bad": { transport: "stdio", command: "node" } } }));
    await expect(loadConfig(path)).rejects.toThrow("Ungültige Konfiguration");
  });

  it("reports read failures instead of silently using defaults", async () => {
    await mkdir(path, { recursive: true });
    await expect(loadConfig(path)).rejects.toThrow(
      `Konfiguration in ${path} konnte nicht gelesen werden.`,
    );
  });
});
