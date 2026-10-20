import type { StructuredToolInterface } from "@langchain/core/tools";
import { Annotation } from "@langchain/langgraph";
import type { Config } from "../config.js";
import { withMcpTools } from "../mcp/index.js";
import { createOAuthAuthProviders } from "../mcp/oauth.js";
import { discoverSkills, type LoadedSkill, type SkillRegistry } from "../skills/index.js";

export const AgentContext = Annotation.Root({
  skills: Annotation<SkillRegistry>(),
  activeSkill: Annotation<LoadedSkill | undefined>(),
  mcpTools: Annotation<StructuredToolInterface[]>(),
});

export type AgentContext = typeof AgentContext.State;

export interface AgentDefinition {
  name: string;
  graph: {
    invoke(input: Record<string, never>, options: { context: AgentContext; signal?: AbortSignal }): Promise<{ message: string }>;
  };
}

interface RunOptions {
  skillsPath?: string;
  skill?: string;
  onWarning?: (message: string) => void;
  mcpServers?: Config["mcpServers"];
  authDirectory?: string;
  signal?: AbortSignal;
}

export async function runAgent(
  agent: AgentDefinition,
  { skillsPath, skill, mcpServers = {}, authDirectory, signal, onWarning = (message) => console.warn(`Warnung: ${message}`) }: RunOptions = {},
): Promise<{ message: string }> {
  const skills = await discoverSkills(skillsPath);
  for (const warning of skills.warnings) {
    onWarning(warning);
  }
  const activeSkill = skill === undefined ? undefined : await skills.load(skill);

  return withMcpTools(mcpServers, {
    signal,
    authProviders: (sessionSignal) => createOAuthAuthProviders(mcpServers, { authDirectory, signal: sessionSignal }),
  }, (mcpTools) =>
    agent.graph.invoke({}, { context: { skills, activeSkill, mcpTools }, signal }));
}
