import { randomUUID } from "node:crypto";

/** Give plain API history the message/turn identities required by the pinned browser adapter. */
export function prepareBrowserRequest(body: any): any {
  const source = typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input;
  if (!Array.isArray(source)) throw new Error("unsupported_web_input");
  const thread = randomUUID(), turn = randomUUID();
  const input = source.map(message => ({ type: "message", id: `msg_${randomUUID()}`,
    role: message.role, content: message.content }));
  const latest = input.findLastIndex(message => message.role === "user");
  if (latest < 0) throw new Error("web_user_message_required");
  Object.assign(input[latest], { internal_chat_message_metadata_passthrough: { turn_id: turn } });
  return { ...body, input, store: false,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: turn }) } };
}
