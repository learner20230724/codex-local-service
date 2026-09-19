import { test, expect } from "bun:test";
import { defaultConfig } from "../.runtime/web/src/config";
import { responseRequest } from "../.runtime/web/src/server";
import { ensureUnpersonalized } from "./privacy";
import { extractChatGptTurnIdentity, extractChatGptTurnUserRevision } from "../.runtime/web/src/adapters/chatgpt-web/environment";
import { chatGptConversationKey } from "../.runtime/web/src/adapters/chatgpt-web/conversation-key";
import { prepareBrowserRequest } from "./request";
const noDialogs = () => { const locator: any = { count: async () => 0, filter: () => locator }; return locator; };

test("plain inference reaches the pinned Responses adapter without native tool authority", async () => {
  const cfg = defaultConfig("browser-only");
  let received: any;
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", { method: "POST",
    body: JSON.stringify(prepareBrowserRequest({ model: "chatgpt-web/high", input: "hello" })),
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
  expect(extractChatGptTurnIdentity(received).turnId).toBeTruthy();
  expect(extractChatGptTurnUserRevision(received)).toBe("hello");
  expect(chatGptConversationKey(received, "test")).toBeTruthy();
  expect(json.status).toBe("completed");
  expect(json.output.some((item: any) => item.content?.some((c: any) => c.text === "OK"))).toBe(true);
});
test("full history preserves roles and content while each web request gets independent ownership", () => {
  const history = [{ role: "system", content: "Be concise" }, { role: "user", content: "old question" },
    { role: "assistant", content: "old answer" }, { role: "user", content: "new question" }];
  const one = prepareBrowserRequest({ input: history }), two = prepareBrowserRequest({ input: history });
  expect(one.input.map(({ role, content }: any) => ({ role, content }))).toEqual(history);
  expect(one.client_metadata).not.toEqual(two.client_metadata);
  expect(one.input[0].internal_chat_message_metadata_passthrough).toBeUndefined();
  expect(one.input.at(-1).internal_chat_message_metadata_passthrough.turn_id).toBeTruthy();
  expect(() => prepareBrowserRequest({ input: [{ role: "assistant", content: "old answer" }] })).toThrow("web_user_message_required");
});
test("privacy guard rejects ordinary chat and unknown personalization controls", async () => {
  await expect(ensureUnpersonalized({ url: () => "https://chatgpt.com/c/example" })).rejects.toThrow("temporary_chat_required");
  await expect(ensureUnpersonalized({ url: () => "https://chatgpt.com/?temporary-chat=true",
    locator: noDialogs,
    getByRole: () => ({ filter: () => ({ isVisible: async () => false }) }) }, { noticeWaitMs: 0 })).rejects.toThrow("temporary_chat_privacy_unverified");
});
test("privacy guard accepts proven unpersonalized state without changing global settings", async () => {
  let clicks = 0;
  await ensureUnpersonalized({ url: () => "https://chatgpt.com/?temporary-chat=true",
    locator: noDialogs,
    getByRole: () => ({ filter: () => ({ isVisible: async () => true, click: async () => { clicks++; } }) }) }, { noticeWaitMs: 0 });
  expect(clicks).toBe(0);
});
