import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openOwnedBrowser } from "./browser-host";

const chrome = process.env.CODEX_WEB_TEST_CHROME;
test.skipIf(!chrome || !process.env.DISPLAY)("owned normal Chrome keeps session state, binds debug to loopback, and closes its process", async () => {
  const profile = mkdtempSync(join(tmpdir(), "codex-web-host-test-"));
  let owned: Awaited<ReturnType<typeof openOwnedBrowser>> | undefined;
  try {
    owned = await openOwnedBrowser(chrome!, profile);
    const { pid, port } = owned;
    const listeners = readFileSync("/proc/net/tcp", "utf8").split("\n")
      .map(line => line.trim().split(/\s+/)).filter(parts => parts[3] === "0A" && parseInt(parts[1]?.split(":")[1], 16) === port);
    expect(listeners.length).toBe(1);
    expect(listeners[0][1].split(":")[0]).toBe("0100007F");
    await owned.context.addCookies([{ name: "test-session", value: "retained", domain: "127.0.0.1", path: "/" }]);
    await owned.close(); await owned.close();
    expect(() => process.kill(pid, 0)).toThrow();
    owned = await openOwnedBrowser(chrome!, profile);
    expect((await owned.context.cookies("http://127.0.0.1")).find((cookie: any) => cookie.name === "test-session")?.value).toBe("retained");
    const controller = new AbortController();
    await owned.close();
    owned = await openOwnedBrowser(chrome!, profile, controller.signal);
    const abortedPid = owned.pid;
    controller.abort(); await owned.close();
    expect(() => process.kill(abortedPid, 0)).toThrow();
  } finally { await owned?.close(); rmSync(profile, { recursive: true, force: true }); }
}, 40000);

test("cancelled host never starts and missing executable fails without lingering ownership", async () => {
  const profile = mkdtempSync(join(tmpdir(), "codex-web-host-failure-"));
  try {
    const controller = new AbortController(); controller.abort();
    await expect(openOwnedBrowser("/unused", profile, controller.signal)).rejects.toThrow();
    await expect(openOwnedBrowser("/nonexistent/codex-test-browser", profile)).rejects.toThrow();
  } finally { rmSync(profile, { recursive: true, force: true }); }
});
