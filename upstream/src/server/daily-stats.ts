/** Daily aggregate counters only: never persist prompts, responses, headers or account data. */
import { Router, type Request, type Response, type NextFunction } from "express";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TokenUsageBreakdown } from "../types/codex.js";

type Backend = "web" | "codex" | "unrouted";
type Outcome = "succeeded" | "failed" | "cancelled";
interface Tokens { requests: number; input: number; output: number; cached_input: number; reasoning_output: number }
interface Bucket {
  requests: number; succeeded: number; failed: number; cancelled: number; fallbacks: number; web_attempts: number;
  reported_tokens: Tokens; estimated_tokens: Tokens; unknown_usage_requests: number;
}
interface Day { date: string; totals: Bucket; backends: Record<Backend, Bucket> }
interface State { backend: Backend; fallback: boolean; webAttempt: boolean; completed: boolean; usage?: TokenUsageBreakdown; estimated?: boolean }
interface RecordEntry extends State { at: Date; outcome: Outcome }
const tokens = (): Tokens => ({ requests: 0, input: 0, output: 0, cached_input: 0, reasoning_output: 0 });
const bucket = (): Bucket => ({ requests: 0, succeeded: 0, failed: 0, cancelled: 0, fallbacks: 0, web_attempts: 0,
  reported_tokens: tokens(), estimated_tokens: tokens(), unknown_usage_requests: 0 });
const emptyDay = (date: string): Day => ({ date, totals: bucket(), backends: { web: bucket(), codex: bucket(), unrouted: bucket() } });
export const statsDate = (date: Date): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(date);
const validCount = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const validDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
function validBucket(value: any): boolean {
  return value && Object.keys(bucket()).every(k => k.endsWith("_tokens")
    ? value[k] && Object.keys(tokens()).every(t => validCount(value[k][t])) : validCount(value[k]));
}
function increment(target: Bucket, entry: RecordEntry) {
  target.requests++; target[entry.outcome]++;
  if (entry.fallback) target.fallbacks++;
  if (entry.webAttempt) target.web_attempts++;
  const usage = entry.usage;
  if (!usage) { target.unknown_usage_requests++; return; }
  const out = entry.estimated ? target.estimated_tokens : target.reported_tokens;
  out.requests++; out.input += usage.inputTokens; out.output += usage.outputTokens;
  out.cached_input += usage.cachedInputTokens; out.reasoning_output += usage.reasoningOutputTokens;
}

export class DailyStats {
  private data: { version: number; tracking_since: string; days: Record<string, Day> };
  private loadFailed = false;
  private persistenceError: string | null = null;
  active = 0;
  constructor(private file?: string, now = new Date()) {
    this.data = { version: 1, tracking_since: now.toISOString(), days: {} };
    if (!file) return;
    try {
      const value = JSON.parse(readFileSync(file, "utf8"));
      if (value.version !== 1 || !Number.isFinite(Date.parse(value.tracking_since)) || !value.days || Array.isArray(value.days)
          || !Object.entries(value.days).every(([date, d]: [string, any]) => validDate(date) && d.date === date
            && validBucket(d.totals) && ["web", "codex", "unrouted"].every(b => validBucket(d.backends?.[b])))) throw new Error("invalid_stats");
      this.data = value;
    } catch (error: any) {
      if (error.code !== "ENOENT") { this.loadFailed = true; this.persistenceError = "stats_load_failed"; }
      else this.persist();
    }
  }
  private persist() {
    if (!this.file || this.loadFailed) return;
    const temporary = `${this.file}.${process.pid}.tmp`;
    let fd: number | undefined;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      fd = openSync(temporary, "w", 0o600);
      writeFileSync(fd, JSON.stringify(this.data) + "\n"); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, this.file);
      this.persistenceError = null;
    } catch {
      this.persistenceError = "stats_write_failed";
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch { /* already renamed or never created */ }
    }
  }
  record(entry: RecordEntry) {
    const date = statsDate(entry.at);
    const day = this.data.days[date] ??= emptyDay(date);
    increment(day.totals, entry); increment(day.backends[entry.backend], entry);
    this.persist();
  }
  summary(days = 1, date = statsDate(new Date())) {
    const rows: Day[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const key = new Date(Date.parse(date) - i * 86400000).toISOString().slice(0, 10);
      rows.push(this.data.days[key] || emptyDay(key));
    }
    return { timezone: "Asia/Shanghai", tracking_since: this.data.tracking_since, active_requests: this.active,
      persistence: this.persistenceError ? "unavailable" : this.file ? "file" : "memory", persistence_error: this.persistenceError,
      days: rows };
  }
  middleware = (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "POST" || !/^\/(v1\/)?(chat\/completions|responses)$/.test(req.path)) { next(); return; }
    const at = new Date(); let recorded = false;
    const state: State = { backend: "unrouted", fallback: false, webAttempt: false, completed: false };
    res.locals.dailyStats = state; this.active++;
    const finish = (closed: boolean) => {
      if (recorded) return;
      recorded = true; this.active--;
      this.record({ ...state, at, outcome: closed ? "cancelled" : state.completed && res.statusCode < 400 ? "succeeded" : "failed" });
    };
    res.once("finish", () => finish(false)); res.once("close", () => finish(!res.writableFinished));
    next();
  };
  router() {
    const router = Router();
    router.get("/stats", (req, res) => {
      const days = req.query.days === undefined ? 1 : Number(req.query.days);
      const date = req.query.date === undefined ? statsDate(new Date()) : String(req.query.date);
      if (!Number.isInteger(days) || days < 1 || days > 366 || !validDate(date)
          || (req.query.days !== undefined && typeof req.query.days !== "string")
          || (req.query.date !== undefined && typeof req.query.date !== "string")) {
        res.status(400).json({ error: { code: "invalid_stats_range" } }); return;
      }
      const result = this.summary(days, date);
      res.status(result.persistence_error ? 503 : 200).json(result);
    });
    return router;
  }
}

export function selectStatsBackend(res: Response, backend: Backend, fallback = false) {
  const state: State | undefined = res.locals.dailyStats;
  if (state) { state.backend = backend; state.fallback ||= fallback; }
}
export function markWebAttempt(res: Response) {
  const state: State | undefined = res.locals.dailyStats;
  if (state) state.webAttempt = true;
}
export function completeStats(res: Response, usage?: TokenUsageBreakdown | null, estimated = false) {
  const state: State | undefined = res.locals.dailyStats;
  if (!state) return;
  state.completed = true;
  if (usage && [usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, usage.reasoningOutputTokens].every(validCount)) {
    state.usage = usage; state.estimated = estimated;
  }
}

/** A lightweight visible-text estimate, not a model tokenizer or quota measurement. */
export function webTextUsage(body: any, text: string): TokenUsageBreakdown {
  const content = (v: any): string => typeof v === "string" ? v : Array.isArray(v)
    ? v.map(part => typeof part?.text === "string" ? part.text : "").join("\n") : "";
  const source = body.messages ?? body.input;
  const input = [body.instructions || "", typeof source === "string" ? source
    : (Array.isArray(source) ? source.map(m => content(m?.content)).join("\n") : "")].join("\n");
  const estimate = (value: string) => {
    const s = value.trim(); if (!s) return 0;
    const cjk = (s.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
    return Math.max(1, Math.ceil(cjk + (s.length - cjk) / 4), Math.ceil(s.split(/\s+/).length * 1.33));
  };
  const inputTokens = estimate(input), outputTokens = estimate(text);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cachedInputTokens: 0, reasoningOutputTokens: 0 };
}
