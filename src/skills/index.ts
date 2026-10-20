import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { getConfigDirectory } from "../config.js";

function hasLength(value: string, min: number, max: number): boolean {
  const length = [...value].length;
  return length >= min && length <= max;
}

const metadataSchema = z.strictObject({
  name: z.string().refine((name) =>
    hasLength(name, 1, 64)
    && name === name.toLowerCase()
    && /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(name),
  { message: "Ungültiger Skill-Name." }),
  description: z.string().refine((value) =>
    value.trim().length > 0 && hasLength(value, 1, 1024),
  { message: "Die Beschreibung muss 1 bis 1024 Zeichen enthalten." }),
  license: z.string().optional(),
  compatibility: z.string().refine((value) => hasLength(value, 1, 500)).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  "allowed-tools": z.string().optional(),
});

export type SkillMetadata = z.infer<typeof metadataSchema>;
export type SkillSummary = Pick<SkillMetadata, "name" | "description">;

export interface LoadedSkill {
  metadata: SkillMetadata;
  directory: string;
  instructions: string;
}

interface SkillEntry {
  metadata: SkillMetadata;
  directory: string;
}

function parseSkill(content: string, directoryName: string) {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (!match) {
    throw new Error("SKILL.md benötigt YAML-Frontmatter zwischen --- und ---.");
  }

  const document = parseDocument(match[1]);
  const issues = [...document.errors, ...document.warnings];
  if (issues.length > 0) {
    throw new Error(issues.map((issue) => issue.message).join("\n"));
  }

  const metadata = metadataSchema.parse(document.toJS({ maxAliasCount: 100 }));
  if (metadata.name !== directoryName) {
    throw new Error(`Skill-Name "${metadata.name}" muss dem Verzeichnisnamen "${directoryName}" entsprechen.`);
  }

  return { metadata, instructions: match[2] };
}

function assertWithin(directory: string, path: string): void {
  const pathRelative = relative(directory, path);
  if (pathRelative === ".." || pathRelative.startsWith(`..${sep}`) || isAbsolute(pathRelative)) {
    throw new Error(`Pfad liegt außerhalb des Skill-Verzeichnisses: ${path}`);
  }
}

async function readSkillFile(directory: string, path: string): Promise<string> {
  if (isAbsolute(path)) {
    throw new Error(`Skill-Dateipfade müssen relativ sein: ${path}`);
  }

  const resolved = resolve(directory, path);
  assertWithin(directory, resolved);
  const canonical = await realpath(resolved);
  assertWithin(directory, canonical);
  if (!(await stat(canonical)).isFile()) {
    throw new Error(`Keine reguläre Skill-Datei: ${canonical}`);
  }

  return readFile(canonical, "utf8");
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export class SkillRegistry {
  private readonly entries: Map<string, SkillEntry>;

  constructor(entries: SkillEntry[], public readonly warnings: readonly string[]) {
    this.entries = new Map(entries.map((entry) => [entry.metadata.name, entry]));
  }

  list(): SkillSummary[] {
    return [...this.entries.values()].map(({ metadata }) => ({
      name: metadata.name,
      description: metadata.description,
    }));
  }

  private get(name: string): SkillEntry {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new Error(`Unbekannter oder ungültiger Skill: ${name}`);
    }
    return entry;
  }

  async load(name: string): Promise<LoadedSkill> {
    const entry = this.get(name);
    try {
      const content = await readSkillFile(entry.directory, "SKILL.md");
      return { ...parseSkill(content, name), directory: entry.directory };
    } catch (error) {
      throw new Error(`Skill in ${join(entry.directory, "SKILL.md")} konnte nicht geladen werden: ${detail(error)}`, {
        cause: error,
      });
    }
  }

  async readFile(name: string, path: string): Promise<string> {
    const entry = this.get(name);
    try {
      return await readSkillFile(entry.directory, path);
    } catch (error) {
      throw new Error(`Datei "${path}" von Skill "${name}" konnte nicht gelesen werden: ${detail(error)}`, {
        cause: error,
      });
    }
  }
}

export async function discoverSkills(
  path = join(getConfigDirectory(), "skills"),
): Promise<SkillRegistry> {
  let directory: string;
  let children;
  try {
    directory = await realpath(path);
    children = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      return new SkillRegistry([], []);
    }
    throw new Error(`Skills in ${path} konnten nicht geladen werden.`, { cause: error });
  }

  const entries: SkillEntry[] = [];
  const warnings: string[] = [];
  for (const child of children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (!child.isDirectory() && !child.isSymbolicLink()) {
      continue;
    }
    const skillPath = join(directory, child.name);
    try {
      const canonical = await realpath(skillPath);
      assertWithin(directory, canonical);
      if (!(await stat(canonical)).isDirectory()) {
        continue;
      }
      const content = await readSkillFile(canonical, "SKILL.md");
      const { metadata } = parseSkill(content, child.name);
      entries.push({ metadata, directory: canonical });
    } catch (error) {
      if (!isMissing(error)) {
        warnings.push(`Ungültiger Skill in ${join(skillPath, "SKILL.md")}: ${detail(error)}`);
      }
    }
  }

  return new SkillRegistry(entries, warnings);
}
