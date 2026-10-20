import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

const State = Annotation.Root({
  message: Annotation<string>(),
});

export const taskCollector = new StateGraph(State)
  .addNode("dummy", () => ({
    message: "task-collector: Dummy erfolgreich ausgeführt.",
  }))
  .addEdge(START, "dummy")
  .addEdge("dummy", END)
  .compile();
