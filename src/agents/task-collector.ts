import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { AgentContext } from "./runtime.js";

const State = Annotation.Root({ message: Annotation<string>() });

export const taskCollector = new StateGraph(State, AgentContext)
  .addNode("model", async (_state, runtime) => {
    const model = runtime.context?.model;
    if (!model) throw new Error("Kein Modell im Agent-Kontext vorhanden.");
    const response = await model.invoke([
      new SystemMessage("Du bist der task-collector. Antworte kurz und auf Deutsch."),
      new HumanMessage("Bestätige bitte kurz, dass die LLM-Anbindung funktioniert."),
    ], { signal: runtime.signal });
    if (response.tool_calls?.length || response.invalid_tool_calls?.length) {
      throw new Error("Das Modell hat unerwartete Tool-Aufrufe geliefert.");
    }
    if (response.response_metadata.finish_reason === "length") throw new Error("Ausgabe-Token-Limit des Modells erreicht.");
    const message = response.text.trim();
    if (!message) throw new Error("Das Modell hat keine Textantwort geliefert.");
    return { message };
  })
  .addEdge(START, "model")
  .addEdge("model", END)
  .compile();
