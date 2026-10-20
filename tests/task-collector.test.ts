import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage } from "@langchain/core/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agents } from "../src/agents/index.js";
import { runAgent } from "../src/agents/runtime.js";
import { taskCollector } from "../src/agents/task-collector.js";
import { ScriptedModel } from "./helpers/model.js";

const agent = agents[0];

describe("task-collector", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ga-agent-llm-"));
    vi.stubEnv("LANGSMITH_TRACING", "false");
    vi.stubEnv("LANGCHAIN_TRACING_V2", "false");
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("External requests are forbidden"); }));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });

  it("returns a single model answer without binding tools or connecting configured MCP servers", async () => {
    const model = new ScriptedModel([new AIMessage("Die LLM-Anbindung funktioniert.")]);
    const bind = vi.spyOn(model, "bindTools");
    expect(await runAgent(agent, {
      skillsPath: directory, model,
      mcpServers: {
        local: { enabled: true, transport: "stdio", command: "/must-not-start", args: [], env: { TOKEN: "${MISSING_TOKEN}" } },
        remote: { enabled: true, transport: "http", url: "https://must-not-connect.invalid/mcp", auth: { type: "oauth" } },
      },
    })).toEqual({ message: "Die LLM-Anbindung funktioniert." });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0].messages.map((message) => message.type)).toEqual(["system", "human"]);
    expect(model.requests[0].messages[1].text).toContain("LLM-Anbindung funktioniert");
    expect(model.requests[0].options.tools).toBeUndefined();
    expect(bind).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [new AIMessage(""), "keine Textantwort"],
    [new AIMessage({ content: "", invalid_tool_calls: [{ name: "unknown", args: "{", error: "SECRET" }] }), "unerwartete Tool-Aufrufe"],
    [new AIMessage({ content: "partial", response_metadata: { finish_reason: "length" } }), "Ausgabe-Token-Limit"],
    [new AIMessage({ content: "", tool_calls: [{ name: "unknown", args: {}, id: "call", type: "tool_call" }] }), "unerwartete Tool-Aufrufe"],
  ])("rejects invalid output without a second model call", async (response, message) => {
    const model = new ScriptedModel([response]);
    await expect(runAgent(agent, { skillsPath: directory, model })).rejects.toThrow(message);
    expect(model.requests).toHaveLength(1);
  });

  it("supports models without tool binding", async () => {
    const model = new ScriptedModel();
    Object.defineProperty(model, "bindTools", { value: undefined });
    await expect(runAgent(agent, { skillsPath: directory, model })).resolves.toEqual({ message: "Aufgaben gesammelt." });
    expect(model.requests).toHaveLength(1);
  });

  it("propagates run cancellation to an in-flight model request", async () => {
    const model = new ScriptedModel();
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(model, "_generate").mockImplementation((_messages, options) => new Promise((_resolve, reject) => {
      requestSignal = options.signal;
      requestSignal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
    const controller = new AbortController();
    const pending = runAgent(agent, { skillsPath: directory, model, signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow("Ausführung abgebrochen");
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    controller.abort();
    await assertion;
    expect(requestSignal?.aborted).toBe(true);
  });

  it("enforces the total run deadline", async () => {
    const model = new ScriptedModel();
    vi.spyOn(model, "_generate").mockImplementation((_messages, options) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
    await expect(runAgent(agent, { skillsPath: directory, model, timeoutMs: 100 })).rejects.toThrow("Zeitlimit für den Agent-Lauf");
  });

  it("contains only START → model → END", async () => {
    const graph = await taskCollector.getGraphAsync();
    expect(Object.keys(graph.nodes).sort()).toEqual(["__end__", "__start__", "model"]);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "__start__", target: "model" }),
      expect.objectContaining({ source: "model", target: "__end__" }),
    ]));
  });
});
