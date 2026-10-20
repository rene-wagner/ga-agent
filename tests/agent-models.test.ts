import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agents/runtime.js";
import { taskCollector } from "../src/agents/task-collector.js";
import type { ModelConfig } from "../src/config.js";

const profiles: Record<string, ModelConfig> = {
  fast: { provider: "openrouter", model: "vendor/model-a", maxOutputTokens: 2048 },
  thorough: { provider: "openrouter", model: "vendor/model-b", maxOutputTokens: 4096 },
};

describe("per-agent models", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ga-agent-models-"));
    vi.stubEnv("OPENROUTER_API_KEY", "test-only");
    vi.stubEnv("LANGSMITH_TRACING", "false");
    vi.stubEnv("LANGCHAIN_TRACING_V2", "false");
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
      const { model } = JSON.parse(init.body);
      return Response.json({
        id: "test-completion", model,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: model } }],
      });
    }));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("runs different agents concurrently with independently selected profiles", async () => {
    // A second registered agent uses the same runtime/graph contract, not provider-specific code.
    const settings = [
      { name: "task-collector", model: "fast" },
      { name: "another-agent", model: "thorough" },
      { name: "shared-profile-agent", model: "fast" },
    ];
    const results = await Promise.all(settings.map((agent) => runAgent({
      name: agent.name, graph: taskCollector,
    }, { skillsPath: directory, modelConfig: profiles[agent.model] })));
    expect(results).toEqual([
      { message: "vendor/model-a" }, { message: "vendor/model-b" }, { message: "vendor/model-a" },
    ]);
    const bodies = vi.mocked(fetch).mock.calls.map((call) => JSON.parse(call[1]!.body as string));
    expect(bodies.map((body) => body.max_tokens).sort()).toEqual([2048, 2048, 4096]);
    expect(JSON.stringify(bodies)).not.toContain("test-only");
  });

  it.each([false, true])("rejects missing model settings/key before starting MCP (profile=%s)", async (withProfile) => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const invoke = vi.fn();
    await expect(runAgent({ name: "test", graph: { invoke } }, {
      skillsPath: directory,
      modelConfig: withProfile ? profiles.fast : undefined,
      mcpServers: { local: { enabled: true, transport: "stdio", command: "/must-not-start", args: [] } },
    })).rejects.toThrow(withProfile ? "OPENROUTER_API_KEY fehlt oder ist leer" : "agents.test.model");
    expect(invoke).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
