import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexSearch, chatAnnotations, searchCompletionEvents, responseAnnotations } from "../adapter/search.js";
import { turnResultToChatCompletion, turnResultToResponseObject } from "../adapter/codex-to-openai.js";
import type { TurnResult } from "../subprocess/manager.js";

test("Codex search uses real events, merges updates and only exposes source fields", () => {
  const search = new CodexSearch();
  search.observe("item/started", { item: { type: "webSearch", id: "search_1", query: "", action: null } });
  search.observe("item/completed", { item: { type: "webSearch", id: "search_1", query: "Python downloads",
    action: { type: "search", queries: ["Python downloads"] }, results: [
      { type: "text_result", title: "Python", url: "https://www.python.org/downloads/", snippet: "must not forward", encrypted: "secret" },
      { url: "javascript:alert(1)" }, { url: "https://user:password@example.com/" },
    ] } });
  const text = "😀 来源 [Python](https://www.python.org/downloads/)";
  search.finish(text);
  assert.equal(search.info.performed, true);
  assert.deepEqual(search.info.queries, ["Python downloads"]);
  assert.equal(search.calls.size, 1);
  assert.equal(search.info.sources.length, 1);
  assert.equal(search.info.sources[0].provenance, "search_result");
  assert.equal(search.calls.get("search_1")?.action.sources?.length, 1);
  assert.equal(search.annotations[0].start_index, 5);
  assert.equal(Array.from(text).slice(search.annotations[0].start_index, search.annotations[0].end_index).join(""), "[Python](https://www.python.org/downloads/)");
  assert.doesNotMatch(JSON.stringify(search), /must not forward|secret|password|javascript/);
  const events = searchCompletionEvents([...search.calls.values()], search.annotations, "msg");
  assert.equal(events[0].type, "response.output_text.annotation.added");
  assert.equal(events[1].output_index, 1);
});

test("plain answer links do not invent a search; absent result data is explicit", () => {
  const plain = new CodexSearch(); plain.finish("[Example](https://example.com)");
  assert.equal(plain.info.performed, false); assert.deepEqual(plain.info.sources, []);
  const searched = new CodexSearch();
  searched.observe("item/completed", { item: { type: "webSearch", id: "s", query: "example", results: null } });
  searched.finish("[Example](https://example.com)");
  assert.equal(searched.info.sources_complete, false);
  assert.equal(searched.info.sources[0].provenance, "answer_link");
});

test("both native formats carry search metadata and correctly shaped citations", () => {
  const search = new CodexSearch();
  search.observe("item/completed", { item: { type: "webSearch", id: "s", query: "example" } });
  const text = "[Example](https://example.com)"; search.finish(text);
  const result: TurnResult = { text, search: search.info, searchCalls: [...search.calls.values()], annotations: search.annotations,
    turnId: "t", threadId: "th", usage: null, durationMs: 0, finishReason: "stop" };
  const chat = turnResultToChatCompletion(result, "model"), response = turnResultToResponseObject(result, "model");
  assert.deepEqual(chat.search, response.search);
  assert.equal(response.output[0].type, "message");
  assert.equal(response.output[1].type, "web_search_call");
  assert.deepEqual(chat.choices[0].message.annotations, chatAnnotations(responseAnnotations(response)));
});

test("native internal references resolve to real source URLs before annotation offsets are built", () => {
  const search = new CodexSearch();
  search.observe("item/completed", { item: { type: "webSearch", id: "s", query: "example", results: [
    { url: "https://example.com", title: "Example", ref_id: "turn0search0" }] } });
  const text = search.finish("😀 引用 citeturn0search0");
  assert.equal(text, "😀 引用 [Example](https://example.com)");
  assert.equal(search.annotations[0].start_index, 5);
});
