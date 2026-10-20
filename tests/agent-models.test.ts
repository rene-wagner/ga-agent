import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentGraph } from "../src/agents/graph.js";
import { loadAgents } from "../src/agents/index.js";
import { runAgent } from "../src/agents/runtime.js";
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

  it("runs Markdown agents concurrently with independent profiles and prompts", async () => {
    const settings = [
      { name: "task-collector", model: "fast", prompt: "Sammle Aufgaben." },
      { name: "another-agent", model: "thorough", prompt: "Analysiere ausführlich." },
      { name: "shared-profile-agent", model: "fast", prompt: "Fasse kurz zusammen." },
    ];
    await Promise.all(settings.map((agent) => writeFile(join(directory, `${agent.name}.md`),
      `---\nmodel: ${agent.model}\nmcp: false\n---\n${agent.prompt}\n`)));
    const agents = await loadAgents(directory);
    const results = await Promise.all(agents.map((agent) => runAgent({
      ...agent, graph: createAgentGraph(agent.instructions),
    }, { skillsPath: join(directory, "skills"), modelConfig: profiles[agent.model] })));
    expect(results).toEqual(agents.map((agent) => ({ message: profiles[agent.model].model })));
    const bodies = vi.mocked(fetch).mock.calls.map((call) => JSON.parse(call[1]!.body as string));
    expect(bodies.map((body) => body.max_tokens).sort()).toEqual([2048, 2048, 4096]);
    for (const agent of settings) {
      expect(bodies).toContainEqual(expect.objectContaining({
        model: profiles[agent.model].model,
        messages: [
          { role: "system", content: agent.prompt },
          { role: "user", content: "Führe die beschriebenen Anweisungen aus." },
        ],
      }));
    }
    expect(JSON.stringify(bodies)).not.toContain("test-only");
  });

  it.each([false, true])("rejects missing model settings/key before starting MCP (profile=%s)", async (withProfile) => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const invoke = vi.fn();
    await expect(runAgent({ name: "test", graph: { invoke } }, {
      skillsPath: directory,
      modelConfig: withProfile ? profiles.fast : undefined,
      mcpServers: { local: { enabled: true, transport: "stdio", command: "/must-not-start", args: [] } },
    })).rejects.toThrow(withProfile ? "OPENROUTER_API_KEY fehlt oder ist leer" : "agents/test.md");
    expect(invoke).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
