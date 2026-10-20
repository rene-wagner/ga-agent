#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig, loadEnv } from "./config.js";

const program = new Command()
  .name("ga-agent")
  .description("LangGraph-Agents auflisten und ausführen")
  .hook("preAction", () => {
    loadEnv();
  });

program
  .command("list")
  .description("Verfügbare Agents und ihren Aktivierungsstatus anzeigen")
  .action(async () => {
    const { agents } = await import("./agents/index.js");
    const config = await loadConfig();

    for (const agent of agents) {
      const status = config.agents[agent.name].enabled ? "aktiviert" : "deaktiviert";
      console.log(`${agent.name}\t${status}`);
    }
  });

program
  .command("run")
  .description("Einen Agent ausführen")
  .argument("<name>", "Name des Agents")
  .action(async (name: string) => {
    const { agents } = await import("./agents/index.js");
    const agent = agents.find((entry) => entry.name === name);
    if (!agent) {
      throw new Error(`Unbekannter Agent: ${name}. Verfügbare Agents: ${agents.map((entry) => entry.name).join(", ")}`);
    }

    const config = await loadConfig();
    if (!config.agents[agent.name].enabled) {
      throw new Error(`Agent "${name}" ist deaktiviert.`);
    }

    const result = await agent.graph.invoke({});
    console.log(result.message);
  });

try {
  await program.parseAsync();
} catch (error) {
  console.error(`Fehler: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
