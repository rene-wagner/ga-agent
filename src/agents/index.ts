import type { AgentDefinition } from "./runtime.js";
import { taskCollector } from "./task-collector.js";

export const agents = [
  { name: "task-collector", graph: taskCollector },
] as const satisfies readonly AgentDefinition[];
