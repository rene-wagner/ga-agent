import { taskCollector } from "./task-collector.js";

export const agents = [
  { name: "task-collector", graph: taskCollector },
] as const;
