import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { AgentContext } from "./runtime.js";

const State = Annotation.Root({
  message: Annotation<string>(),
});

export const taskCollector = new StateGraph(State, AgentContext)
  .addNode("dummy", (_state, runtime) => {
    const activeSkill = runtime.context?.activeSkill;
    const message = "task-collector: Dummy erfolgreich ausgeführt.";
    return {
      message: activeSkill ? `${message} Skill "${activeSkill.metadata.name}" geladen.` : message,
    };
  })
  .addEdge(START, "dummy")
  .addEdge("dummy", END)
  .compile();
