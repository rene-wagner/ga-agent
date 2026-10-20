import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent, type AgentContext, type AgentDefinition } from "../src/agents/runtime.js";
import { createAgentSupport } from "../src/agents/tools.js";
import { resolveMcpEnvironment, type Config, type McpServerConfig } from "../src/config.js";
import { validateToolNames, withMcpTools } from "../src/mcp/index.js";
import { startMcpHttp } from "./helpers/mcp-http.js";
import { ScriptedModel } from "./helpers/model.js";

const fixture = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
const local: Extract<McpServerConfig, { transport: "stdio" }> = { enabled: true, transport: "stdio", command: process.execPath, args: [fixture] };

const modelAgent: AgentDefinition = {
  name: "model-agent",
  graph: {
    async invoke(_input, { context, signal }) {
      return { message: (await context.model.invoke("Hello", { signal })).text };
    },
  },
};

describe("MCP tools", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ga-agent-mcp-"));
    vi.stubEnv("LANGSMITH_TRACING", "false");
    vi.stubEnv("LANGCHAIN_TRACING_V2", "false");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  function servers(): Config["mcpServers"] {
    return { service: { ...local, env: { TEST_PID_FILE: join(directory, "pid"), TEST_MCP_VALUE: "${GA_MCP_TEST}" } } };
  }

  async function expectStopped() {
    const pid = Number(await readFile(join(directory, "pid"), "utf8"));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  }

  it("provides no tools or side effects without enabled servers", async () => {
    await withMcpTools({ disabled: { ...local, enabled: false, env: { TOKEN: "${MISSING_DISABLED_TOKEN}" } } }, {}, async (tools) => {
      expect(tools).toEqual([]);
    });
  });

  it("loads and invokes namespaced stdio tools, then stops the child", async () => {
    vi.stubEnv("GA_MCP_TEST", "resolved");
    await withMcpTools(servers(), {}, async (tools) => {
      expect(tools.map((tool) => tool.name)).toEqual(["mcp__service_echo", "mcp__service_wait"]);
      expect(JSON.stringify(await tools[0].invoke({ text: "hello" }))).toContain("resolved:hello:");
      await expect(tools[0].invoke({})).rejects.toThrow();
    });
    await expectStopped();
  });

  it("loads HTTP tools with explicit environment-derived bearer headers", async () => {
    const service = await startMcpHttp({ oauth: false, header: "Bearer test-secret" });
    vi.stubEnv("GA_MCP_TEST", "test-secret");
    try {
      await withMcpTools({ service: { ...service.config, headers: { Authorization: "Bearer ${GA_MCP_TEST}" } } }, {}, async (tools) => {
        expect(JSON.stringify(await tools[0].invoke({ text: "http" }))).toContain("http");
      });
      expect(service.counts.calls).toBe(1);
    } finally { await service.close(); }
  });

  it("bounds tool execution and prevents reuse of tools after session cleanup", async () => {
    vi.stubEnv("GA_MCP_TEST", "resolved");
    const saved = await withMcpTools(servers(), { timeoutMs: 1000 }, async (tools) => {
      await expect(tools[1].invoke({})).rejects.toThrow("Tool-Aufruf fehlgeschlagen");
      return tools[0];
    });
    await expectStopped();
    await expect(saved.invoke({ text: "too late" })).rejects.toThrow("Tool-Aufruf fehlgeschlagen");
  });

  it("cleans up when the agent throws and preserves the original error", async () => {
    vi.stubEnv("GA_MCP_TEST", "resolved");
    await expect(withMcpTools(servers(), {}, async () => { throw new Error("agent failure"); })).rejects.toThrow("agent failure");
    await expectStopped();
  });

  it("closes already connected servers if a subsequent server fails", async () => {
    vi.stubEnv("GA_MCP_TEST", "resolved");
    const run = vi.fn();
    await expect(withMcpTools({ ...servers(), broken: { ...local, command: "/missing/SECRET" } }, {}, run)).rejects.toThrow('MCP-Server "broken"');
    expect(run).not.toHaveBeenCalled();
    await expectStopped();
  });

  it("bounds initialization of a nonresponsive server and kills it", async () => {
    const marker = join(directory, "pid");
    const silent: McpServerConfig = {
      enabled: true, transport: "stdio", command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.stdin.resume();`],
    };
    await expect(withMcpTools({ silent }, { timeoutMs: 200 }, vi.fn())).rejects.toThrow('MCP-Server "silent"');
    await expectStopped();
  });

  it("cancels tool calls and closes the process on abort", async () => {
    vi.stubEnv("GA_MCP_TEST", "resolved");
    const controller = new AbortController();
    await withMcpTools(servers(), { signal: controller.signal }, async (tools) => {
      const pending = tools[1].invoke({});
      controller.abort();
      await expect(pending).rejects.toThrow("Tool-Aufruf fehlgeschlagen");
    });
    await expectStopped();
  });

  it("rejects duplicate or overlong final tool names", async () => {
    await withMcpTools({ service: local }, {}, async (tools) => {
      expect(() => validateToolNames([tools[0], tools[0]])).toThrow("doppelte");
      tools[0].name = "a".repeat(65);
      expect(() => validateToolNames(tools)).toThrow("64");
    });
  });

  it("provides MCP and skill tools to different agents through the shared context", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const skillPath = join(directory, "skills", "tasks");
    await mkdir(skillPath, { recursive: true });
    await writeFile(join(skillPath, "SKILL.md"), "---\nname: tasks\ndescription: Collect tasks.\n---\nCollect tasks.");
    for (const name of ["first", "second"]) {
      const invoke = vi.fn(async (input: Record<string, never>, { context }: { context: AgentContext }) => {
        expect(input).toEqual({});
        const { prompt, tools } = createAgentSupport(context);
        expect(prompt).toContain("tasks");
        expect(tools.map((tool) => tool.name)).toEqual(["load_skill", "read_skill_file", "mcp__service_echo", "mcp__service_wait"]);
        expect(JSON.stringify(await tools[2].invoke({ text: name }))).toContain(name);
        return { message: name };
      });
      expect(await runAgent({ name, graph: { invoke } }, { skillsPath: join(directory, "skills"), mcpServers: { service: local }, model: new ScriptedModel() })).toEqual({ message: name });
      expect(invoke).toHaveBeenCalledOnce();
    }
  });

  it("closes MCP processes when model generation fails", async () => {
    vi.stubEnv("GA_MCP_TEST", "resolved");
    const model = new ScriptedModel();
    vi.spyOn(model, "_generate").mockRejectedValue(new Error("model failure"));
    await expect(runAgent(modelAgent, {
      skillsPath: join(directory, "missing"), mcpServers: servers(), model,
    })).rejects.toThrow("model failure");
    await expectStopped();
    expect(model.requests).toHaveLength(0);
  });

  it("closes MCP processes when the total model run times out", async () => {
    vi.stubEnv("GA_MCP_TEST", "resolved");
    const model = new ScriptedModel();
    vi.spyOn(model, "_generate").mockImplementation((_messages, options) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
    await expect(runAgent(modelAgent, {
      skillsPath: join(directory, "missing"), mcpServers: servers(), model, timeoutMs: 1000,
    })).rejects.toThrow("Zeitlimit für den Agent-Lauf");
    expect(model._generate).toHaveBeenCalledOnce();
    await expectStopped();
  });

  it("requires OAuth credentials rather than connecting anonymously", async () => {
    await expect(withMcpTools({ remote: { enabled: true, transport: "http", url: "https://example.invalid/mcp", auth: { type: "oauth" } } }, {}, vi.fn())).rejects.toThrow("ga-agent mcp login remote");
  });

  it("expands only explicit environment references without recursive expansion", () => {
    vi.stubEnv("GA_MCP_TEST", "${NOT_EXPANDED}");
    expect(resolveMcpEnvironment({ TOKEN: "Bearer ${GA_MCP_TEST}" }, "service")).toEqual({ TOKEN: "Bearer ${NOT_EXPANDED}" });
    expect(() => resolveMcpEnvironment({ TOKEN: "${MISSING_MCP_TEST_VARIABLE}" }, "service")).toThrow("MISSING_MCP_TEST_VARIABLE fehlt");
  });
});
