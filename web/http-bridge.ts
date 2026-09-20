/** Minimal private HTTP worker host. Browser/Playwright packages are not imported. */
import { readFileSync, statSync } from "node:fs";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { join } from "node:path";
import { HttpWebError, runHttpWorker } from "./http-process";
import { httpConcurrency } from "./concurrency";

const client = JSON.parse(readFileSync("/etc/codex-proxy/client.json", "utf8"));
const key = readFileSync(client.api_key_file, "utf8").trim();
const stateDir = process.env.CODEX_CHATGPT_WEB_HOME || "/var/lib/codex-proxy/web";
const model = "chatgpt-web/gpt-6-astra";
const worker = join(import.meta.dir, "http", "worker.py");
let active = 0, completed = 0;
const shutdown = new AbortController();
const errorResponse = (status: number, code: string) => Response.json({ error: { code, message: code } }, { status });
function authorized(req: Request) {
  const actual = Buffer.from(req.headers.get("authorization") || ""), expected = Buffer.from(`Bearer ${key}`);
  return !req.headers.has("origin") && actual.length === expected.length && timingSafeEqual(actual, expected);
}
function credentialStatus(): { ready: boolean; code?: string } {
  try {
    const path = join(stateDir, "http-session.json");
    if (statSync(path).mode & 0o077) return { ready: false, code: "web_session_permissions" };
    const state = JSON.parse(readFileSync(path, "utf8"));
    const token = state.headers?.authorization?.split(" ")[1];
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now() + 60000)
      return { ready: false, code: "web_session_expired" };
    return { ready: state.temporary_chat === true && state.personalization === false };
  } catch { return { ready: false, code: "web_session_unavailable" }; }
}
function result(id: string, created: number, text: string, effort: string) {
  return { id, object: "response", created_at: created, status: "completed", model, store: false,
    output: [{ id: `msg_${id}`, type: "message", role: "assistant", status: "completed", phase: "final_answer",
      content: [{ type: "output_text", text, annotations: [] }] }],
    metadata: { backend: "chatgpt-web", transport: "http", upstream_model: "gpt-6-astra-wm", thinking_effort: effort },
  };
}
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.CODEX_WEB_PORT || 3468),
  idleTimeout: 0, maxRequestBodySize: 2 * 1024 * 1024,
  async fetch(req) {
    if (!authorized(req)) return errorResponse(401, "local_auth_required");
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path === "/health") {
      const state = credentialStatus();
      return Response.json({ status: "ok", backend: "web", mode: "http", transport: "http", ...state,
        login_required: !state.ready, browser_required: false, busy: active >= httpConcurrency(), active_requests: active,
        concurrency: httpConcurrency(), finished_requests: completed,
        supported_models: [model], default_model: model, upstream_model: "gpt-6-astra-wm", thinking_effort: "min",
        temporary_chat: true, personalization: false, pid: process.pid, memory: process.memoryUsage() });
    }
    if (req.method !== "POST" || path !== "/v1/responses") return errorResponse(404, "not_found");
    if (active >= httpConcurrency()) return errorResponse(503, "web_busy");
    const state = credentialStatus();
    if (!state.ready) return errorResponse(503, state.code || "web_session_invalid");
    let body: any;
    try { body = await req.json(); } catch { return errorResponse(400, "invalid_json"); }
    if (!body || body.model !== model || body.tools?.length || body.previous_response_id) return errorResponse(400, "unsupported_web_request");
    // Another request can acquire the slot while this body is still arriving.
    if (active >= httpConcurrency()) return errorResponse(503, "web_busy");
    active++;
    const cancel = new AbortController();
    const signal = AbortSignal.any([req.signal, cancel.signal, shutdown.signal]);
    const events = runHttpWorker(body, { python: process.env.CODEX_WEB_HTTP_PYTHON || "/opt/codex-proxy-web/http-venv/bin/python", worker, signal });
    const id = `resp_${randomUUID()}`, created = Math.floor(Date.now()/1000);
    let text = "", effort = "min", sequence = 0, cancelled = false, itemStarted = false;
    const packet = (value: any) => new TextEncoder().encode(`event: ${value.type}\ndata: ${JSON.stringify({ ...value, sequence_number: sequence++ })}\n\n`);
    let cleaning: Promise<void> | undefined;
    const cleanup = () => cleaning ??= (async () => { cancel.abort(); await events.return(undefined).catch(() => {}); active--; })();
    if (!body.stream) {
      try {
        for await (const event of events) {
          if (event.type === "delta") text += event.text;
          else if (event.type === "done") effort = event.thinking_effort;
        }
        completed++; return Response.json(result(id, created, text, effort));
      } catch (error) { return errorResponse(error instanceof HttpWebError ? error.status : 502, error instanceof HttpWebError ? error.code : "web_transport_failed"); }
      finally { await cleanup(); }
    }
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(packet({ type: "response.created", response: { id, object: "response", created_at: created, status: "in_progress", model, output: [] } })); },
      async pull(controller) {
        try {
          const { value: event, done } = await events.next();
          if (cancelled || signal.aborted) { await cleanup(); return; }
          if (done) { await cleanup(); controller.close(); return; }
          if (event.type === "delta") {
            if (!itemStarted) {
              itemStarted = true;
              controller.enqueue(packet({ type: "response.output_item.added", output_index: 0,
                item: { id: `msg_${id}`, type: "message", role: "assistant", status: "in_progress", content: [] } }));
              controller.enqueue(packet({ type: "response.content_part.added", item_id: `msg_${id}`, output_index: 0, content_index: 0,
                part: { type: "output_text", text: "", annotations: [] } }));
            }
            text += event.text;
            controller.enqueue(packet({ type: "response.output_text.delta", item_id: `msg_${id}`, output_index: 0, content_index: 0, delta: event.text }));
          } else {
            effort = event.thinking_effort; completed++;
            controller.enqueue(packet({ type: "response.output_text.done", item_id: `msg_${id}`, output_index: 0, content_index: 0, text }));
            const response = result(id, created, text, effort);
            controller.enqueue(packet({ type: "response.content_part.done", item_id: `msg_${id}`, output_index: 0, content_index: 0,
              part: response.output[0].content[0] }));
            controller.enqueue(packet({ type: "response.output_item.done", output_index: 0, item: response.output[0] }));
            // Release the worker slot before advertising completion to a client
            // that may immediately submit its next turn.
            await cleanup();
            if (cancelled) return;
            controller.enqueue(packet({ type: "response.completed", response }));
            controller.close();
          }
        } catch (error) {
          if (cancelled || signal.aborted) { await cleanup(); return; }
          controller.enqueue(packet({ type: "response.failed", response: { id, status: "failed", error: {
            code: error instanceof HttpWebError ? error.code : "web_transport_failed", message: "Web transport failed" } } }));
          await cleanup(); controller.close();
        }
      },
      async cancel() { cancelled = true; await cleanup(); },
    }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
  },
});
process.on("SIGTERM", () => { shutdown.abort(); server.stop(true); setTimeout(() => process.exit(0), 2000); });
console.info(`Codex HTTP web bridge listening on 127.0.0.1:${server.port}; GPT-6 Astra, temporary/unpersonalized.`);
