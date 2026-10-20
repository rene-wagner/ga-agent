import { tool } from "@langchain/core/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ModelConfig } from "../src/config.js";
import { createChatModel } from "../src/llm/index.js";
import { MODEL_TIMEOUT_MS } from "../src/llm/openrouter.js";

const config: ModelConfig = { provider: "openrouter", model: "vendor/model-a", maxOutputTokens: 2048 };

function completion() {
  return Response.json({
    id: "test-completion", model: config.model,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Antwort" } }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  });
}

function hangingFetch(_input: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
}

describe("OpenRouter models", () => {
  beforeEach(() => {
    vi.stubEnv("OPENROUTER_API_KEY", "TEST-SECRET");
    vi.stubEnv("LANGSMITH_TRACING", "false");
    vi.stubEnv("LANGCHAIN_TRACING_V2", "false");
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([undefined, "", "   "])("rejects a missing or empty key %j before any request", (key) => {
    vi.stubEnv("OPENROUTER_API_KEY", key);
    expect(() => createChatModel(config)).toThrow("OPENROUTER_API_KEY fehlt oder ist leer");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("creates independent models and sends the configured model, token limit and tools", async () => {
    const request = vi.fn(async () => completion());
    vi.stubGlobal("fetch", request);
    const first = createChatModel(config);
    const second = createChatModel({ ...config, model: "vendor/model-b", maxOutputTokens: 4096, temperature: 0.5 });
    const echo = tool(({ text }) => text, { name: "echo", description: "Echo text", schema: z.object({ text: z.string() }) });
    expect(first).not.toBe(second);
    expect(JSON.stringify(first)).not.toContain("TEST-SECRET");
    expect(request).not.toHaveBeenCalled();
    expect((await first.bindTools!([echo]).invoke("Hello")).text).toBe("Antwort");
    await second.invoke("Other agent");
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls[0][0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(new Headers(calls[0][1]?.headers).get("Authorization")).toBe("Bearer TEST-SECRET");
    const firstBody = JSON.parse(calls[0][1]?.body as string);
    const secondBody = JSON.parse(calls[1][1]?.body as string);
    expect(firstBody).toMatchObject({ model: "vendor/model-a", max_tokens: 2048, provider: { require_parameters: true }, stream: false });
    expect(firstBody.tools[0].function.name).toBe("echo");
    expect(JSON.stringify(firstBody)).not.toContain("TEST-SECRET");
    expect(secondBody).toMatchObject({ model: "vendor/model-b", max_tokens: 4096, temperature: 0.5 });
    expect(secondBody.tools).toBeUndefined();
  });

  it.each([
    [400, "Modell-/Tool-Parameter"], [401, "API-Key ungültig"], [402, "Guthaben"],
    [403, "verweigert"], [404, "Modell-ID"], [429, "Rate-Limit"],
  ])("sanitizes HTTP %i errors without repeating permanent failures", async (status, message) => {
    const request = vi.fn(async () => Response.json({ error: { message: "TEST-SECRET", metadata: { secret: "TEST-SECRET" } } }, { status }));
    vi.stubGlobal("fetch", request);
    const error = await createChatModel(config).invoke("Hello").catch((error: Error) => error);
    expect(String(error)).toContain(message);
    expect(String(error)).not.toContain("TEST-SECRET");
    expect((error as Error).cause).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([[408, "Zeitlimit"], [502, "Modellanbieter"], [503, "Kein geeigneter Modellanbieter"]])("retries temporary HTTP %i failures at most once", async (status, message) => {
    const request = vi.fn(async () => Response.json({ error: { message: "TEST-SECRET" } }, { status }));
    vi.stubGlobal("fetch", request);
    await expect(createChatModel(config).invoke("Hello")).rejects.toThrow(message);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    () => Response.json({ error: { message: "TEST-SECRET" } }),
    () => new Response("TEST-SECRET", { headers: { "Content-Type": "application/json" } }),
  ])("sanitizes malformed successful responses", async (response) => {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    await expect(createChatModel(config).invoke("Hello")).rejects.toThrow("OpenRouter: Modellaufruf fehlgeschlagen.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight request without retrying", async () => {
    vi.stubGlobal("fetch", vi.fn(hangingFetch));
    const controller = new AbortController();
    const pending = createChatModel(config).invoke("Hello", { signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    await assertion;
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("bounds the entire model request including retries with a deadline", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    vi.stubGlobal("fetch", vi.fn(hangingFetch));
    const pending = createChatModel(config).invoke("Hello");
    const assertion = expect(pending).rejects.toThrow("Zeitlimit für den Modellaufruf überschritten");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    deadline.abort(new DOMException("Timeout", "TimeoutError"));
    await assertion;
    expect(timeout).toHaveBeenCalledWith(MODEL_TIMEOUT_MS);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
