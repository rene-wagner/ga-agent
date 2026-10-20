import { BaseChatModel, type BaseChatModelCallOptions, type BindToolsInput } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";

interface CallOptions extends BaseChatModelCallOptions {
  tools?: BindToolsInput[];
}

export class ScriptedModel extends BaseChatModel<CallOptions> {
  readonly requests: { messages: BaseMessage[]; options: CallOptions }[] = [];

  constructor(readonly responses: AIMessage[] = [new AIMessage("Aufgaben gesammelt.")]) {
    super({ disableStreaming: true });
  }

  _llmType() { return "scripted-test-model"; }

  override bindTools(tools: BindToolsInput[]) {
    return this.withConfig({ tools });
  }

  async _generate(messages: BaseMessage[], options: CallOptions) {
    this.requests.push({ messages: [...messages], options });
    const response = this.responses[Math.min(this.requests.length - 1, this.responses.length - 1)];
    const message = new AIMessage({
      content: response.content,
      tool_calls: response.tool_calls,
      invalid_tool_calls: response.invalid_tool_calls,
      response_metadata: response.response_metadata,
    });
    return { generations: [{ text: message.text, message }] };
  }
}
