import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { getConfigDirectory } from "../config.js";

const nameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const metadataSchema = z.strictObject({
  description: z.string().trim().min(1).optional(),
  model: nameSchema,
  enabled: z.boolean().default(true),
  mcp: z.boolean().default(true),
});

export interface MarkdownAgent extends z.infer<typeof metadataSchema> {
  name: string;
  path: string;
  instructions: string;
}

function parseAgent(content: string) {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (!match) throw new Error("YAML-Frontmatter zwischen --- und --- fehlt.");
  let values: unknown;
  try {
    const document = parseDocument(match[1]);
    if (document.errors.length || document.warnings.length) throw new Error();
    values = document.toJS({ maxAliasCount: 100 });
  } catch {
    // YAML errors can include source values or alias names.
    throw new Error("Ungültiges YAML-Frontmatter.");
  }
  const metadata = metadataSchema.safeParse(values);
  if (!metadata.success) {
    const detail = metadata.error.issues.map((issue) => `${issue.path.join(".") || "Frontmatter"}: ${issue.code}`).join("; ");
    throw new Error(`Ungültige Metadaten: ${detail}`);
  }
  const instructions = match[2].trim();
  if (!instructions) throw new Error("Der Markdown-Prompt darf nicht leer sein.");
  return { ...metadata.data, instructions };
}

export async function loadAgents(
  path = join(getConfigDirectory(), "agents"),
): Promise<MarkdownAgent[]> {
  let directory: string;
  let children;
  try {
    directory = await realpath(path);
    children = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw new Error(`Agents in ${path} konnten nicht geladen werden.`, { cause: error });
  }

  const agents: MarkdownAgent[] = [];
  for (const child of children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (!child.name.endsWith(".md") || (!child.isFile() && !child.isSymbolicLink())) continue;
    const agentPath = join(directory, child.name);
    try {
      const name = child.name.slice(0, -3);
      if (!nameSchema.safeParse(name).success) throw new Error("Ungültiger Agent-Name im Dateinamen.");
      const canonical = await realpath(agentPath);
      const pathRelative = relative(directory, canonical);
      if (pathRelative === ".." || pathRelative.startsWith(`..${sep}`) || isAbsolute(pathRelative)) {
        throw new Error("Dateipfad liegt außerhalb des Agents-Verzeichnisses.");
      }
      if (!(await stat(canonical)).isFile()) throw new Error("Keine reguläre Agent-Datei.");
      agents.push({ name, path: agentPath, ...parseAgent(await readFile(canonical, "utf8")) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Datei konnte nicht geladen werden.";
      throw new Error(`Ungültiger Agent in ${agentPath}: ${detail}`);
    }
  }
  return agents;
}
