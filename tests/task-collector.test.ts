import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskCollector } from "../src/agents/task-collector.js";

describe("task-collector", () => {
  beforeEach(() => {
    vi.stubEnv("LANGSMITH_TRACING", "false");
    vi.stubEnv("LANGCHAIN_TRACING_V2", "false");
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("Network access is not allowed in dummy-agent tests");
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("runs without input or network access", async () => {
    expect(await taskCollector.invoke({})).toEqual({
      message: "task-collector: Dummy erfolgreich ausgeführt.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("replaces the input message with the dummy result", async () => {
    expect(await taskCollector.invoke({ message: "Vorheriger Zustand" })).toEqual({
      message: "task-collector: Dummy erfolgreich ausgeführt.",
    });
  });

  it("contains exactly the START → dummy → END workflow", async () => {
    const graph = await taskCollector.getGraphAsync();

    expect(Object.keys(graph.nodes).sort()).toEqual([
      "__end__", "__start__", "dummy",
    ]);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "__start__", target: "dummy" }),
      expect.objectContaining({ source: "dummy", target: "__end__" }),
    ]));
  });
});
