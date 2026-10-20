import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentGraph } from "../../src/agents/graph.js";
import { loadAgents, type MarkdownAgent } from "../../src/agents/index.js";

export async function loadExampleAgent() {
  const [agent] = await loadAgents(fileURLToPath(new URL("../../examples/agents/", import.meta.url)));
  if (!agent) throw new Error("Example agent is missing");
  return { ...agent, graph: createAgentGraph(agent.instructions) };
}

export async function installExampleAgent(
  configDirectory: string,
  settings: Partial<Pick<MarkdownAgent, "model" | "enabled" | "mcp">> = {},
) {
  const agent = await loadExampleAgent();
  const directory = join(configDirectory, "agents");
  await mkdir(directory, { recursive: true });
  const metadata = { model: agent.model, enabled: agent.enabled, mcp: agent.mcp, ...settings };
  await writeFile(join(directory, `${agent.name}.md`), `---\n${JSON.stringify(metadata)}\n---\n${agent.instructions}\n`);
}
