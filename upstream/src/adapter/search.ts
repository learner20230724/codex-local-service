/** Public search metadata. Never forward raw tool output or reasoning. */
export interface Source {
  type: "url";
  url: string;
  title: string;
  provenance: "search_result" | "citation" | "opened_page" | "answer_link";
}
export interface Citation {
  [key: string]: unknown;
  type: "url_citation";
  url: string;
  title: string;
  start_index: number;
  end_index: number;
}
export interface SearchInfo {
  enabled: boolean;
  performed: boolean;
  queries: string[];
  sources: Source[];
  // The upstream protocols do not guarantee an exhaustive retrieval log.
  sources_complete: boolean;
}
export interface SearchCall {
  type: "web_search_call";
  id: string;
  status: "in_progress" | "completed";
  action: { type: "search" | "open_page" | "find_in_page"; query?: string; queries?: string[];
    url?: string; pattern?: string; sources?: Source[] };
}
export const emptySearch = (): SearchInfo => ({ enabled: true, performed: false, queries: [], sources: [], sources_complete: false });
export function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return value;
  } catch { /* Not a public URL. */ }
}
export function chatAnnotations(annotations: Citation[] = []) {
  return annotations.map(({ type, ...url_citation }) => ({ type, url_citation }));
}
export function responseAnnotations(response: any): Citation[] {
  const annotations: Citation[] = []; let offset = 0;
  for (const item of response.output || []) {
    if (item.type !== "message" || item.role !== "assistant" || (item.phase && item.phase !== "final_answer")) continue;
    for (const part of item.content || []) {
      if (part.type !== "output_text") continue;
      for (const annotation of part.annotations || []) if (annotation.type === "url_citation")
        annotations.push({ ...annotation, start_index: annotation.start_index + offset, end_index: annotation.end_index + offset });
      offset += Array.from(part.text || "").length;
    }
  }
  return annotations;
}

/** Codex exposes search actions, but some versions omit result sources entirely. */
export class CodexSearch {
  info = emptySearch();
  calls = new Map<string, SearchCall>();
  annotations: Citation[] = [];
  private refs = new Map<string, { url: string; title: string }>();

  observe(method: string, params: any) {
    if (!["item/started", "item/completed"].includes(method)) return;
    const item = params?.item;
    if (item?.type !== "webSearch" || typeof item.id !== "string") return;
    this.info.performed = true;
    const action = item.action || {};
    const type = action.type === "openPage" ? "open_page" : action.type === "findInPage" ? "find_in_page" : "search";
    const queries = [...new Set([...(Array.isArray(action.queries) ? action.queries : []), action.query,
      type === "search" ? item.query : undefined].filter((q): q is string => typeof q === "string" && !!q))];
    this.info.queries = [...new Set([...this.info.queries, ...queries])];
    const url = safeUrl(action.url);
    if (url) this.source(url, url, "opened_page");
    const resultSources = new CodexSearch();
    resultSources.results(item.results);
    for (const [key, value] of resultSources.refs) this.refs.set(key, value);
    for (const source of resultSources.info.sources) this.source(source.url, source.title, source.provenance);
    this.calls.set(item.id, { type: "web_search_call", id: item.id,
      status: method === "item/completed" ? "completed" : "in_progress",
      action: { type, ...(type === "search" ? { queries, ...(queries[0] ? { query: queries[0] } : {}) } : {}),
        ...(type === "search" ? { sources: resultSources.info.sources } : {}),
        ...(url ? { url } : {}), ...(typeof action.pattern === "string" ? { pattern: action.pattern } : {}) } });
  }
  private results(value: unknown, depth = 0) {
    if (depth > 8 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) this.results(item, depth + 1); return; }
    const row = value as Record<string, unknown>;
    const url = safeUrl(row.url);
    if (url) {
      const title = typeof row.title === "string" ? row.title : url;
      this.source(url, title, "search_result");
      if (typeof row.ref_id === "string") this.refs.set(row.ref_id, { url, title });
    }
    for (const key of ["sources", "results", "entries", "items"]) this.results(row[key], depth + 1);
  }
  private source(url: string, title: string, provenance: Source["provenance"]) {
    const existing = this.info.sources.find(s => s.url === url);
    if (!existing) this.info.sources.push({ type: "url", url, title, provenance });
    else if (provenance === "search_result") Object.assign(existing, { title, provenance });
  }
  finish(text: string) {
    // Links alone never claim a search happened. On older app-server versions,
    // answer links are the only available citation data; label that provenance.
    if (!this.info.performed) return text;
    text = text.replace(/cite([^]*)/g, (marker, refs: string) => {
      const sources = refs.split("").map(ref => this.refs.get(ref)).filter(s => s !== undefined);
      return sources.length ? sources.map(s => `[${s.title.replace(/[\\\[\]]/g, "\\$&").replace(/\n/g, " ")}](${s.url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/ /g, "%20")})`).join(" ") : marker;
    });
    for (const match of text.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s]+?)\)/g)) {
      const url = safeUrl(match[2]); if (!url) continue;
      const start = Array.from(text.slice(0, match.index)).length;
      this.annotations.push({ type: "url_citation", url, title: match[1], start_index: start,
        end_index: start + Array.from(match[0]).length });
      this.source(url, match[1], "answer_link");
    }
    return text;
  }
}

/** Append completed tool items after the message to preserve output[0] clients. */
export function searchCompletionEvents(calls: SearchCall[], annotations: Citation[], itemId: string) {
  const events: any[] = annotations.map((annotation, annotation_index) => ({ type: "response.output_text.annotation.added",
    item_id: itemId, output_index: 0, content_index: 0, annotation_index, annotation }));
  calls.forEach((item, index) => {
    const output_index = index + 1;
    events.push({ type: "response.output_item.added", output_index, item });
    if (item.status === "completed") events.push({ type: "response.web_search_call.completed", output_index, item_id: item.id });
    events.push({ type: "response.output_item.done", output_index, item });
  });
  return events;
}
