import type { AgentDefinition } from "./runtime.js";
import { taskCollector } from "./task-collector.js";

export const agents = [
  { name: "task-collector", graph: taskCollector, mcp: false },
] as const satisfies readonly AgentDefinition[];
