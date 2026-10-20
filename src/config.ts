import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const configSchema = z.strictObject({
  agents: z.strictObject({
    "task-collector": z.strictObject({
      enabled: z.boolean().default(true),
    }).prefault({}),
  }).prefault({}),
});

export type Config = z.infer<typeof configSchema>;

export async function loadConfig(
  path = join(homedir(), ".config", "ga-agent", "config.json"),
): Promise<Config> {
  let content: string;

  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return configSchema.parse({});
    }

    throw new Error(`Konfiguration in ${path} konnte nicht gelesen werden.`, {
      cause: error,
    });
  }

  try {
    return configSchema.parse(JSON.parse(content));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Ungültige Konfiguration in ${path}: ${detail}`, {
      cause: error,
    });
  }
}
