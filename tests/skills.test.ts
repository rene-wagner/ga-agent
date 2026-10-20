import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSkills } from "../src/skills/index.js";

describe("skills", () => {
  let directory: string;
  let root: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ga-agent-skills-"));
    root = join(directory, "skills");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function writeSkill(name: string, content = `---\nname: ${name}\ndescription: Use this skill for tasks.\n---\n# Instructions\nCollect tasks.\n`) {
    const path = join(root, name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), content);
    return path;
  }

  it("treats missing skills as empty without creating directories", async () => {
    const skills = await discoverSkills(root);
    expect(skills.list()).toEqual([]);
    expect(skills.warnings).toEqual([]);
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("discovers immediate skill directories in deterministic order", async () => {
    await writeSkill("zebra");
    await writeSkill("alpha");
    await mkdir(join(root, "empty"));
    await mkdir(join(root, "nested", "hidden"), { recursive: true });
    await writeFile(join(root, "nested", "hidden", "SKILL.md"), "not a direct skill");
    await writeFile(join(root, "README.md"), "not a skill");
    await writeFile(join(root, "empty", "skill.md"), "wrong casing");

    const skills = await discoverSkills(root);
    expect(skills.list()).toEqual([
      { name: "alpha", description: "Use this skill for tasks." },
      { name: "zebra", description: "Use this skill for tasks." },
    ]);
    expect(skills.warnings).toEqual([]);
  });

  it("loads optional standard metadata and preserves Markdown", async () => {
    const path = await writeSkill("tasks", "---\nname: tasks\ndescription: |\n  Collect tasks.\n  Use for notes.\nlicense: MIT\ncompatibility: Requires Node.js\nmetadata:\n  author: team\nallowed-tools: Read Bash(git:*)\n---\n# Tasks\n\nRead references/example.md.\n");
    await mkdir(join(path, "references"));
    await writeFile(join(path, "references", "example.md"), "Example tasks");
    const skills = await discoverSkills(root);

    expect(await skills.load("tasks")).toEqual({
      metadata: {
        name: "tasks",
        description: "Collect tasks.\nUse for notes.\n",
        license: "MIT",
        compatibility: "Requires Node.js",
        metadata: { author: "team" },
        "allowed-tools": "Read Bash(git:*)",
      },
      directory: path,
      instructions: "# Tasks\n\nRead references/example.md.\n",
    });
    expect(await skills.readFile("tasks", "references/example.md")).toBe("Example tasks");
  });

  it("accepts CRLF frontmatter and Unicode lowercase names", async () => {
    await writeSkill("überblick", "---\r\nname: überblick\r\ndescription: Überblick über Aufgaben.\r\n---\r\nInstructions\r\n");
    const skills = await discoverSkills(root);
    expect(skills.warnings).toEqual([]);
    expect((await skills.load("überblick")).instructions).toBe("Instructions\r\n");
  });

  it.each([
    ["no frontmatter", "# Just Markdown"],
    ["unclosed frontmatter", "---\nname: tasks\ndescription: Tasks"],
    ["invalid YAML", "---\nname: [\n---\nBody"],
    ["unknown YAML tag", "---\nname: tasks\ndescription: !unknown Tasks\n---\nBody"],
    ["duplicate YAML fields", "---\nname: tasks\nname: other\ndescription: Tasks\n---\nBody"],
    ["missing name", "---\ndescription: Tasks\n---\nBody"],
    ["missing description", "---\nname: tasks\n---\nBody"],
    ["blank description", "---\nname: tasks\ndescription: '  '\n---\nBody"],
    ["long description", `---\nname: tasks\ndescription: ${"x".repeat(1025)}\n---\nBody`],
    ["mismatched directory", "---\nname: other\ndescription: Tasks\n---\nBody"],
    ["unknown fields", "---\nname: tasks\ndescription: Tasks\nunexpected: true\n---\nBody"],
    ["non-string metadata", "---\nname: tasks\ndescription: Tasks\nmetadata:\n  version: 1\n---\nBody"],
    ["empty compatibility", "---\nname: tasks\ndescription: Tasks\ncompatibility: ''\n---\nBody"],
    ["long compatibility", `---\nname: tasks\ndescription: Tasks\ncompatibility: ${"x".repeat(501)}\n---\nBody`],
    ["tool list instead of string", "---\nname: tasks\ndescription: Tasks\nallowed-tools: [Read]\n---\nBody"],
  ])("warns and skips a skill with %s without hiding valid skills", async (_label, content) => {
    const path = await writeSkill("tasks", content);
    await writeSkill("valid");
    const skills = await discoverSkills(root);

    expect(skills.list().map((skill) => skill.name)).toEqual(["valid"]);
    expect(skills.warnings).toHaveLength(1);
    expect(skills.warnings[0]).toContain(join(path, "SKILL.md"));
    await expect(skills.load("tasks")).rejects.toThrow("Unbekannter oder ungültiger Skill: tasks");
  });

  it.each(["Tasks", "-tasks", "tasks-", "two--tasks", "two_tasks", "x".repeat(65)])(
    "rejects invalid skill name %s",
    async (name) => {
      await writeSkill(name);
      const skills = await discoverSkills(root);
      expect(skills.list()).toEqual([]);
      expect(skills.warnings).toHaveLength(1);
    },
  );

  it("accepts boundary lengths", async () => {
    const name = "x".repeat(64);
    await writeSkill(name, `---\nname: ${name}\ndescription: ${"d".repeat(1024)}\ncompatibility: ${"c".repeat(500)}\n---\nBody`);
    expect((await discoverSkills(root)).list()).toHaveLength(1);
  });

  it("loads instructions and references on demand, not from a discovery snapshot", async () => {
    const path = await writeSkill("tasks");
    const skills = await discoverSkills(root);
    await writeFile(join(path, "SKILL.md"), "---\nname: tasks\ndescription: Tasks\n---\nChanged instructions");
    expect((await skills.load("tasks")).instructions).toBe("Changed instructions");
    await writeFile(join(path, "reference.md"), "New reference");
    expect(await skills.readFile("tasks", "reference.md")).toBe("New reference");
    await writeFile(join(path, "SKILL.md"), "invalid after discovery");
    await expect(skills.load("tasks")).rejects.toThrow("SKILL.md");
  });

  it.each(["unknown", "__proto__", "../tasks"])("rejects unknown skill %s", async (name) => {
    const skills = await discoverSkills(root);
    await expect(skills.load(name)).rejects.toThrow("Unbekannter oder ungültiger Skill");
    await expect(skills.readFile(name, "file.md")).rejects.toThrow("Unbekannter oder ungültiger Skill");
  });

  it("reports unreadable roots instead of treating them as empty", async () => {
    await writeFile(root, "not a directory");
    await expect(discoverSkills(root)).rejects.toThrow(`Skills in ${root} konnten nicht geladen werden.`);
  });

  it("rejects absolute paths, traversal, external symlinks and non-files", async () => {
    const path = await writeSkill("tasks");
    const outside = join(directory, "secret.md");
    await writeFile(outside, "secret");
    await symlink(outside, join(path, "escape.md"));
    await mkdir(join(path, "folder"));
    const skills = await discoverSkills(root);

    for (const name of [outside, "../../secret.md", "escape.md", "folder"]) {
      await expect(skills.readFile("tasks", name)).rejects.toThrow();
    }
    await expect(skills.readFile("tasks", "missing.md")).rejects.toThrow("missing.md");
  });

  it("allows symlinks to files within the same skill", async () => {
    const path = await writeSkill("tasks");
    await writeFile(join(path, "reference.md"), "Safe reference");
    await symlink("reference.md", join(path, "link.md"));
    const skills = await discoverSkills(root);
    expect(await skills.readFile("tasks", "link.md")).toBe("Safe reference");
  });

  it("rejects skill directories and SKILL.md symlinks outside their boundaries", async () => {
    const outside = join(directory, "external");
    await mkdir(outside);
    await writeFile(join(outside, "SKILL.md"), "---\nname: external\ndescription: Tasks\n---\nSecret");
    await mkdir(root);
    await symlink(outside, join(root, "external"));
    const path = await writeSkill("tasks");
    await rm(join(path, "SKILL.md"));
    await symlink(join(outside, "SKILL.md"), join(path, "SKILL.md"));
    const skills = await discoverSkills(root);
    expect(skills.list()).toEqual([]);
    expect(skills.warnings).toHaveLength(2);
  });

  it("rejects cross-skill references even when both skills are inside the root", async () => {
    const path = await writeSkill("tasks");
    const sibling = await writeSkill("tasks-private");
    await writeFile(join(sibling, "secret.md"), "Sibling secret");
    await symlink(join(sibling, "secret.md"), join(path, "escape.md"));
    const skills = await discoverSkills(root);
    await expect(skills.readFile("tasks", "../tasks-private/secret.md")).rejects.toThrow("außerhalb");
    await expect(skills.readFile("tasks", "escape.md")).rejects.toThrow("außerhalb");
  });

  it("loads the repository example and its reference file", async () => {
    const path = fileURLToPath(new URL("../examples/skills", import.meta.url));
    const skills = await discoverSkills(path);
    expect(skills.warnings).toEqual([]);
    expect(skills.list().map((skill) => skill.name)).toEqual(["task-collection"]);
    expect((await skills.load("task-collection")).instructions).toContain("references/output-format.md");
    expect(await skills.readFile("task-collection", "references/output-format.md")).toContain("| Aufgabe | Priorität |");
  });

  it("rechecks path boundaries after discovery", async () => {
    const path = await writeSkill("tasks");
    const skills = await discoverSkills(root);
    const outside = join(directory, "external");
    await mkdir(outside);
    await writeFile(join(outside, "SKILL.md"), "---\nname: tasks\ndescription: Tasks\n---\nSecret");
    await rm(path, { recursive: true });
    await symlink(outside, path);
    await expect(skills.load("tasks")).rejects.toThrow();
    await expect(skills.readFile("tasks", "SKILL.md")).rejects.toThrow();
  });
});
