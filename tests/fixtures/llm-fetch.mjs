import { writeFile } from "node:fs/promises";

// Preloaded only in CLI tests. No external requests, even if a real key is inherited.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.href === "https://openrouter.ai/api/v1/chat/completions") {
    if (process.env.GA_TEST_LLM_MARKER) await writeFile(process.env.GA_TEST_LLM_MARKER, "started");
    if (process.env.GA_TEST_LLM_MODE === "hang") {
      return new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason);
        else init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    }
    if (process.env.GA_TEST_LLM_MODE === "error") {
      return Response.json({ error: { message: "SECRET provider response" } }, { status: 401 });
    }
    const body = JSON.parse(init.body);
    return Response.json({
      id: "test-completion", model: body.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: `Aufgaben gesammelt mit ${body.model}.` } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  }
  if (["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) return originalFetch(input, init);
  throw new Error("External requests are forbidden in CLI tests");
};
