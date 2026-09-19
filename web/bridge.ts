/** Private single-slot browser-only service. No Codex login/configuration or native tools. */
import { readFileSync, mkdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { defaultConfig, atomicWriteFile } from "../.runtime/web/src/config";
import { responseRequest } from "../.runtime/web/src/server";
import { browserLoginStateExists, loginVerificationMarkerPath, storedBrowserLoginCapabilities, sanitizeBrowserLoginStorageState } from "../.runtime/web/src/browser-login";
import { detectChatGptAccountCapabilities, CHATGPT_TEMPORARY_CHAT_URL } from "../.runtime/web/src/chatgpt-session";
import { closeChatGptBrowserWorkers, dismissChatGptTemporaryChatOnboarding } from "../.runtime/web/src/adapters/chatgpt-web/browser-worker";
import { chatGptTurnSessions } from "../.runtime/web/src/adapters/chatgpt-web/turn-execution";
import { ensureUnpersonalized, observePageFailures } from "./privacy";
import { ManualLogin } from "./manual-login";
import { prepareBrowserRequest } from "./request";
import { openOwnedBrowser } from "./browser-host";

const client = JSON.parse(readFileSync("/etc/codex-proxy/client.json", "utf8"));
const key = readFileSync(client.api_key_file, "utf8").trim();
const stateDir = process.env.CODEX_CHATGPT_WEB_HOME || "/var/lib/codex-proxy/web";
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const config = { ...defaultConfig("browser-only"),
  chromeExecutablePath: process.env.CODEX_WEB_LOGIN_CHROME || process.env.CODEX_WEB_CHROME || "/opt/codex-proxy-web/bin/chrome",
  storageStatePath: join(stateDir, "browser", "storage-state.json"),
  headed: true, mode: "browser-only" as const, browserHost: "managed-chrome" as const,
  autoApproveToolCalls: false, experimentalBiggerContext: false, experimentalSkillAttachments: false,
};
let busy = false; let completed = 0;
const loginChrome = process.env.CODEX_WEB_LOGIN_CHROME || config.chromeExecutablePath;
const loginProfile = join(stateDir, "manual-login-profile");
process.env.CODEX_WEB_BROWSER_PROFILE = loginProfile;
const error = (status: number, code: string) => Response.json({ error: { code, message: code } }, { status });
function authorized(req: Request): boolean {
  const actual = Buffer.from(req.headers.get("authorization") || ""); const expected = Buffer.from(`Bearer ${key}`);
  return !req.headers.has("origin") && actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function captureManualLogin(signal: AbortSignal) {
  const owned = await openOwnedBrowser(loginChrome, loginProfile, signal);
  const context = owned.context;
  try {
    signal.throwIfAborted();
    // Verification and inference use the same dedicated normal Chrome profile. A fresh
    // automation/incognito context can be challenged even after a successful manual login.
    const verified = await context.newPage();
    observePageFailures(verified);
    // Observe the page's own authenticated account request. An extra auth/session probe can
    // receive a 403 challenge even while the logged-in app's account APIs succeed.
    const account = verified.waitForResponse((response: any) => {
      const url = new URL(response.url());
      return url.origin === "https://chatgpt.com" && url.pathname === "/backend-api/me" && response.status() === 200;
    }, { timeout: 30000 }).then(async (response: any) => {
      const me = await response.json(); return typeof me.id === "string" && me.id.length > 0;
    }).catch(() => false);
    await verified.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await verified.locator('#prompt-textarea,[data-testid="prompt-textarea"]').first().waitFor({ state: "visible", timeout: 30000 });
    if (!await account) throw new Error("web_login_verification_failed");
    await dismissChatGptTemporaryChatOnboarding(verified);
    await ensureUnpersonalized(verified);
    const capabilities = await detectChatGptAccountCapabilities(verified, { stableAbsenceMs: 10000 });
    const freshState = sanitizeBrowserLoginStorageState(await context.storageState());
    signal.throwIfAborted();
    mkdirSync(join(stateDir, "browser"), { recursive: true, mode: 0o700 });
    atomicWriteFile(config.storageStatePath, JSON.stringify(freshState));
    atomicWriteFile(loginVerificationMarkerPath(config.storageStatePath), JSON.stringify({ version: 1, authenticated: true,
      verifiedAt: new Date().toISOString(), ...capabilities, unpersonalized: true }));
    console.info("Manual web login verified; Temporary Chat only.");
  } finally {
    await owned.close();
  }
}
const login = new ManualLogin({ executable: loginChrome, profile: loginProfile,
  url: CHATGPT_TEMPORARY_CHAT_URL, verify: captureManualLogin });
async function cleanupTurn() {
  try { chatGptTurnSessions.clear(); await closeChatGptBrowserWorkers(); }
  finally { busy = false; }
}
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.CODEX_WEB_PORT || 3468), idleTimeout: 0,
  async fetch(req) {
    if (!authorized(req)) return error(401, "local_auth_required");
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path === "/health") return Response.json({ status: "ok", backend: "web", mode: "browser-only",
      ready: browserLoginStateExists(config) && !login.active, login_required: !browserLoginStateExists(config),
      login_state: login.state, login_error: login.error, login_expires_at: login.expiresAt,
      login_method: "manual-browser", login_finish_required: login.state === "waiting_for_login",
      busy, concurrency: 1, finished_requests: completed, pid: process.pid, memory: process.memoryUsage(),
      capabilities: storedBrowserLoginCapabilities(config), temporary_chat: true, personalization: false });
    if (req.method === "POST" && path === "/login/start") {
      if (busy) return error(503, "web_busy");
      try {
        if (!login.active) await closeChatGptBrowserWorkers();
        await login.start(); return Response.json({ state: login.state, expires_at: login.expiresAt,
          instruction: "Sign in manually, then close the dedicated Chrome window or run codex-proxyctl web-login-finish." });
      } catch { return error(503, "web_login_start_failed"); }
    }
    if (req.method === "POST" && path === "/login/finish") {
      try { await login.finish(); return Response.json({ state: login.state, error: login.error }, { status: login.state === "ready" ? 200 : 503 }); }
      catch { return error(409, "web_login_not_ready_to_finish"); }
    }
    if (req.method === "POST" && path === "/login/stop") { await login.stop(); return Response.json({ ok: true }); }
    if (req.method !== "POST" || path !== "/v1/responses") return error(404, "not_found");
    if (busy || login.active) return error(503, "web_busy");
    if (!browserLoginStateExists(config)) return error(503, "web_login_required");
    let body: any;
    try { body = await req.json(); } catch { return error(400, "invalid_json"); }
    if (!/^chatgpt-web\/(light|medium|high|extra-high|pro|luna|think)$/.test(body.model || "")
      || body.tools?.length || body.previous_response_id) return error(400, "unsupported_web_request");
    try { body = prepareBrowserRequest(body); } catch { return error(400, "unsupported_web_input"); }
    busy = true;
    let cleaning: Promise<void> | undefined;
    const finish = () => cleaning ??= cleanupTurn();
    Object.assign(config, storedBrowserLoginCapabilities(config));
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
process.on("SIGTERM", async () => { server.stop(true); await login.stop(); await cleanupTurn(); process.exit(0); });
console.info(`Codex web bridge listening on 127.0.0.1:${server.port}; single browser task, temporary/unpersonalized.`);
