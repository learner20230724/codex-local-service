/** Refresh HTTP credentials from the already-bound browser session; never interact with sign-in forms. */
import { readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openOwnedBrowser } from "./browser-host";
import { ensureUnpersonalized, observePageFailures } from "./privacy";
import { sanitizeBrowserLoginStorageState } from "../.runtime/web/src/browser-login";

const cfg = JSON.parse(readFileSync("/etc/codex-proxy/web.json", "utf8"));
const root = cfg.state_dir, snapshot = join(root, "browser", "storage-state.json");
const owned = await openOwnedBrowser(cfg.login_chrome_bin || cfg.chrome_bin, join(root, "manual-login-profile"));
const writePrivate = (path: string, value: any) => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, path); chmodSync(path, 0o600);
};
try {
  // Chrome session cookies may not survive closing the last authenticated tab.
  // Restore only the existing, private ChatGPT snapshot; no Codex OAuth files are used.
  const saved = JSON.parse(readFileSync(snapshot, "utf8"));
  await owned.context.addCookies(saved.cookies.filter((c: any) => /^(\.)?(chatgpt\.com|openai\.com)$/.test(c.domain)));
  const page = await owned.context.newPage(); observePageFailures(page);
  const headers: Record<string, string> = {};
  const captured: Promise<any>[] = [];
  page.on("request", (request: any) => {
    const url = new URL(request.url());
    if (url.origin !== "https://chatgpt.com" || !url.pathname.startsWith("/backend-api/")) return;
    captured.push(request.allHeaders().then((values: any) => {
      if (!values.authorization?.startsWith("Bearer ")) return;
      for (const key of ["authorization", "user-agent", "oai-device-id", "oai-language", "oai-client-version", "oai-client-build-number", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"])
        if (values[key]) headers[key] = values[key];
    }));
  });
  const models = page.waitForResponse((response: any) => {
    const url = new URL(response.url());
    return url.origin === "https://chatgpt.com" && url.pathname === "/backend-api/models" && response.status() === 200;
  }, { timeout: 45000 }).then((response: any) => response.json()).catch(() => null);
  await page.goto("https://chatgpt.com/?temporary-chat=true", { waitUntil: "domcontentloaded", timeout: 45000 });
  const catalog = await models;
  await page.locator("#prompt-textarea").waitFor({ state: "visible", timeout: 20000 });
  await ensureUnpersonalized(page);
  await Promise.all(captured);
  if (!headers.authorization || !catalog?.models?.some((m: any) => m.slug === "gpt-6-astra-wm"))
    throw new Error("existing_web_session_unavailable");
  const cookies = await owned.context.cookies("https://chatgpt.com/");
  writePrivate(join(root, "http-session.json"), { version: 1, captured_at: new Date().toISOString(),
    headers, cookies, temporary_chat: true, personalization: false, privacy_ui_verified: true,
    supported_models: catalog.models.map((m: any) => m.slug) });
  writePrivate(snapshot, sanitizeBrowserLoginStorageState(await owned.context.storageState()));
  console.info(JSON.stringify({ refreshed: true, existing_login_reused: true, model: "gpt-6-astra-wm", temporary_chat: true, personalization: false }));
} catch {
  console.error("Existing web session could not be refreshed; stored credentials were retained.");
  process.exitCode = 1;
} finally { await owned.close(); }
