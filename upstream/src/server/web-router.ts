import { chatAnnotations, responseAnnotations, emptySearch } from "../adapter/search.js";
/** Web-first inference routing. Never retry after emitting a response to the caller. */
import { Router, type Response as ExpressResponse } from "express";
import { readFileSync, writeFileSync, renameSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { CONFIG } from "./config.js";
import { completeStats, markWebAttempt, selectStatsBackend, webTextUsage } from "./daily-stats.js";

export type Mode = "auto" | "web" | "codex";
export interface RoutingSettings {
  mode: Mode;
  web_base_url: string;
  web_model: string;
  web_timeout_ms: number;
  cooldown_seconds: number;
  default_reasoning_effort?: string;
  web_concurrency?: number;
}
const defaults: RoutingSettings = {
  mode: "codex", web_base_url: "http://127.0.0.1:3468", web_model: "chatgpt-web/light",
  web_timeout_ms: 120000, cooldown_seconds: 60, web_concurrency: 1,
};
function settings(): RoutingSettings {
  const file = process.env.CODEX_PROXY_ROUTING_FILE;
  if (!file) return { ...defaults };
  const value = { ...defaults, ...JSON.parse(readFileSync(file, "utf8")) };
  const url = new URL(value.web_base_url);
  if (!["auto", "web", "codex"].includes(value.mode) || url.protocol !== "http:"
      || url.hostname !== "127.0.0.1" || url.username || url.password
      || !/^chatgpt-web\/(light|medium|high|extra-high|pro|luna|think|gpt-6-astra)$/.test(value.web_model)
      || (value.default_reasoning_effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(value.default_reasoning_effort))
      || !Number.isInteger(value.web_concurrency) || value.web_concurrency < 1 || value.web_concurrency > 5
      || !Number.isFinite(value.web_timeout_ms) || value.web_timeout_ms < 1000
      || value.web_timeout_ms > 180000 || !Number.isFinite(value.cooldown_seconds)
      || value.cooldown_seconds < 1 || value.cooldown_seconds > 3600) throw new Error("Invalid routing configuration");
  return value;
}

class WebError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
function responseError(value: any): WebError | undefined {
  if (value?.error || ["failed", "incomplete", "cancelled"].includes(value?.status)) {
    const code = value.error?.code || value.error?.type || "web_response_failed";
    return new WebError(/rate|limit|quota/.test(code) ? 429 : /auth|login/.test(code) ? 503 : 502, code);
  }
}
function compatible(body: any, chat: boolean): boolean {
  if (body.tools?.length || body.functions?.length || body.previous_response_id || body.background
      || body.n > 1 || body.audio || body.modalities?.some((v: string) => v !== "text")) return false;
  const input = chat ? body.messages : body.input;
  if (typeof input === "string") return !chat;
  return Array.isArray(input) && input.length > 0 && input.every((m: any) =>
    m && ["user", "assistant", "system", "developer"].includes(m.role) && !m.tool_calls
    && (typeof m.content === "string" || (Array.isArray(m.content) && m.content.every((c: any) =>
      c && ["text", "input_text", "output_text"].includes(c.type) && typeof c.text === "string"))));
}
export function toWebRequest(body: any, chat: boolean, model: string): any {
  const input = chat ? body.messages.map((m: any) => ({ type: "message", role: m.role,
    content: typeof m.content === "string" ? m.content : m.content.map((c: any) => ({ type: "input_text", text: c.text })) })) : body.input;
  const result: any = { model, input, stream: !!body.stream, store: false };
  if (model === "chatgpt-web/gpt-6-astra") result.reasoning = { effort: body.reasoning_effort || body.reasoning?.effort || "low" };
  if (body.instructions) result.instructions = body.instructions;
  if (body.max_output_tokens || body.max_completion_tokens || body.max_tokens)
    result.max_output_tokens = body.max_output_tokens || body.max_completion_tokens || body.max_tokens;
  const format = chat ? body.response_format : body.text?.format;
  if (format) result.text = { format: format.type === "json_schema" && format.json_schema
    ? { type: "json_schema", ...format.json_schema } : format };
  return result;
}
function textOf(value: any): string {
  return (value.output || []).filter((x: any) => x.type === "message" && x.role === "assistant"
    && (!x.phase || x.phase === "final_answer"))
    .flatMap((x: any) => x.content || []).filter((x: any) => x.type === "output_text")
    .map((x: any) => x.text).join("");
}
function recordWebCompletion(res: ExpressResponse, body: any, value: any) {
  const usage = value.usage;
  if (usage && Number.isSafeInteger(usage.input_tokens) && Number.isSafeInteger(usage.output_tokens)
      && usage.input_tokens >= 0 && usage.output_tokens >= 0 && usage.input_tokens + usage.output_tokens > 0) {
    completeStats(res, { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
      totalTokens: usage.input_tokens + usage.output_tokens, cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
      reasoningOutputTokens: usage.output_tokens_details?.reasoning_tokens ?? 0 }, usage.estimated === true);
  } else completeStats(res, webTextUsage(body, textOf(value)), true);
}
function chatUsage(usage: any): any {
  return { prompt_tokens: usage?.input_tokens ?? 0, completion_tokens: usage?.output_tokens ?? 0,
    total_tokens: usage?.total_tokens ?? 0 };
}
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, "\n");
      if (buffer.length > 8 * 1024 * 1024) throw new WebError(502, "web_event_too_large");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (data && data !== "[DONE]") yield JSON.parse(data);
      }
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function writeEvent(res: ExpressResponse, event: any): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export function createWebRouter(deps: { readSettings?: () => RoutingSettings; fetch?: typeof fetch } = {}) {
  const router = Router(); const read = deps.readSettings || settings; const request = deps.fetch || fetch;
  let active = 0; let cooldownUntil = 0; let lastError: string | null = null; let failureVersion = 0;
  const counts = { web: 0, codex: 0, fallbacks: 0 };
  const status = () => { const cfg = read(); return { ...cfg, web_concurrency: cfg.web_concurrency ?? 1,
    web_active: active, web_busy: active >= (cfg.web_concurrency ?? 1), cooldown_until: cooldownUntil || null, last_error: lastError, requests: { ...counts } }; };
  router.get("/routing", (_req, res) => { try { res.json(status()); } catch { res.status(503).json({ error: { code: "routing_config_invalid" } }); } });
  router.put("/routing", (req, res) => {
    const { mode, web_concurrency } = req.body || {};
    if (!process.env.CODEX_PROXY_ROUTING_FILE || (mode === undefined && web_concurrency === undefined)
        || (mode !== undefined && !["auto", "web", "codex"].includes(mode))
        || (web_concurrency !== undefined && (!Number.isInteger(web_concurrency) || web_concurrency < 1 || web_concurrency > 5))) {
      res.status(400).json({ error: { code: "invalid_routing_settings" } }); return;
    }
    try {
      const file = realpathSync(process.env.CODEX_PROXY_ROUTING_FILE); const value = { ...read(),
        ...(mode !== undefined ? { mode } : {}), ...(web_concurrency !== undefined ? { web_concurrency } : {}) };
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); renameSync(temp, file);
      if (mode !== undefined) { cooldownUntil = 0; lastError = null; failureVersion++; }
      res.json(status());
    } catch { res.status(503).json({ error: { code: "routing_config_write_failed" } }); }
  });
  router.post(["/v1/chat/completions", "/chat/completions", "/v1/responses", "/responses"], async (req, res, next) => {
    const started = Date.now(); let cfg: RoutingSettings;
    try { cfg = read(); } catch { res.status(503).json({ error: { code: "routing_config_invalid" } }); return; }
    const mode = (req.header("X-Codex-Proxy-Backend") || cfg.mode) as Mode;
    if (!["auto", "web", "codex"].includes(mode)) { res.status(400).json({ error: { code: "invalid_backend" } }); return; }
    const body = req.body; const chat = req.path.endsWith("/chat/completions");
    if (body?.model !== undefined && typeof body.model !== "string") { res.status(400).json({ error: { code: "invalid_model" } }); return; }
    // This deployment preference applies to the default model on either backend;
    // an explicit caller effort or different native model retains its own semantics.
    if (body && cfg.default_reasoning_effort && (!body.model || body.model === CONFIG.defaultModel || body.model === "chatgpt-web/gpt-6-astra")
        && !body.reasoning_effort && !body.reasoning?.effort) {
      if (chat) body.reasoning_effort = cfg.default_reasoning_effort;
      else body.reasoning = { ...body.reasoning, effort: cfg.default_reasoning_effort };
    }
    const fallback = (reason?: string) => {
      if (res.destroyed) return;
      counts.codex++; if (reason) counts.fallbacks++;
      selectStatsBackend(res, "codex", Boolean(reason));
      res.setHeader("X-Codex-Proxy-Backend", "codex");
      if (reason) res.setHeader("X-Codex-Proxy-Fallback", reason.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100));
      res.locals.codexTimeoutMs = Math.max(1000, CONFIG.defaultTimeoutMs - (Date.now() - started));
      next();
    };
    if (mode === "codex") { fallback(); return; }
    if (mode === "auto" && body?.model && body.model !== CONFIG.defaultModel && !body.model.startsWith("chatgpt-web/")) {
      fallback("explicit_codex_model"); return;
    }
    // Explicit web model names are never silently sent to a different backend.
    const explicitWebModel = typeof body?.model === "string" && body.model.startsWith("chatgpt-web/");
    const mayFallback = mode === "auto" && !explicitWebModel;
    selectStatsBackend(res, "web");
    if (!body || !compatible(body, chat)) {
      if (mayFallback) fallback("unsupported_web_request");
      else res.status(400).json({ error: { code: "unsupported_web_request", message: "Web mode accepts text history; tools and previous_response_id require Codex or full history." } });
      return;
    }
    if (active >= (cfg.web_concurrency ?? 1) || Date.now() < cooldownUntil) {
      const reason = active >= (cfg.web_concurrency ?? 1) ? "web_busy" : "web_cooldown";
      if (mayFallback) fallback(reason); else res.status(503).json({ error: { code: reason } });
      return;
    }
    active++;
    const versionAtStart = failureVersion;
    const succeeded = () => { counts.web++; if (failureVersion === versionAtStart) { lastError = null; cooldownUntil = 0; } };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), cfg.web_timeout_ms);
    const onClose = () => { if (!res.writableEnded) abort.abort(); };
    res.on("close", onClose);
    try {
      const headers = { "content-type": "application/json", authorization: `Bearer ${process.env.LEARNING_PROXY_KEY || ""}` };
      const health = await request(`${cfg.web_base_url}/health`, { headers, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2000)]) });
      if (!health.ok) throw new WebError(503, "web_unavailable");
      const state: any = await health.json();
      if (state.ready !== true) throw new WebError(503, state.login_required ? "web_login_required" : "web_not_ready");
      if (state.busy || (Number.isInteger(state.concurrency) && active > state.concurrency)) throw new WebError(503, "web_busy");
      const effort = body.reasoning_effort || body.reasoning?.effort;
      const effortModels: Record<string, string> = { none: "light", minimal: "light", low: "light", medium: "medium", high: "high", xhigh: "extra-high", max: "pro" };
      if (effort && !effortModels[effort]) throw new WebError(503, "web_effort_unavailable");
      const model = explicitWebModel ? body.model : cfg.web_model === "chatgpt-web/gpt-6-astra" ? cfg.web_model
        : effortModels[effort] ? `chatgpt-web/${effortModels[effort]}` : cfg.web_model;
      if (Array.isArray(state.supported_models) && !state.supported_models.includes(model)) throw new WebError(503, "web_model_unavailable");
      if (model !== "chatgpt-web/gpt-6-astra" && state.capabilities && ((!state.capabilities.solAvailable && !["chatgpt-web/luna", "chatgpt-web/think"].includes(model))
        || (model === "chatgpt-web/pro" && !state.capabilities.proAvailable)
        || (model === "chatgpt-web/extra-high" && !state.capabilities.extraHighAvailable))) throw new WebError(503, "web_model_unavailable");
      markWebAttempt(res);
      const upstream = await request(`${cfg.web_base_url}/v1/responses`, { method: "POST", headers,
        body: JSON.stringify(toWebRequest(body, chat, model)), signal: abort.signal });
      if (!upstream.ok) {
        const error: any = await upstream.json().catch(() => ({}));
        throw new WebError(upstream.status, error.error?.code || "web_http_error");
      }
      const commit = () => {
        res.setHeader("X-Codex-Proxy-Backend", "web");
        res.setHeader("X-Codex-Proxy-Model", model);
      };
      if (!body.stream) {
        const result: any = await upstream.json(); const error = responseError(result); if (error) throw error;
        if (result.status !== "completed") throw new WebError(502, "web_response_incomplete");
        commit(); succeeded(); recordWebCompletion(res, body, result);
        res.json(chat ? { id: result.id || `chatcmpl-${randomUUID()}`, object: "chat.completion", created: result.created_at || Math.floor(Date.now()/1000),
          model: result.model || model, choices: [{ index: 0, message: { role: "assistant", content: textOf(result), annotations: chatAnnotations(responseAnnotations(result)) }, finish_reason: "stop" }], search: result.search || emptySearch(), usage: chatUsage(result.usage) } : result);
      } else {
        if (!upstream.body) throw new WebError(502, "web_empty_stream");
        let committed = false; let completed = false; const pending: any[] = []; let pendingSize = 0;
        const id = `chatcmpl-${randomUUID()}`; const created = Math.floor(Date.now()/1000);
        const chunk = (delta: any, finish: string | null = null, usage?: any, search?: any) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model,
          choices: usage ? [] : [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage: chatUsage(usage) } : {}), ...(search ? { search } : {}) })}\n\n`);
        for await (const event of sseEvents(upstream.body)) {
          if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete")
            throw responseError(event.response || { error: event.error || event }) || new WebError(502, "web_stream_failed");
          if (event.type === "response.completed") {
            const error = responseError(event.response); if (error) throw error;
            if (event.response?.status !== "completed") throw new WebError(502, "web_response_incomplete");
          }
          const meaningful = event.type === "response.output_text.delta" || event.type === "response.refusal.delta" || event.type === "response.completed";
          if (!committed && !meaningful) {
            pendingSize += JSON.stringify(event).length;
            if (pendingSize > 1024 * 1024) throw new WebError(502, "web_prelude_too_large");
            pending.push(event); continue;
          }
          if (!committed) {
            commit(); res.setHeader("Content-Type", "text/event-stream"); res.setHeader("Cache-Control", "no-cache"); res.setHeader("X-Accel-Buffering", "no");
            committed = true;
            if (chat) chunk({ role: "assistant", content: "" }); else for (const item of pending) writeEvent(res, item);
          }
          if (!chat) writeEvent(res, event);
          else if (event.type === "response.output_text.delta") chunk({ content: event.delta });
          else if (event.type === "response.refusal.delta") chunk({ refusal: event.delta });
          if (event.type === "response.completed") {
            completed = true;
            recordWebCompletion(res, body, event.response);
            if (chat) { chunk({ annotations: chatAnnotations(responseAnnotations(event.response)) }, "stop", undefined, event.response.search || emptySearch()); if (body.stream_options?.include_usage) chunk({}, null, event.response?.usage); res.write("data: [DONE]\n\n"); }
            break;
          }
        }
        if (!completed) throw new WebError(502, "web_stream_interrupted");
        succeeded(); res.end();
      }
    } catch (error) {
      const failure = error instanceof WebError ? error : new WebError(502, abort.signal.aborted ? "web_timeout" : "web_unavailable");
      if (res.destroyed) return;
      if (failure.code !== "web_busy") {
        lastError = failure.code; cooldownUntil = Date.now() + cfg.cooldown_seconds * 1000; failureVersion++;
      }
      if (res.headersSent) {
        const payload = { error: { code: failure.code, message: "Web response interrupted; no backend switch after output." } };
        if (chat) res.write(`data: ${JSON.stringify(payload)}\n\n`);
        else writeEvent(res, { type: "error", ...payload });
        res.end();
      } else if (mayFallback && (failure.status >= 500 || [401, 403, 429].includes(failure.status))) fallback(failure.code);
      else res.status(failure.status).json({ error: { code: failure.code, message: "Web backend could not complete this request." } });
    } finally { clearTimeout(timer); res.off("close", onClose); active--; abort.abort(); }
  });
  return router;
}
