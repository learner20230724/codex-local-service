import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runHttpWorker } from "./http-process";

async function fixture(code: string, run: (path: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "http-worker-test-")), path = join(directory, "worker.py");
  writeFileSync(path, code);
  try { await run(path); } finally { rmSync(directory, { recursive: true, force: true }); }
}
test("worker events finish and a premature EOF cannot look successful", async () => {
  await fixture('print(\'{"type":"delta","text":"OK"}\')\nprint(\'{"type":"done"}\')', async worker => {
    const got = []; for await (const event of runHttpWorker({}, { python: "/usr/bin/python3", worker, signal: new AbortController().signal })) got.push(event);
    expect(got.map(e => e.type)).toEqual(["delta", "done"]);
  });
  await fixture('print(\'{"type":"delta","text":"partial"}\')', async worker => {
    await expect((async () => { for await (const _ of runHttpWorker({}, { python: "/usr/bin/python3", worker, signal: new AbortController().signal })) {} })()).rejects.toThrow("web_response_incomplete");
  });
});
test("client cancellation terminates a silent worker instead of keeping the slot busy", async () => {
  await fixture('import time\ntime.sleep(60)', async worker => {
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 80);
    const start = Date.now();
    try {
      await expect((async () => { for await (const _ of runHttpWorker({}, { python: "/usr/bin/python3", worker, signal: abort.signal })) {} })()).rejects.toThrow("web_cancelled");
      expect(Date.now()-start).toBeLessThan(2500);
    } finally { clearTimeout(timer); }
  });
});
test("deadline terminates workers and missing executable produces a controlled error", async () => {
  await fixture('import time\ntime.sleep(60)', async worker => {
    await expect((async () => { for await (const _ of runHttpWorker({}, { python: "/usr/bin/python3", worker, signal: new AbortController().signal, timeoutMs: 60 })) {} })()).rejects.toThrow("web_timeout");
  });
  await expect((async () => { for await (const _ of runHttpWorker({}, { python: "/missing/python", worker: "missing", signal: new AbortController().signal })) {} })()).rejects.toThrow("web_worker_unavailable");
});
