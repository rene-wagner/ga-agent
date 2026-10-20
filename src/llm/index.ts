import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ModelConfig } from "../config.js";
import { createOpenRouterModel } from "./openrouter.js";

export function createChatModel(config: ModelConfig): BaseChatModel {
  switch (config.provider) {
    case "openrouter":
      return createOpenRouterModel(config);
  }
}
