import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class HttpWebError extends Error {
  constructor(public code: string, public status = 502) { super(code); }
}

/** Each request owns one killable worker; credentials never appear in argv or IPC. */
export async function* runHttpWorker(body: any, options: {
  python: string; worker: string; signal: AbortSignal; timeoutMs?: number;
}): AsyncGenerator<any> {
  options.signal.throwIfAborted();
  const child = spawn(options.python, [options.worker], { stdio: ["pipe", "pipe", "ignore"], env: process.env });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let spawnFailed = false, timedOut = false;
  child.on("error", () => { spawnFailed = true; lines.close(); });
  const exited = new Promise<void>(resolve => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
  let force: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM"); force ??= setTimeout(() => child.kill("SIGKILL"), 1500);
  };
  const timeout = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 115000);
  options.signal.addEventListener("abort", stop, { once: true });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(body) + "\n");
  let done = false;
  try {
    for await (const line of lines) {
      if (options.signal.aborted) throw new HttpWebError("web_cancelled", 499);
      if (timedOut) throw new HttpWebError("web_timeout", 504);
      if (line.length > 8 * 1024 * 1024) throw new HttpWebError("web_event_too_large");
      let event: any;
      try { event = JSON.parse(line); } catch { throw new HttpWebError("web_invalid_worker_event"); }
      if (event.type === "error") throw new HttpWebError(/^[a-z0-9_]+$/.test(event.code) ? event.code : "web_transport_failed",
        [400, 429, 499, 502, 503, 504].includes(event.status) ? event.status : 502);
      if (event.type === "delta" && typeof event.text === "string") yield event;
      else if (event.type === "done") { done = true; yield event; break; }
      else throw new HttpWebError("web_invalid_worker_event");
    }
    if (!done) throw new HttpWebError(options.signal.aborted ? "web_cancelled" : timedOut ? "web_timeout" : spawnFailed ? "web_worker_unavailable" : "web_response_incomplete");
  } finally {
    clearTimeout(timeout); options.signal.removeEventListener("abort", stop); lines.close(); stop();
    await exited; if (force) clearTimeout(force);
  }
}
