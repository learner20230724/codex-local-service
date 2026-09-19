import { test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { ManualLogin } from "./manual-login";

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Condition did not become true");
}
function setup(verify: (signal: AbortSignal) => Promise<void>, options: { timeoutMs?: number; exits?: boolean } = {}) {
  let child: ChildProcess; let args: string[] = [];
  const login = new ManualLogin({ executable: "/unused", profile: "/private/profile", url: "https://chatgpt.com/?temporary-chat=true",
    timeoutMs: options.timeoutMs, verify, launch: supplied => {
      args = supplied;
      return child = spawn(process.execPath, ["-e", options.exits ? "setTimeout(() => process.exit(0), 50)" : "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    } });
  return { login, child: () => child!, args: () => args };
}
test("authentication browser stays uncontrolled and capture begins only after explicit finish", async () => {
  let verified = 0;
  const s = setup(async () => { expect(s.child().signalCode !== null || s.child().exitCode !== null).toBe(true); verified++; });
  try {
    await s.login.start(); expect(s.login.state).toBe("waiting_for_login");
    expect(verified).toBe(0); expect(s.args().join(" ")).not.toMatch(/remote-debugging|enable-automation|headless|no-sandbox|disable-blink/);
    await s.login.finish(); expect(verified).toBe(1); expect(s.login.state).toBe("ready");
  } finally { await s.login.stop(); }
});
test("closing the dedicated browser cleanly starts verification", async () => {
  let verified = 0; const s = setup(async () => { verified++; }, { exits: true });
  try { await s.login.start(); await until(() => s.login.state === "ready"); expect(verified).toBe(1); }
  finally { await s.login.stop(); }
});
test("login expiry closes the owned browser without importing an unfinished login", async () => {
  let verified = 0; const s = setup(async () => { verified++; }, { timeoutMs: 20 });
  try {
    await s.login.start(); await until(() => s.login.state === "expired" && s.child().signalCode !== null);
    expect(verified).toBe(0); expect(s.login.active).toBe(false);
  } finally { await s.login.stop(); }
});
test("cancelling verification cannot later publish ready", async () => {
  let started = false;
  const s = setup(async signal => { started = true; await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })); });
  await s.login.start(); const finish = s.login.finish();
  await until(() => started); await s.login.stop(); await finish;
  expect(s.login.state).toBe("idle"); expect(s.login.active).toBe(false);
});
test("missing browser returns a recoverable failure", async () => {
  const login = new ManualLogin({ executable: "/nonexistent/codex-test-browser", profile: "/private/profile",
    url: "https://chatgpt.com/", verify: async () => { throw new Error("must not verify"); } });
  await expect(login.start()).rejects.toThrow("login_browser_start_failed");
  expect(login.state).toBe("failed"); expect(login.active).toBe(false);
});
