import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgents } from "../src/agents/index.js";

const content = "---\nmodel: fast\n---\n# Aufgabe\n\nAntworte auf Deutsch.\n";

describe("Markdown agents", () => {
  let directory: string;
  let root: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ga-agent-definitions-"));
    root = join(directory, "agents");
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  async function install(name: string, value = content) {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, name), value);
  }

  it("returns no agents for a missing directory without creating files", async () => {
    expect(await loadAgents(root)).toEqual([]);
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("loads metadata and instructions with the filename as identity", async () => {
    await install("test-agent.md", "---\ndescription: Ein Test.\nmodel: fast\nenabled: false\nmcp: false\n---\n# Test\n\nAnweisungen.\n");
    expect(await loadAgents(root)).toEqual([{
      name: "test-agent", path: join(root, "test-agent.md"), description: "Ein Test.",
      model: "fast", enabled: false, mcp: false, instructions: "# Test\n\nAnweisungen.",
    }]);
  });

  it("uses defaults and sorts immediate Markdown files, ignoring other files and directories", async () => {
    await install("z.md");
    await install("a.md");
    await install("notes.txt", "ignored");
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "ignored.md"), "invalid");
    const agents = await loadAgents(root);
    expect(agents.map((agent) => agent.name)).toEqual(["a", "z"]);
    expect(agents[0]).toMatchObject({ enabled: true, mcp: true, model: "fast", instructions: "# Aufgabe\n\nAntworte auf Deutsch." });
  });

  it("accepts BOM and CRLF", async () => {
    await install("test.md", `\uFEFF${content.replaceAll("\n", "\r\n")}`);
    expect((await loadAgents(root))[0].model).toBe("fast");
  });

  it.each([
    "no frontmatter",
    "---\nmodel: fast\n",
    "---\nmodel: [\n---\nPrompt",
    "---\nmodel: *SECRET\n---\nPrompt",
    "---\nmodel: !SECRET fast\n---\nPrompt",
    "---\nmodel: fast\nmodel: other\n---\nPrompt",
    "---\n{}\n---\nPrompt",
    "---\nmodel: null\n---\nPrompt",
    "---\nmodel: 123\n---\nPrompt",
    "---\nmodel: ../invalid\n---\nPrompt",
    "---\nmodel: fast\nenabled: 'false'\n---\nPrompt",
    "---\nmodel: fast\nmcp: null\n---\nPrompt",
    "---\nmodel: fast\ndescription: ' '\n---\nPrompt",
    "---\nmodel: fast\nname: different\n---\nPrompt",
    "---\nmodel: fast\napiKey: SECRET\n---\nPrompt",
    "---\nmodel: fast\n---\n \n",
  ])("rejects invalid definitions without exposing values: %j", async (value) => {
    await install("broken.md", value);
    const error = await loadAgents(root).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(join(root, "broken.md"));
    expect(String(error)).not.toContain("SECRET");
  });

  it.each(["bad name.md", "_bad.md", ".hidden.md", `${"a".repeat(65)}.md`])("rejects invalid filename %s", async (name) => {
    await install(name);
    await expect(loadAgents(root)).rejects.toThrow("Ungültiger Agent-Name");
  });

  it("returns an empty list for an empty directory", async () => {
    await mkdir(root);
    expect(await loadAgents(root)).toEqual([]);
  });

  it("reports root read failures", async () => {
    await writeFile(root, "not a directory");
    await expect(loadAgents(root)).rejects.toThrow(`Agents in ${root} konnten nicht geladen werden.`);
  });

  it("rejects symlinks escaping the agents directory", async () => {
    await mkdir(root);
    await writeFile(join(directory, "outside.md"), content);
    await symlink(join(directory, "outside.md"), join(root, "escape.md"));
    await expect(loadAgents(root)).rejects.toThrow("außerhalb des Agents-Verzeichnisses");
  });

  it("allows internal file symlinks but rejects broken links", async () => {
    await install("source.md");
    await symlink(join(root, "source.md"), join(root, "alias.md"));
    expect((await loadAgents(root)).map((agent) => agent.name)).toEqual(["alias", "source"]);
    await symlink(join(root, "missing.md"), join(root, "broken.md"));
    await expect(loadAgents(root)).rejects.toThrow(join(root, "broken.md"));
  });

  it("rereads changed definitions on the next load", async () => {
    await install("test.md");
    expect((await loadAgents(root))[0].model).toBe("fast");
    await install("test.md", content.replace("fast", "thorough").replace("Deutsch", "Englisch"));
    expect((await loadAgents(root))[0]).toMatchObject({ model: "thorough", instructions: expect.stringContaining("Englisch") });
  });
});
