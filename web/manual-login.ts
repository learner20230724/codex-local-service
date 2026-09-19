import { spawn, type ChildProcess } from "node:child_process";

async function stopBrowser(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await new Promise<void>((resolve, reject) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    const deadline = setTimeout(() => { cleanup(); reject(new Error("login_browser_stop_failed")); }, 10000);
    const cleanup = () => { clearTimeout(force); clearTimeout(deadline); child.off("exit", exited); };
    const exited = () => { cleanup(); resolve(); };
    child.once("exit", exited); child.kill("SIGTERM");
  });
}

/** User authentication happens in an ordinary browser with no automation or debugging connection. */
export class ManualLogin {
  state = "idle";
  error: string | null = null;
  expiresAt: number | null = null;
  private child?: ChildProcess;
  private controller?: AbortController;
  private operation?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private options: {
    executable: string; profile: string; url: string;
    verify: (signal: AbortSignal) => Promise<void>;
    timeoutMs?: number;
    launch?: (args: string[]) => ChildProcess;
  }) {}
  get active() { return ["starting", "waiting_for_login", "verifying"].includes(this.state); }
  private clearTimer() { clearTimeout(this.timer); this.timer = undefined; this.expiresAt = null; }
  async start() {
    if (this.active) return;
    this.state = "starting"; this.error = null;
    const controller = this.controller = new AbortController();
    const args = [`--user-data-dir=${this.options.profile}`, "--new-window", "--disable-background-mode",
      "--no-first-run", "--no-default-browser-check", this.options.url];
    const child = this.child = this.options.launch ? this.options.launch(args)
      : spawn(this.options.executable, args, { env: process.env, stdio: "ignore" });
    child.once("exit", (code) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (code === 0) void this.verify(controller);
      else { this.clearTimer(); this.state = "failed"; this.error = "login_browser_closed_unexpectedly"; }
    });
    try {
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      if (controller.signal.aborted || this.child !== child) return;
      this.state = "waiting_for_login";
      const timeout = this.options.timeoutMs ?? 30 * 60000;
      this.expiresAt = Date.now() + timeout;
      this.timer = setTimeout(() => { void this.stop("expired"); }, timeout);
    } catch {
      if (!controller.signal.aborted) { this.child = undefined; this.state = "failed"; this.error = "login_browser_start_failed"; }
      throw new Error("login_browser_start_failed");
    }
  }
  private verify(controller: AbortController): Promise<void> {
    this.clearTimer(); this.state = "verifying";
    this.timer = setTimeout(() => { void this.stop("expired"); }, 120000);
    this.operation = (async () => {
      try {
        await this.options.verify(controller.signal);
        if (!controller.signal.aborted) { this.state = "ready"; this.error = null; }
      } catch {
        if (!controller.signal.aborted) { this.state = "failed"; this.error = "login_or_privacy_verification_failed"; }
      } finally { if (this.controller === controller) this.clearTimer(); }
    })();
    return this.operation;
  }
  async finish() {
    if (this.state === "verifying") { await this.operation; return; }
    const child = this.child, controller = this.controller;
    if (!child || !controller || this.state !== "waiting_for_login") throw new Error("login_not_open");
    this.child = undefined; this.clearTimer(); this.state = "verifying";
    try { await stopBrowser(child); }
    catch { this.state = "failed"; this.error = "login_browser_stop_failed"; throw new Error(this.error); }
    if (!controller.signal.aborted) await this.verify(controller);
  }
  async stop(state = "idle") {
    this.controller?.abort(); this.clearTimer(); this.state = state;
    const child = this.child; this.child = undefined;
    if (child) await stopBrowser(child);
  }
}
