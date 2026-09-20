import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { httpConcurrency } from "./concurrency";

test("HTTP concurrency reloads shared settings and defaults safely on missing/invalid settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-concurrency-")), file = join(dir, "routing.json");
  try {
    expect(httpConcurrency(file)).toBe(1);
    for (const n of [1, 3, 5, 2]) { writeFileSync(file, JSON.stringify({ web_concurrency: n })); expect(httpConcurrency(file)).toBe(n); }
    for (const n of [0, 6, 1.5, "5", null]) { writeFileSync(file, JSON.stringify({ web_concurrency: n })); expect(httpConcurrency(file)).toBe(1); }
    writeFileSync(file, "broken"); expect(httpConcurrency(file)).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
