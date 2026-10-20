import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

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
