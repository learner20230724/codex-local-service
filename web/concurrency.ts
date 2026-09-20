import { readFileSync } from "node:fs";

/** Shared routing file keeps gateway and HTTP worker limits in sync without a restart. */
export function httpConcurrency(file = process.env.CODEX_PROXY_ROUTING_FILE || "/etc/codex-proxy/routing.json"): number {
  try {
    const n = JSON.parse(readFileSync(file, "utf8")).web_concurrency;
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 1;
  } catch { return 1; }
}
