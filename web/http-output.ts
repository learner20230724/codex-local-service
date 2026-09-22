import { emptySearch, searchCompletionEvents } from "../upstream/src/adapter/search";

/** Keep the assistant at output[0] for existing consumers. */
export function httpResult(id: string, created: number, text: string, effort: string, done: any = {}) {
  return { id, object: "response", created_at: created, status: "completed", model: "chatgpt-web/gpt-6-astra", store: false,
    output_text: text, search: done.search || emptySearch(),
    output: [{ id: `msg_${id}`, type: "message", role: "assistant", status: "completed", phase: "final_answer",
      content: [{ type: "output_text", text, annotations: done.annotations || [] }] }, ...(done.search_calls || [])],
    metadata: { backend: "chatgpt-web", transport: "http", upstream_model: "gpt-6-astra-wm", thinking_effort: effort },
  };
}
export function httpSearchEvents(id: string, done: any) {
  return searchCompletionEvents(done.search_calls || [], done.annotations || [], `msg_${id}`);
}
