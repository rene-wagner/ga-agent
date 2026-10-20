import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { z } from "zod";

const configSchema = z.strictObject({
  agents: z.strictObject({
    "task-collector": z.strictObject({
      enabled: z.boolean().default(true),
    }).prefault({}),
  }).prefault({}),
});

export type Config = z.infer<typeof configSchema>;

export function getConfigDirectory(): string {
  return join(homedir(), ".config", "ga-agent");
}

export function loadEnv(
  path = join(getConfigDirectory(), ".env"),
): void {
  try {
    loadEnvFile(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw new Error(`Umgebungsvariablen aus ${path} konnten nicht geladen werden.`, {
      cause: error,
    });
  }
}

export async function loadConfig(
  path = join(getConfigDirectory(), "config.json"),
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
