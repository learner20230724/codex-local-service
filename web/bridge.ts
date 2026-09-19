/** Private single-slot browser-only service. No Codex login/configuration or native tools. */
import { readFileSync, mkdirSync } from "node:fs";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { join } from "node:path";
import { chromium } from "../.runtime/web/node_modules/playwright-core/index.mjs";
import { defaultConfig, atomicWriteFile } from "../.runtime/web/src/config";
import { responseRequest } from "../.runtime/web/src/server";
import { browserLoginStateExists, loginVerificationMarkerPath, storedBrowserLoginCapabilities } from "../.runtime/web/src/browser-login";
import { detectChatGptAccountCapabilities, CHATGPT_TEMPORARY_CHAT_URL } from "../.runtime/web/src/chatgpt-session";
import { closeChatGptBrowserWorkers, dismissChatGptTemporaryChatOnboarding } from "../.runtime/web/src/adapters/chatgpt-web/browser-worker";
import { chatGptTurnSessions } from "../.runtime/web/src/adapters/chatgpt-web/turn-execution";
import { ensureUnpersonalized } from "./privacy";

const client = JSON.parse(readFileSync("/etc/codex-proxy/client.json", "utf8"));
const key = readFileSync(client.api_key_file, "utf8").trim();
const stateDir = process.env.CODEX_CHATGPT_WEB_HOME || "/var/lib/codex-proxy/web";
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const config = { ...defaultConfig("browser-only"),
  chromeExecutablePath: process.env.CODEX_WEB_CHROME || "/opt/codex-proxy-web/bin/chrome",
  storageStatePath: join(stateDir, "browser", "storage-state.json"),
  headed: true, mode: "browser-only" as const, browserHost: "managed-chrome" as const,
  autoApproveToolCalls: false, experimentalBiggerContext: false, experimentalSkillAttachments: false,
};
let busy = false; let loginContext: any; let loginState = "idle"; let loginError: string | null = null;
let loginDeadline = 0; let completed = 0;
const error = (status: number, code: string) => Response.json({ error: { code, message: code } }, { status });
function authorized(req: Request): boolean {
  const actual = Buffer.from(req.headers.get("authorization") || ""); const expected = Buffer.from(`Bearer ${key}`);
  return !req.headers.has("origin") && actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function closeLogin() { const context = loginContext; loginContext = undefined; if (context) await context.close().catch(() => {}); }
async function monitorLogin(context: any) {
  while (loginContext === context && Date.now() < loginDeadline) {
    try {
      const page = context.pages().find((p: any) => p.url().startsWith("https://chatgpt.com"));
      if (page) {
        const authenticated = await page.evaluate(async () => {
          try { const r = await fetch("/api/auth/session"); const session = await r.json(); return !!session.user && !!session.accessToken; }
          catch { return false; }
        });
        if (authenticated) {
          loginState = "verifying";
          if (page.url() !== CHATGPT_TEMPORARY_CHAT_URL) await page.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
          await page.locator('#prompt-textarea,[data-testid="prompt-textarea"]').first().waitFor({ state: "visible", timeout: 30000 });
          await dismissChatGptTemporaryChatOnboarding(page);
          await ensureUnpersonalized(page);
          const capabilities = await detectChatGptAccountCapabilities(page);
          mkdirSync(join(stateDir, "browser"), { recursive: true, mode: 0o700 });
          atomicWriteFile(config.storageStatePath, JSON.stringify(await context.storageState()));
          atomicWriteFile(loginVerificationMarkerPath(config.storageStatePath), JSON.stringify({ version: 1, authenticated: true,
            verifiedAt: new Date().toISOString(), ...capabilities, unpersonalized: true }));
          loginState = "ready"; loginError = null; await closeLogin(); console.info("Web login verified; Temporary Chat only."); return;
        }
      }
    } catch { loginError = "login_or_privacy_verification_pending"; }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  if (loginContext === context) { await closeLogin(); loginState = "expired"; }
}
async function startLogin() {
  if (busy) throw new Error("web_busy");
  if (loginContext || loginState === "starting") return;
  loginState = "starting"; loginError = null;
  await closeChatGptBrowserWorkers();
  loginContext = await chromium.launchPersistentContext(join(stateDir, "login-profile"), {
    executablePath: config.chromeExecutablePath, headless: false, viewport: { width: 1280, height: 800 },
    locale: "en-US", args: ["--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage"],
  });
  const page = loginContext.pages()[0] || await loginContext.newPage();
  loginDeadline = Date.now() + 30 * 60000; loginState = "waiting_for_login";
  void page.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => { loginError = "login_navigation_failed"; });
  void monitorLogin(loginContext);
}
async function cleanupTurn() {
  try { chatGptTurnSessions.clear(); await closeChatGptBrowserWorkers(); }
  finally { busy = false; }
}
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.CODEX_WEB_PORT || 3468), idleTimeout: 0,
  async fetch(req) {
    if (!authorized(req)) return error(401, "local_auth_required");
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path === "/health") return Response.json({ status: "ok", backend: "web", mode: "browser-only",
      ready: browserLoginStateExists(config) && !loginContext && loginState !== "starting", login_required: !browserLoginStateExists(config),
      login_state: loginState, login_error: loginError, login_expires_at: loginContext ? loginDeadline : null,
      busy, concurrency: 1, finished_requests: completed, pid: process.pid, memory: process.memoryUsage(),
      capabilities: storedBrowserLoginCapabilities(config), temporary_chat: true, personalization: false });
    if (req.method === "POST" && path === "/login/start") {
      try { await startLogin(); return Response.json({ state: loginState, expires_at: loginDeadline }); }
      catch { loginState = "failed"; return error(503, "web_login_start_failed"); }
    }
    if (req.method === "POST" && path === "/login/stop") { await closeLogin(); loginState = "idle"; return Response.json({ ok: true }); }
    if (req.method !== "POST" || path !== "/v1/responses") return error(404, "not_found");
    if (busy || loginContext || loginState === "starting") return error(503, "web_busy");
    if (!browserLoginStateExists(config)) return error(503, "web_login_required");
    let body: any;
    try { body = await req.json(); } catch { return error(400, "invalid_json"); }
    if (!/^chatgpt-web\/(light|medium|high|extra-high|pro|luna|think)$/.test(body.model || "")
      || body.tools?.length || body.previous_response_id) return error(400, "unsupported_web_request");
    busy = true;
    let cleaning: Promise<void> | undefined;
    const finish = () => cleaning ??= cleanupTurn();
    Object.assign(config, storedBrowserLoginCapabilities(config));
    const thread = randomUUID(); const turn = randomUUID();
    body.client_metadata = { "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: turn }) };
    body.store = false;
    try {
      const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
        method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, signal: req.signal,
      }), config, undefined, { rememberState: false });
      if (!body.stream || !response.body) { await finish(); completed++; return response; }
      const reader = response.body.getReader();
      return new Response(new ReadableStream({
        async pull(controller) {
          try {
            const { value, done } = await reader.read();
            if (done) { await finish(); completed++; controller.close(); }
            else controller.enqueue(value);
          } catch { await finish(); controller.error(new Error("web_stream_failed")); }
        },
        async cancel() { await reader.cancel().catch(() => {}); await finish(); },
      }), { status: response.status, headers: response.headers });
    } catch { await finish(); return error(502, "web_turn_failed"); }
  },
});
process.on("SIGTERM", async () => { server.stop(true); await closeLogin(); await cleanupTurn(); process.exit(0); });
console.info(`Codex web bridge listening on 127.0.0.1:${server.port}; single browser task, temporary/unpersonalized.`);
