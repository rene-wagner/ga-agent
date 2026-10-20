#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig, loadEnv } from "./config.js";

async function withShutdown<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const interrupt = () => { process.exitCode = 130; controller.abort(new Error("Ausführung abgebrochen.")); };
  const terminate = () => { process.exitCode = 143; controller.abort(new Error("Ausführung abgebrochen.")); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    return await run(controller.signal);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

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
    const { loadAgents } = await import("./agents/index.js");
    await loadConfig();
    const agents = await loadAgents();

    for (const agent of agents) {
      const status = agent.enabled ? "aktiviert" : "deaktiviert";
      console.log(`${agent.name}\t${status}`);
    }
  });

program
  .command("run")
  .description("Einen Agent ausführen")
  .argument("<name>", "Name des Agents")
  .option("--skill <name>", "Einen installierten Skill explizit aktivieren")
  .action(async (name: string, options: { skill?: string }) => {
    const { loadAgents } = await import("./agents/index.js");
    const { runAgent } = await import("./agents/runtime.js");
    const agents = await loadAgents();
    const agent = agents.find((entry) => entry.name === name);
    if (!agent) {
      throw new Error(`Unbekannter Agent: ${name}. Verfügbare Agents: ${agents.map((entry) => entry.name).join(", ")}`);
    }

    const config = await loadConfig();
    if (!agent.enabled) {
      throw new Error(`Agent "${name}" ist deaktiviert.`);
    }
    const modelConfig = Object.hasOwn(config.models, agent.model) ? config.models[agent.model] : undefined;
    if (!modelConfig) {
      throw new Error(`Agent in ${agent.path}: Unbekannte Modellkonfiguration "${agent.model}". models.${agent.model} in config.json anlegen oder model im Frontmatter ändern.`);
    }
    const { createAgentGraph } = await import("./agents/graph.js");
    const result = await withShutdown((signal) => runAgent({ ...agent, graph: createAgentGraph(agent.instructions) }, {
      skill: options.skill,
      modelConfig,
      mcpServers: config.mcpServers,
      signal,
    }));
    console.log(result.message);
  });

const mcp = program.command("mcp").description("MCP-Server anmelden und abmelden");

for (const action of ["login", "logout"] as const) {
  mcp.command(action)
    .description(action === "login" ? "Einen OAuth-MCP-Server im Browser anmelden" : "OAuth-Anmeldung löschen und nach Möglichkeit widerrufen")
    .argument("<server>", "Name aus mcpServers in config.json")
    .action(async (name: string) => {
      const config = await loadConfig();
      const server = Object.hasOwn(config.mcpServers, name) ? config.mcpServers[name] : undefined;
      if (!server) throw new Error(`Unbekannter MCP-Server: ${name}`);
      if (server.transport !== "http" || !server.auth) throw new Error(`MCP-Server "${name}" ist kein OAuth-HTTP-Server.`);
      const { loginMcpServer, logoutMcpServer } = await import("./mcp/oauth.js");
      await withShutdown((signal) => action === "login"
        ? loginMcpServer(name, server, { signal })
        : logoutMcpServer(name, server, { signal }));
      console.log(`MCP-Server "${name}": ${action === "login" ? "angemeldet" : "abgemeldet"}.`);
    });
}

try {
  await program.parseAsync();
} catch (error) {
  console.error(`Fehler: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode ||= 1;
}
