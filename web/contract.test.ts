import { test, expect } from "bun:test";
import { defaultConfig } from "../.runtime/web/src/config";
import { responseRequest } from "../.runtime/web/src/server";
import { ensureUnpersonalized } from "./privacy";
import { extractChatGptTurnIdentity } from "../.runtime/web/src/adapters/chatgpt-web/environment";

test("plain inference reaches the pinned Responses adapter without native tool authority", async () => {
  const cfg = defaultConfig("browser-only");
  let received: any;
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", { method: "POST",
    body: JSON.stringify({ model: "chatgpt-web/high", input: [{ type: "message", role: "user", content: "hello" }],
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "test-thread", turn_id: "test-turn" }) } }),
  }), cfg, ((provider: any) => {
    expect(provider.chatgptWeb.localToolsEnabled).toBe(false);
    return { runTurn: async (parsed: any, _incoming: any, emit: any) => {
      received = parsed;
      emit({ type: "text_delta", text: "OK", phase: "final_answer" });
      emit({ type: "usage", inputTokens: 1, outputTokens: 1 });
      emit({ type: "done", stopReason: "stop" });
    } };
  }) as any, { rememberState: false });
  const json: any = await response.json();
  expect(received.context.messages.at(-1).content).toBe("hello");
  expect(extractChatGptTurnIdentity(received)).toMatchObject({ threadId: "test-thread", turnId: "test-turn" });
  expect(json.status).toBe("completed");
  expect(json.output.some((item: any) => item.content?.some((c: any) => c.text === "OK"))).toBe(true);
});
test("privacy guard rejects ordinary chat and unknown personalization controls", async () => {
  await expect(ensureUnpersonalized({ url: () => "https://chatgpt.com/c/example" })).rejects.toThrow("temporary_chat_required");
  await expect(ensureUnpersonalized({ url: () => "https://chatgpt.com/?temporary-chat=true",
    getByRole: () => ({ filter: () => ({ isVisible: async () => false }) }) })).rejects.toThrow("temporary_chat_privacy_unverified");
});
test("privacy guard accepts proven unpersonalized state without changing global settings", async () => {
  let clicks = 0;
  await ensureUnpersonalized({ url: () => "https://chatgpt.com/?temporary-chat=true",
    getByRole: () => ({ filter: () => ({ isVisible: async () => true, click: async () => { clicks++; } }) }) });
  expect(clicks).toBe(0);
});
