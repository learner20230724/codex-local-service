import { test, expect } from "bun:test";
import { httpResult, httpSearchEvents } from "./http-output";
test("HTTP search results preserve assistant position and carry annotations in JSON and SSE", () => {
  const done = { search: { enabled: true, performed: true, queries: ["example"], sources: [{ url: "https://example.com" }] },
    annotations: [{ type: "url_citation", url: "https://example.com", title: "Example", start_index: 0, end_index: 7 }],
    search_calls: [{ type: "web_search_call", id: "search", status: "completed", action: { type: "search", query: "example" } }] };
  const response = httpResult("r", 100, "Example", "min", done);
  expect(response.output[0].content[0].annotations).toEqual(done.annotations);
  expect(response.output[1]).toEqual(done.search_calls[0]);
  expect(response.search).toEqual(done.search);
  const events = httpSearchEvents("r", done);
  expect(events[0]).toMatchObject({ type: "response.output_text.annotation.added", item_id: "msg_r", output_index: 0, annotation: done.annotations[0] });
  expect(events.at(-1)).toMatchObject({ type: "response.output_item.done", output_index: 1, item: done.search_calls[0] });
});
test("ordinary HTTP output explicitly records no search without adding text", () => {
  const response = httpResult("r", 100, '{"ok":true}', "min");
  expect(response.search.performed).toBe(false);
  expect(response.output_text).toBe('{"ok":true}');
  expect(response.output.length).toBe(1);
});
