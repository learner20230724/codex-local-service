import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, lstatSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebRouter, type RoutingSettings, sseEvents } from "../server/web-router.js";
import { CONFIG } from "../server/config.js";

const settings: RoutingSettings = { mode: "auto", web_base_url: "http://127.0.0.1:3468", web_model: "chatgpt-web/high", web_timeout_ms: 1000, cooldown_seconds: 60 };
const prompt = { model: CONFIG.defaultModel, messages: [{ role: "user", content: "hello" }] };
const completed = { id: "resp_web", object: "response", status: "completed", model: "chatgpt-web/high", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "web answer" }] }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } };
const ok = () => Response.json({ ready: true });
function stream(events: any[]) { return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }); }
async function setup(t: any, reply: (url: string, init: any) => Promise<Response> | Response, cfg = settings) {
  const app = express(); app.use(express.json()); let codex = 0; let web = 0; const payloads: any[] = [];
  app.use(createWebRouter({ readSettings: () => cfg, fetch: (async (url: any, init: any) => {
    if (String(url).endsWith("/v1/responses")) { web++; payloads.push(JSON.parse(init.body)); }
    return reply(String(url), init);
  }) as typeof fetch }));
  app.use((_req, res) => { codex++; res.json({ source: "codex" }); });
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  return { post: (body = prompt, backend?: string, path = "/v1/chat/completions", signal?: AbortSignal) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(backend ? { "X-Codex-Proxy-Backend": backend } : {}) }, body: JSON.stringify(body),
    signal,
  }), state: async () => await (await fetch(`http://127.0.0.1:${address.port}/routing`)).json() as any,
    counts: () => ({ codex, web }), payloads };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), "condition did not become true");
}
test("web-first chat converts full history, returns actual model and usage", async t => {
  const s = await setup(t, url => url.endsWith("/health") ? ok() : Response.json(completed));
  const r = await s.post(); const data: any = await r.json();
  assert.equal(r.headers.get("x-codex-proxy-backend"), "web");
  assert.equal(data.model, "chatgpt-web/high"); assert.equal(data.choices[0].message.content, "web answer");
  assert.equal(data.usage.total_tokens, 5); assert.equal(s.payloads[0].store, false); assert.equal(s.payloads[0].input[0].content, "hello");
  assert.deepEqual(s.counts(), { codex: 0, web: 1 });
});
test("Responses JSON is preserved", async t => {
  const s = await setup(t, url => url.endsWith("/health") ? ok() : Response.json(completed));
  const r = await s.post({ model: CONFIG.defaultModel, input: "hello" } as any, undefined, "/v1/responses");
  assert.deepEqual(await r.json(), completed);
});
test("missing login falls back and cools down without a model attempt", async t => {
  let checks = 0; const s = await setup(t, () => { checks++; return Response.json({ ready: false, login_required: true }); });
  const first = await s.post(); assert.equal(first.headers.get("x-codex-proxy-fallback"), "web_login_required");
  const second = await s.post(); assert.equal(second.headers.get("x-codex-proxy-fallback"), "web_cooldown");
  assert.equal(checks, 1); assert.deepEqual(s.counts(), { codex: 2, web: 0 });
});
test("forced Codex bypasses browser entirely", async t => {
  const s = await setup(t, () => { throw new Error("must not call"); });
  assert.deepEqual(await (await s.post(prompt, "codex")).json(), { source: "codex" });
});
test("forced web and explicit web model never silently use Codex", async t => {
  const s = await setup(t, () => Response.json({ ready: false, login_required: true }));
  assert.equal((await s.post(prompt, "web")).status, 503);
  assert.equal((await s.post({ ...prompt, model: "chatgpt-web/high" })).status, 503);
  assert.equal((await s.post({ ...prompt, model: "chatgpt-web/high", tools: [{ type: "function" }] } as any)).status, 400);
  assert.equal(s.counts().codex, 0);
});
test("unsupported tools and explicitly different native model keep Codex semantics", async t => {
  const s = await setup(t, () => { throw new Error("must not call"); });
  assert.equal((await s.post({ ...prompt, tools: [{ type: "function" }] } as any)).headers.get("x-codex-proxy-fallback"), "unsupported_web_request");
  assert.equal((await s.post({ ...prompt, model: "other-native-model" })).headers.get("x-codex-proxy-fallback"), "explicit_codex_model");
  assert.equal((await s.post({ ...prompt, previous_response_id: "old" } as any, "web")).status, 400);
});
test("reasoning effort is mapped to an explicit web mode", async t => {
  const s = await setup(t, url => url.endsWith("/health") ? ok() : Response.json(completed));
  await s.post({ ...prompt, reasoning_effort: "xhigh" } as any);
  assert.equal(s.payloads[0].model, "chatgpt-web/extra-high");
});
test("GPT-6 retains its model when low effort is selected and defaults to low", async t => {
  const s = await setup(t, url => url.endsWith("/health")
    ? Response.json({ ready: true, supported_models: ["chatgpt-web/gpt-6-astra"] }) : Response.json({ ...completed, model: "chatgpt-web/gpt-6-astra" }),
    { ...settings, web_model: "chatgpt-web/gpt-6-astra", default_reasoning_effort: "low" });
  await s.post();
  await s.post({ ...prompt, reasoning_effort: "high" } as any);
  await s.post({ model: CONFIG.defaultModel, input: "hello" } as any, undefined, "/v1/responses");
  assert.deepEqual(s.payloads.map(x => x.model), Array(3).fill("chatgpt-web/gpt-6-astra"));
  assert.deepEqual(s.payloads.map(x => x.reasoning.effort), ["low", "high", "low"]);
});
test("an HTTP worker model mismatch falls back before exposing the wrong model", async t => {
  const s = await setup(t, url => url.endsWith("/health") ? ok() : stream([
    { type: "response.created" }, { type: "response.failed", response: { status: "failed", error: { code: "web_model_mismatch" } } },
  ]), { ...settings, web_model: "chatgpt-web/gpt-6-astra" });
  const r = await s.post({ ...prompt, stream: true } as any);
  assert.equal(r.headers.get("x-codex-proxy-backend"), "codex");
  assert.equal(r.headers.get("x-codex-proxy-fallback"), "web_model_mismatch");
});
test("web HTTP 429 and failed JSON fall back once", async t => {
  for (const response of [Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429 }), Response.json({ status: "failed", error: { code: "rate_limit_exceeded" } })]) {
    const s = await setup(t, url => url.endsWith("/health") ? ok() : response);
    const r = await s.post(); assert.equal(r.headers.get("x-codex-proxy-backend"), "codex"); assert.equal(s.counts().web, 1);
  }
});
test("invalid request from web is not retried on Codex", async t => {
  const s = await setup(t, url => url.endsWith("/health") ? ok() : Response.json({ error: { code: "invalid_request" } }, { status: 400 }));
  assert.equal((await s.post()).status, 400); assert.equal(s.counts().codex, 0);
});
test("SSE prelude followed by error remains eligible for fallback", async t => {
  const s = await setup(t, url => url.endsWith("/health") ? ok() : stream([
    { type: "response.created", response: { id: "r" } },
    { type: "response.failed", response: { status: "failed", error: { code: "rate_limit_exceeded" } } },
  ]));
  const r = await s.post({ ...prompt, stream: true } as any);
  assert.equal(r.headers.get("x-codex-proxy-backend"), "codex"); assert.deepEqual(await r.json(), { source: "codex" });
});
test("malformed completed SSE event is rejected before committing output", async t => {
  const s = await setup(t, url => url.endsWith("/health") ? ok() : stream([
    { type: "response.created" }, { type: "response.completed", response: { status: "failed" } },
  ]));
  const r = await s.post({ ...prompt, stream: true } as any);
  assert.equal(r.headers.get("x-codex-proxy-backend"), "codex");
  assert.deepEqual(await r.json(), { source: "codex" });
});
test("SSE converts text and usage into Chat Completions chunks", async t => {
  const s = await setup(t, url => url.endsWith("/health") ? ok() : stream([
    { type: "response.created", response: { id: "r" } }, { type: "response.output_text.delta", delta: "hello" },
    { type: "response.completed", response: completed },
  ]));
  const r = await s.post({ ...prompt, stream: true, stream_options: { include_usage: true } } as any);
  const text = await r.text(); assert.match(text, /"content":"hello"/); assert.match(text, /"total_tokens":5/); assert.match(text, /\[DONE\]/);
  assert.equal(s.counts().codex, 0);
});
test("partial answer then failure or EOF never calls Codex", async t => {
  for (const tail of [[], [{ type: "response.failed", response: { status: "failed", error: { code: "rate_limit_exceeded" } } }]]) {
    const s = await setup(t, url => url.endsWith("/health") ? ok() : stream([{ type: "response.output_text.delta", delta: "partial" }, ...tail]));
    const r = await s.post({ ...prompt, stream: true } as any); const text = await r.text();
    assert.match(text, /partial/); assert.match(text, /"error"/); assert.doesNotMatch(text, /\[DONE\]/); assert.equal(s.counts().codex, 0);
  }
});
test("Responses SSE preserves event framing", async t => {
  const s = await setup(t, url => url.endsWith("/health") ? ok() : stream([{ type: "response.created" }, { type: "response.output_text.delta", delta: "hello" }, { type: "response.completed", response: completed }]));
  const r = await s.post({ model: CONFIG.defaultModel, input: "hello", stream: true } as any, undefined, "/v1/responses");
  assert.match(await r.text(), /event: response.created/); assert.equal(s.counts().codex, 0);
});
test("single web slot sends simultaneous overflow to Codex", async t => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const s = await setup(t, async url => { if (url.endsWith("/health")) return ok(); await wait; return Response.json(completed); });
  const first = s.post();
  while (!s.counts().web) await new Promise(resolve => setTimeout(resolve, 5));
  const other = await s.post(); assert.equal(other.headers.get("x-codex-proxy-fallback"), "web_busy");
  release(); assert.equal((await first).headers.get("x-codex-proxy-backend"), "web");
});
test("web timeout cancels upstream and falls back", async t => {
  const s = await setup(t, async (url, init) => {
    if (url.endsWith("/health")) return ok();
    return await new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("cancelled"))));
  }, { ...settings, web_timeout_ms: 30 });
  const r = await s.post(); assert.equal(r.headers.get("x-codex-proxy-fallback"), "web_timeout"); assert.equal(s.counts().codex, 1);
});
test("configured web slots run together and overflow goes to Codex", async t => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const s = await setup(t, async url => { if (url.endsWith("/health")) return Response.json({ ready: true, concurrency: 3 });
    await wait; return Response.json(completed); }, { ...settings, web_concurrency: 3 });
  const running = Array.from({ length: 3 }, () => s.post());
  await until(() => s.counts().web === 3);
  assert.equal((await s.state()).web_active, 3);
  assert.equal((await s.post()).headers.get("x-codex-proxy-fallback"), "web_busy");
  release();
  assert.ok((await Promise.all(running)).every(r => r.headers.get("x-codex-proxy-backend") === "web"));
  assert.equal((await s.state()).web_active, 0);
  assert.equal((await s.state()).cooldown_until, null);
});
test("an in-flight success cannot erase a concurrent rate-limit cooldown", async t => {
  let calls = 0, release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const s = await setup(t, async url => {
    if (url.endsWith("/health")) return ok();
    if (++calls === 1) { await wait; return Response.json(completed); }
    return Response.json({ error: { code: "web_rate_limited" } }, { status: 429 });
  }, { ...settings, web_concurrency: 3 });
  const first = s.post(); await until(() => calls === 1);
  assert.equal((await s.post()).headers.get("x-codex-proxy-fallback"), "web_rate_limited");
  release(); await first;
  assert.equal((await s.post()).headers.get("x-codex-proxy-fallback"), "web_cooldown");
  assert.equal(calls, 2);
});
test("cancelling one concurrent request releases only its own slot and causes no global cooldown", async t => {
  const pending: (() => void)[] = [];
  const s = await setup(t, async (url, init) => {
    if (url.endsWith("/health")) return ok();
    await new Promise<void>((resolve, reject) => {
      pending.push(resolve); init.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
    return Response.json(completed);
  }, { ...settings, web_concurrency: 2 });
  const abort = new AbortController();
  const first = s.post(prompt, undefined, "/v1/chat/completions", abort.signal).catch(() => undefined);
  const second = s.post(); await until(() => pending.length === 2);
  abort.abort(); await first;
  for (let i = 0; i < 100 && (await s.state()).web_active !== 1; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await s.state()).web_active, 1); assert.equal((await s.state()).cooldown_until, null);
  const third = s.post(); await until(() => pending.length === 3);
  assert.equal((await s.post()).headers.get("x-codex-proxy-fallback"), "web_busy");
  pending.forEach(resolve => resolve()); await Promise.all([second, third]);
  assert.equal((await s.state()).web_active, 0);
});
test("SSE handles split Unicode bytes", async () => {
  const bytes = new TextEncoder().encode('data: {"type":"test","text":"你好"}\n\n');
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  const got = []; for await (const e of sseEvents(body)) got.push(e);
  assert.deepEqual(got, [{ type: "test", text: "你好" }]);
});
test("mode switch follows the configuration symlink and survives router recreation", async t => {
  const dir = mkdtempSync(join(tmpdir(), "codex-routing-test-"));
  const file = join(dir, "routing.json"), link = join(dir, "etc-routing.json");
  writeFileSync(file, JSON.stringify(settings), { mode: 0o600 }); symlinkSync(file, link);
  const previous = process.env.CODEX_PROXY_ROUTING_FILE;
  process.env.CODEX_PROXY_ROUTING_FILE = link;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_PROXY_ROUTING_FILE;
    else process.env.CODEX_PROXY_ROUTING_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const app = express(); app.use(express.json()); app.use(createWebRouter());
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/routing`;
  for (const mode of ["codex", "web", "auto"]) {
    const r = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
    assert.equal(r.status, 200); assert.equal((await r.json() as any).mode, mode);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).mode, mode);
    assert.equal(lstatSync(link).isSymbolicLink(), true); assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  const invalid = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: '{"mode":"invalid"}' });
  assert.equal(invalid.status, 400); assert.equal(JSON.parse(readFileSync(file, "utf8")).mode, "auto");
  for (const n of [3, 5, 1]) {
    const r = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ web_concurrency: n }) });
    assert.equal(r.status, 200); assert.equal((await r.json() as any).web_concurrency, n);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).mode, "auto");
  }
  for (const n of [0, 6, 1.5, "3"]) {
    assert.equal((await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ web_concurrency: n }) })).status, 400);
  }
  const fresh = express(); fresh.use(createWebRouter()); const restarted = createServer(fresh);
  await new Promise<void>(resolve => restarted.listen(0, "127.0.0.1", resolve));
  t.after(() => { restarted.closeAllConnections(); restarted.close(); });
  const state = await fetch(`http://127.0.0.1:${(restarted.address() as { port: number }).port}/routing`);
  assert.equal((await state.json() as any).mode, "auto");
});

test("search and citations survive JSON and SSE on both public endpoints", async t => {
  const annotation = { type: "url_citation", url: "https://example.com", title: "Example", start_index: 0, end_index: 7 };
  const result = { ...completed, search: { enabled: true, performed: true, queries: ["example"], sources: [{ type: "url", url: "https://example.com", title: "Example" }], sources_complete: false },
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Example", annotations: [annotation] }] },
      { type: "web_search_call", id: "s", status: "completed", action: { type: "search", query: "example" } }] };
  for (const streaming of [false, true]) for (const chat of [false, true]) {
    const events = [{ type: "response.created", response: { output: [] } }, { type: "response.output_text.delta", delta: "Example" },
      { type: "response.output_text.annotation.added", annotation }, { type: "response.completed", response: result }];
    const s = await setup(t, url => url.endsWith("/health") ? ok() : streaming ? stream(events) : Response.json(result));
    const r = await s.post({ ...prompt, input: "hello", stream: streaming } as any, undefined, chat ? "/v1/chat/completions" : "/v1/responses");
    if (!streaming) {
      const value: any = await r.json(); assert.deepEqual(value.search, result.search);
      assert.equal(chat ? value.choices[0].message.annotations[0].url_citation.url : value.output[0].content[0].annotations[0].url, annotation.url);
    } else {
      const frames = (await r.text()).split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
      const final = chat ? frames.find(e => e.search) : frames.find(e => e.type === "response.completed").response;
      assert.deepEqual(final.search, result.search);
      assert.equal(chat ? final.choices[0].delta.annotations[0].url_citation.url : final.output[0].content[0].annotations[0].url, annotation.url);
    }
    assert.equal(s.counts().codex, 0);
  }
});
