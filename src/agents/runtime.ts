import { Annotation } from "@langchain/langgraph";
import { discoverSkills, type LoadedSkill, type SkillRegistry } from "../skills/index.js";

export const AgentContext = Annotation.Root({
  skills: Annotation<SkillRegistry>(),
  activeSkill: Annotation<LoadedSkill | undefined>(),
});

export type AgentContext = typeof AgentContext.State;

export interface AgentDefinition {
  name: string;
  graph: {
    invoke(input: Record<string, never>, options: { context: AgentContext }): Promise<{ message: string }>;
  };
}

interface RunOptions {
  skillsPath?: string;
  skill?: string;
  onWarning?: (message: string) => void;
}

export async function runAgent(
  agent: AgentDefinition,
  { skillsPath, skill, onWarning = (message) => console.warn(`Warnung: ${message}`) }: RunOptions = {},
): Promise<{ message: string }> {
  const skills = await discoverSkills(skillsPath);
  for (const warning of skills.warnings) {
    onWarning(warning);
  }
  const activeSkill = skill === undefined ? undefined : await skills.load(skill);

  return agent.graph.invoke({}, { context: { skills, activeSkill } });
}
