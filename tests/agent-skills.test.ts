import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent, type AgentContext } from "../src/agents/runtime.js";
import { loadExampleAgent } from "./helpers/agent.js";
import { discoverSkills } from "../src/skills/index.js";
import { createSkillSupport } from "../src/skills/tools.js";
import { ScriptedModel } from "./helpers/model.js";

const { graph: taskCollector } = await loadExampleAgent();

describe("agent skill support", () => {
  let directory: string;
  let root: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ga-agent-runtime-"));
    root = join(directory, "skills");
    vi.stubEnv("LANGSMITH_TRACING", "false");
    vi.stubEnv("LANGCHAIN_TRACING_V2", "false");
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("Network access is not allowed in skill tests");
    }));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });

  async function installSkill() {
    const path = join(root, "tasks");
    await mkdir(join(path, "references"), { recursive: true });
    await writeFile(join(path, "SKILL.md"), "---\nname: tasks\ndescription: Collect tasks from notes.\nallowed-tools: Bash(*)\n---\nSECRET INSTRUCTIONS: Read references/example.md.\n");
    await writeFile(join(path, "references", "example.md"), "SECRET REFERENCE");
    return path;
  }

  it("provides no catalog or tools without skills", async () => {
    const support = createSkillSupport(await discoverSkills(root));
    expect(support).toEqual({ prompt: "", tools: [] });
  });

  it("exposes only metadata until a skill or reference is requested", async () => {
    await installSkill();
    const skills = await discoverSkills(root);
    const load = vi.spyOn(skills, "load");
    const readFile = vi.spyOn(skills, "readFile");
    const support = createSkillSupport(skills);

    expect(support.prompt).toContain("tasks");
    expect(support.prompt).toContain("Collect tasks from notes.");
    expect(support.prompt).not.toContain("SECRET");
    expect(support.prompt).not.toContain("Bash(*)");
    expect(load).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(support.tools.map((tool) => tool.name)).toEqual(["load_skill", "read_skill_file"]);

    const loaded = JSON.parse(await support.tools[0].invoke({ name: "tasks" }));
    expect(loaded.instructions).toContain("SECRET INSTRUCTIONS");
    expect(loaded.directory).toBe(join(root, "tasks"));
    expect(load).toHaveBeenCalledExactlyOnceWith("tasks");
    expect(readFile).not.toHaveBeenCalled();
    expect(await support.tools[1].invoke({ name: "tasks", path: "references/example.md" })).toBe("SECRET REFERENCE");
    expect(readFile).toHaveBeenCalledExactlyOnceWith("tasks", "references/example.md");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("includes explicitly activated instructions in the shared prompt", async () => {
    await installSkill();
    const skills = await discoverSkills(root);
    const activeSkill = await skills.load("tasks");
    const support = createSkillSupport(skills, activeSkill);
    expect(support.prompt).toContain("SECRET INSTRUCTIONS");
    expect(support.prompt).not.toContain("SECRET REFERENCE");
  });

  it("validates tool inputs and keeps registry path restrictions", async () => {
    await installSkill();
    const support = createSkillSupport(await discoverSkills(root));
    await expect(support.tools[0].invoke({})).rejects.toThrow();
    await expect(support.tools[0].invoke({ name: "unknown" })).rejects.toThrow("Unbekannter oder ungültiger Skill");
    await expect(support.tools[1].invoke({ name: "tasks", path: "../../secret.md" })).rejects.toThrow("außerhalb");
  });

  it("does not include installed skills in the simplified task-collector prompt", async () => {
    await installSkill();
    const model = new ScriptedModel();
    expect(await runAgent({ name: "task-collector", graph: taskCollector }, { skillsPath: root, model })).toEqual({
      message: "Aufgaben gesammelt.",
    });
    const prompt = JSON.stringify(model.requests[0].messages);
    expect(prompt).not.toContain("Collect tasks from notes.");
    expect(prompt).not.toContain("SECRET INSTRUCTIONS");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not include activated skills or bind tools in the simplified task-collector", async () => {
    await installSkill();
    const model = new ScriptedModel();
    expect(await runAgent({ name: "task-collector", graph: taskCollector }, { skillsPath: root, skill: "tasks", model })).toEqual({
      message: "Aufgaben gesammelt.",
    });
    const messages = model.requests[0].messages;
    expect(messages[0].content).not.toContain("SECRET INSTRUCTIONS");
    expect(messages[1].content).not.toContain("SECRET INSTRUCTIONS");
    expect(model.requests[0].options.tools).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("provides the same skill context to another agent without changing graph input", async () => {
    await installSkill();
    const invoke = vi.fn(async (_input: Record<string, never>, { context }: { context: AgentContext }) => {
      expect(context.skills.list()).toEqual([{ name: "tasks", description: "Collect tasks from notes." }]);
      expect(context.activeSkill?.instructions).toContain("SECRET INSTRUCTIONS");
      const support = createSkillSupport(context.skills, context.activeSkill);
      expect(await support.tools[1].invoke({ name: "tasks", path: "references/example.md" })).toBe("SECRET REFERENCE");
      return { message: "Another agent used a skill." };
    });
    expect(await runAgent({ name: "another-agent", graph: { invoke } }, { skillsPath: root, skill: "tasks", model: new ScriptedModel() })).toEqual({
      message: "Another agent used a skill.",
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0][0]).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports invalid skills and keeps valid ones available", async () => {
    await installSkill();
    await mkdir(join(root, "broken"));
    await writeFile(join(root, "broken", "SKILL.md"), "broken");
    const onWarning = vi.fn();
    await runAgent({ name: "task-collector", graph: taskCollector }, { skillsPath: root, skill: "tasks", onWarning, model: new ScriptedModel() });
    expect(onWarning).toHaveBeenCalledOnce();
    expect(onWarning.mock.calls[0][0]).toContain(join(root, "broken", "SKILL.md"));
  });

  it("does not invoke an agent if the selected skill is unknown or invalid", async () => {
    const invoke = vi.fn();
    await expect(runAgent({ name: "test", graph: { invoke } }, { skillsPath: root, skill: "unknown" })).rejects.toThrow("Unbekannter oder ungültiger Skill");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not invoke an agent when skill discovery fails", async () => {
    await writeFile(root, "not a directory");
    const invoke = vi.fn();
    await expect(runAgent({ name: "test", graph: { invoke } }, { skillsPath: root })).rejects.toThrow("konnten nicht geladen werden");
    expect(invoke).not.toHaveBeenCalled();
  });
});
