import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Annotation } from "@langchain/langgraph";
import type { Config, ModelConfig } from "../config.js";
import { createChatModel } from "../llm/index.js";
import { withMcpTools } from "../mcp/index.js";
import { createOAuthAuthProviders } from "../mcp/oauth.js";
import { discoverSkills, type LoadedSkill, type SkillRegistry } from "../skills/index.js";

export const AGENT_TIMEOUT_MS = 300_000;
export const AGENT_RECURSION_LIMIT = 32;

export const AgentContext = Annotation.Root({
  model: Annotation<BaseChatModel>(),
  skills: Annotation<SkillRegistry>(),
  activeSkill: Annotation<LoadedSkill | undefined>(),
  mcpTools: Annotation<StructuredToolInterface[]>(),
});

export type AgentContext = typeof AgentContext.State;

export interface AgentDefinition {
  name: string;
  mcp?: boolean;
  graph: {
    invoke(input: Record<string, never>, options: { context: AgentContext; signal?: AbortSignal; recursionLimit?: number }): Promise<{ message: string }>;
  };
}

interface RunOptions {
  modelConfig?: ModelConfig;
  model?: BaseChatModel;
  timeoutMs?: number;
  skillsPath?: string;
  skill?: string;
  onWarning?: (message: string) => void;
  mcpServers?: Config["mcpServers"];
  authDirectory?: string;
  signal?: AbortSignal;
}

export async function runAgent(
  agent: AgentDefinition,
  { modelConfig, model, timeoutMs = AGENT_TIMEOUT_MS, skillsPath, skill, mcpServers = {}, authDirectory, signal, onWarning = (message) => console.warn(`Warnung: ${message}`) }: RunOptions = {},
): Promise<{ message: string }> {
  const skills = await discoverSkills(skillsPath);
  for (const warning of skills.warnings) {
    onWarning(warning);
  }
  const activeSkill = skill === undefined ? undefined : await skills.load(skill);

  if (!model && !modelConfig) {
    throw new Error(`Agent "${agent.name}": Keine Modellkonfiguration. Modellprofil aus dem Frontmatter von agents/${agent.name}.md über config.models auflösen.`);
  }
  const chatModel = model ?? createChatModel(modelConfig!);
  const deadline = new AbortController();
  const runSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  try {
    runSignal.throwIfAborted();
    const servers = agent.mcp === false ? {} : mcpServers;
    const result = await withMcpTools(servers, {
      signal: runSignal,
      authProviders: (sessionSignal) => createOAuthAuthProviders(servers, { authDirectory, signal: sessionSignal }),
    }, (mcpTools) => agent.graph.invoke({}, {
      context: { model: chatModel, skills, activeSkill, mcpTools },
      signal: runSignal,
      recursionLimit: AGENT_RECURSION_LIMIT,
    }));
    runSignal.throwIfAborted();
    return { message: result.message };
  } catch (error) {
    if (signal?.aborted) throw new Error("Ausführung abgebrochen.");
    if (deadline.signal.aborted) throw new Error("Zeitlimit für den Agent-Lauf überschritten.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
