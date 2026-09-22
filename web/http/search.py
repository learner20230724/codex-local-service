# SPDX-License-Identifier: AGPL-3.0-only
"""Allowlisted search metadata only: no tool bodies, snippets or hidden reasoning."""
import json
import re
from urllib.parse import urlsplit


def public_url(value):
    if not isinstance(value, str) or len(value) > 16384:
        return None
    try:
        u = urlsplit(value)
        if u.scheme in ("http", "https") and u.hostname and not u.username and not u.password:
            return value
    except ValueError:
        pass
    return None


def ref_key(ref):
    if isinstance(ref, str):
        return ref
    if isinstance(ref, dict) and all(k in ref for k in ("turn_index", "ref_type", "ref_index")):
        return f"turn{ref['turn_index']}{ref['ref_type']}{ref['ref_index']}"
    return None


class Search:
    def __init__(self):
        self.performed = False
        self.last_call = None
        self.queries, self.sources, self.calls, self.refs, self.citations = [], {}, {}, {}, {}

    def source(self, row, provenance):
        if not isinstance(row, dict):
            return None
        url = public_url(row.get("url"))
        if not url:
            return None
        source = {"type": "url", "url": url, "title": str(row.get("title") or url)[:4096], "provenance": provenance}
        self.sources.setdefault(url, source)
        key = ref_key(row.get("ref_id"))
        if key:
            self.refs[key] = source
        return source

    def query(self, text):
        if isinstance(text, str) and text and text not in self.queries:
            self.queries.append(text[:16384])

    def observe(self, message):
        author = message.get("author") or {}
        if author.get("role") not in ("assistant", "tool"):
            return
        metadata = message.get("metadata") or {}
        if message.get("recipient") in ("web.run", "browser", "browser.search"):
            self.performed = True
            call_id = "ws_" + str(message.get("id", "search"))
            action = {"type": "search"}
            # Tool arguments contain the actual queries, never expose raw JSON.
            try:
                arguments = json.loads("".join(message.get("content", {}).get("parts", [])))
                queries = [q.get("q") for q in arguments.get("search_query", []) if isinstance(q, dict)]
                queries = [q for q in queries if isinstance(q, str)]
                for q in queries:
                    self.query(q)
                if queries:
                    action.update(query=queries[0], queries=queries)
                else:
                    for key, kind in (("open", "open_page"), ("find", "find_in_page")):
                        items = arguments.get(key) or []
                        if items:
                            row = items[0]
                            source = self.refs.get(ref_key(row.get("ref_id")))
                            url = public_url(row.get("ref_id")) or (source or {}).get("url")
                            action = {"type": kind}
                            if url:
                                action["url"] = url
                                self.source({"url": url}, "opened_page")
                            if isinstance(row.get("pattern"), str):
                                action["pattern"] = row["pattern"]
                            break
            except (TypeError, ValueError, AttributeError):
                pass
            self.last_call = call_id
            self.calls[call_id] = {"type": "web_search_call", "id": call_id, "status": "completed", "action": action}
        if author.get("role") == "tool" and author.get("name") in ("web.run", "browser", "browser.search"):
            self.performed = True
        for row in metadata.get("search_queries") or []:
            if isinstance(row, dict):
                self.query(row.get("q") or row.get("query"))
        current_sources = []
        for group in metadata.get("search_result_groups") or []:
            if not isinstance(group, dict):
                continue
            for row in group.get("entries") or []:
                source = self.source(row, "search_result")
                if source:
                    self.performed = True
                    current_sources.append(source)
        if current_sources and author.get("role") == "tool" and self.last_call in self.calls:
            action = self.calls[self.last_call]["action"]
            if action["type"] == "search":
                action["sources"] = list({s["url"]: s for s in current_sources}.values())
        for citation in metadata.get("content_references") or []:
            if not isinstance(citation, dict):
                continue
            rows = []
            def collect(row):
                source = self.source(row, "citation")
                if source and source["url"] not in [s["url"] for s in rows]:
                    rows.append(source)
                for extra in row.get("supporting_websites") or []:
                    if isinstance(extra, dict):
                        source = self.source(extra, "citation")
                        if source and source["url"] not in [s["url"] for s in rows]:
                            rows.append(source)
            for row in (citation.get("items") or []) + (citation.get("fallback_items") or []) + (citation.get("sources") or []):
                if isinstance(row, dict):
                    collect(row)
            if public_url(citation.get("url")):
                collect(citation)
            marker = citation.get("matched_text")
            if isinstance(marker, str) and marker.startswith("cite") and rows:
                self.citations[marker] = rows

    def render(self, text):
        annotations, pieces, cursor, length = [], [], 0, 0
        for match in re.finditer(r"cite[^]*", text):
            prefix = text[cursor:match.start()]
            pieces.append(prefix); length += len(prefix)
            sources = self.citations.get(match[0]) or [self.refs[k] for k in match[0][len("cite"):-1].split("") if k in self.refs]
            sources = list({s["url"]: s for s in sources}.values())
            if not sources:
                pieces.append(match[0]); length += len(match[0])
            for index, source in enumerate(sources):
                if index:
                    pieces.append(" "); length += 1
                title = re.sub(r"([\\\[\]])", r"\\\1", source["title"]).replace("\n", " ")
                url = source["url"].replace("(", "%28").replace(")", "%29").replace(" ", "%20")
                link = f"[{title}]({url})"
                annotations.append({"type": "url_citation", "url": source["url"], "title": source["title"],
                                    "start_index": length, "end_index": length + len(link)})
                pieces.append(link); length += len(link)
            cursor = match.end()
        pieces.append(text[cursor:])
        return "".join(pieces), annotations

    def result(self):
        sources = list(self.sources.values())
        return {"enabled": True, "performed": self.performed, "queries": self.queries,
                "sources": sources, "sources_complete": False}, list(self.calls.values())
