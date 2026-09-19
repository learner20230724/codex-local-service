import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, chmodSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "../.runtime/web/node_modules/playwright-core/index.mjs";

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await new Promise<void>((resolve, reject) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    const deadline = setTimeout(() => { cleanup(); reject(new Error("web_browser_stop_failed")); }, 10000);
    const cleanup = () => { clearTimeout(force); clearTimeout(deadline); child.off("exit", exited); };
    const exited = () => { cleanup(); resolve(); };
    child.once("exit", exited); child.kill("SIGTERM");
  });
}

/** Own the dedicated Chrome profile; attach only after manual sign-in has ended. */
export async function openOwnedBrowser(executable: string, profile: string, signal?: AbortSignal) {
  if (!profile) throw new Error("web_browser_profile_required");
  signal?.throwIfAborted();
  mkdirSync(profile, { recursive: true, mode: 0o700 }); chmodSync(profile, 0o700);
  const port = await reservePort();
  signal?.throwIfAborted();
  const child = spawn(executable, [`--user-data-dir=${profile}`, "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`, "--restore-last-session", "--disable-background-mode",
    "--no-first-run", "--no-default-browser-check", "about:blank"], { env: process.env, stdio: "ignore" });
  let browser: any;
  let closed: Promise<void> | undefined;
  const onExit = () => { child.kill("SIGTERM"); };
  const onAbort = () => { void close().catch(() => {}); };
  const close = () => closed ??= (async () => {
    signal?.removeEventListener("abort", onAbort); process.off("exit", onExit);
    try {
      if (browser?.isConnected()) {
        // Leave only an empty tab to restore, while retaining cookies and browser storage.
        const context = browser.contexts()[0];
        const idle = await context.newPage();
        for (const page of context.pages()) if (page !== idle) await page.close().catch(() => {});
        const session = await browser.newBrowserCDPSession();
        await session.send("Browser.close").catch(() => {});
        if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); child.off("exit", done); resolve(); };
          const timer = setTimeout(done, 3000); child.once("exit", done);
        });
      }
    } finally { await browser?.close().catch(() => {}); await stop(child); }
  })();
  process.once("exit", onExit); signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const endpoint = `http://127.0.0.1:${port}`;
    let available = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("web_browser_exited");
      try {
        const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) });
        if (response.ok) { available = true; break; }
      } catch { /* Startup has a bounded deadline. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!available) throw new Error("web_browser_start_timeout");
    browser = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
    signal?.throwIfAborted();
    const context = browser.contexts()[0];
    if (!context) throw new Error("web_browser_context_missing");
    const idle = await context.newPage();
    for (const page of context.pages()) if (page !== idle) await page.close();
    return { browser, context, close, pid: child.pid!, port };
  } catch (error) {
    await close();
    // A cancellation can finish closing before the CDP connection resolves.
    await browser?.close().catch(() => {});
    throw error;
  }
}
