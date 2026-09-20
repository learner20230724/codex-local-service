import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DailyStats, completeStats, markWebAttempt, selectStatsBackend, statsDate, webTextUsage } from "../server/daily-stats.js";

const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 30, reasoningOutputTokens: 5 };
function temporary(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "codex-daily-stats-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "daily.json");
}
async function serve(t: any, stats: DailyStats) {
  const app = express(); app.use(stats.middleware); app.use(express.json()); app.use(stats.router());
  app.post(["/v1/responses", "/v1/chat/completions"], (req, res) => {
    const { scenario } = req.body;
    selectStatsBackend(res, "web"); markWebAttempt(res);
    if (scenario === "fallback") { selectStatsBackend(res, "codex", true); completeStats(res, usage); res.json({ ok: true }); }
    else if (scenario === "stream-error") { res.type("text/event-stream").write('data: {"delta":"partial"}\n\n'); res.end('data: {"error":{}}\n\n'); }
    else if (scenario === "cancel") { res.type("text/event-stream").write('data: {"delta":"partial"}\n\n'); }
    else if (scenario === "invalid") res.status(400).json({ error: "invalid" });
    else if (scenario === "unknown") { completeStats(res); res.json({ ok: true }); }
    else { completeStats(res, usage, true); completeStats(res, usage, true); res.json({ ok: true }); }
  });
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, post: (scenario: string) => fetch(base + "/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario, input: "PRIVATE_TEST_PROMPT_DO_NOT_PERSIST" }) }) };
}
test("daily stats survive recreation, use Beijing dates and keep real/estimated/unknown usage separate", t => {
  const file = temporary(t), store = new DailyStats(file, new Date("2026-09-20T12:00:00Z"));
  const entry = { backend: "web" as const, fallback: false, webAttempt: true, completed: true, outcome: "succeeded" as const, usage };
  store.record({ ...entry, at: new Date("2026-09-20T15:59:59Z"), estimated: true });
  store.record({ ...entry, at: new Date("2026-09-20T16:00:00Z"), backend: "codex", fallback: true, estimated: false });
  store.record({ ...entry, at: new Date("2026-09-20T16:00:01Z"), outcome: "failed", usage: undefined });
  const result = new DailyStats(file).summary(2, "2026-09-21");
  assert.equal(result.days[0].totals.estimated_tokens.input, 100);
  assert.equal(result.days[1].totals.reported_tokens.input, 100);
  assert.equal(result.days[1].totals.reported_tokens.reasoning_output, 5);
  assert.equal(result.days[1].totals.unknown_usage_requests, 1);
  assert.equal(result.days[1].totals.requests, 2);
  assert.equal(result.days[1].totals.fallbacks, 1);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(result.tracking_since, "2026-09-20T12:00:00.000Z");
});
test("concurrent requests count once, fallback belongs to final backend and no content is persisted", async t => {
  const file = temporary(t), stats = new DailyStats(file), server = await serve(t, stats);
  await Promise.all(Array.from({ length: 12 }, () => server.post("estimated").then(r => r.text())));
  await (await server.post("fallback")).text(); await (await server.post("unknown")).text();
  const day = stats.summary().days[0];
  assert.equal(day.totals.requests, 14); assert.equal(day.totals.succeeded, 14);
  assert.equal(day.backends.web.requests, 13); assert.equal(day.backends.codex.requests, 1);
  assert.equal(day.totals.estimated_tokens.input, 1200); assert.equal(day.totals.reported_tokens.input, 100);
  assert.equal(day.totals.unknown_usage_requests, 1); assert.equal(day.totals.web_attempts, 14);
  assert.equal(stats.active, 0);
  assert.doesNotMatch(readFileSync(file, "utf8"), /PRIVATE_TEST|prompt|scenario|Bearer/);
  assert.deepEqual(new DailyStats(file).summary().days, stats.summary().days);
});
test("HTTP 200 stream errors and client cancellation are not successful requests", async t => {
  const stats = new DailyStats(temporary(t)), server = await serve(t, stats);
  await (await server.post("stream-error")).text(); await (await server.post("invalid")).text();
  const stream = await server.post("cancel"); await stream.body!.cancel();
  for (let i = 0; i < 100 && stats.active; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const totals = stats.summary().days[0].totals;
  assert.equal(stats.active, 0); assert.equal(totals.requests, 3); assert.equal(totals.succeeded, 0);
  assert.equal(totals.failed, 2); assert.equal(totals.cancelled, 1); assert.equal(totals.unknown_usage_requests, 3);
});
test("stats reads do not count as inference, date ranges validate and malformed JSON is counted", async t => {
  const stats = new DailyStats(temporary(t)), server = await serve(t, stats);
  assert.equal((await fetch(server.base + "/stats?days=7")).status, 200);
  for (const query of ["days=0", "days=367", "days=1.5", "date=2026-02-30", "days=1&days=2"])
    assert.equal((await fetch(server.base + "/stats?" + query)).status, 400);
  assert.equal(stats.summary().days[0].totals.requests, 0);
  const r = await fetch(server.base + "/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert.equal(r.status, 400);
  assert.equal(stats.summary().days[0].backends.unrouted.failed, 1);
});
test("a corrupt stats file is reported without overwriting existing history", t => {
  const file = temporary(t); writeFileSync(file, "existing broken data");
  const store = new DailyStats(file);
  store.record({ backend: "web", fallback: false, webAttempt: true, completed: false, at: new Date(), outcome: "failed" });
  assert.equal(store.summary().persistence_error, "stats_load_failed");
  assert.equal(readFileSync(file, "utf8"), "existing broken data");
});
test("web visible-text estimates include instructions and history but never claim hidden thinking", () => {
  const short = webTextUsage({ input: "你好" }, "你好");
  const long = webTextUsage({ instructions: "请遵循这些额外说明", input: [{ role: "user", content: [{ type: "input_text", text: "你好" }] }] }, "你好");
  assert.ok(short.inputTokens > 0); assert.ok(long.inputTokens > short.inputTokens);
  assert.equal(long.reasoningOutputTokens, 0); assert.equal(long.cachedInputTokens, 0);
  assert.equal(statsDate(new Date("2026-09-20T16:00:00Z")), "2026-09-21");
});
