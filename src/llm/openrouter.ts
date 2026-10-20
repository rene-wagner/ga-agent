import { ChatOpenRouter, OpenRouterError } from "@langchain/openrouter";
import type { ModelConfig } from "../config.js";

export const MODEL_TIMEOUT_MS = 60_000;

const statusMessages: Record<number, string> = {
  400: "Ungültige Anfrage oder nicht unterstützte Modell-/Tool-Parameter.",
  401: "API-Key ungültig. OPENROUTER_API_KEY prüfen.",
  402: "Nicht genügend Guthaben oder Budget verfügbar.",
  403: "Zugriff auf das Modell verweigert.",
  404: "Modell nicht verfügbar. Modell-ID prüfen.",
  408: "Zeitlimit für den Modellaufruf überschritten.",
  429: "Rate-Limit erreicht. Später erneut versuchen.",
  502: "Modellanbieter vorübergehend nicht verfügbar.",
  503: "Kein geeigneter Modellanbieter verfügbar.",
};

// Sanitize at the model boundary, before errors reach graph callbacks or CLI output.
class SafeChatOpenRouter extends ChatOpenRouter {
  override async _generate(...args: Parameters<ChatOpenRouter["_generate"]>) {
    const timeout = AbortSignal.timeout(MODEL_TIMEOUT_MS);
    const signal = args[1].signal ? AbortSignal.any([args[1].signal, timeout]) : timeout;
    try {
      return await super._generate(args[0], { ...args[1], signal }, args[2]);
    } catch (error) {
      if (signal.aborted) {
        throw new Error(timeout.aborted
          ? "OpenRouter: Zeitlimit für den Modellaufruf überschritten."
          : "OpenRouter: Modellaufruf abgebrochen.");
      }
      const status = OpenRouterError.isInstance(error) ? error.statusCode : undefined;
      throw new Error(`OpenRouter: ${statusMessages[status ?? 0] ?? "Modellaufruf fehlgeschlagen."}`);
    }
  }
}

export function createOpenRouterModel(config: ModelConfig): ChatOpenRouter {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OpenRouter: OPENROUTER_API_KEY fehlt oder ist leer. In ~/.config/ga-agent/.env oder der Prozessumgebung setzen.");
  }
  return new SafeChatOpenRouter({
    apiKey,
    model: config.model,
    maxTokens: config.maxOutputTokens,
    temperature: config.temperature,
    maxRetries: 1,
    disableStreaming: true,
    provider: { require_parameters: true },
    siteName: "ga-agent",
    siteUrl: "",
  });
}
