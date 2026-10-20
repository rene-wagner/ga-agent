import type { AgentContext } from "./runtime.js";
import { validateToolNames } from "../mcp/index.js";
import { createSkillSupport, type SkillSupport } from "../skills/tools.js";

export function createAgentSupport(context: AgentContext): SkillSupport {
  const support = createSkillSupport(context.skills, context.activeSkill);
  const tools = [...support.tools, ...context.mcpTools];
  validateToolNames(tools);
  return { prompt: support.prompt, tools };
}
