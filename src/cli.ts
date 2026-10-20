#!/usr/bin/env node
import { Command } from "commander";
import { agents } from "./agents/index.js";
import { loadConfig } from "./config.js";

const program = new Command()
  .name("ga-agent")
  .description("LangGraph-Agents auflisten und ausführen");

program
  .command("list")
  .description("Verfügbare Agents und ihren Aktivierungsstatus anzeigen")
  .action(async () => {
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
