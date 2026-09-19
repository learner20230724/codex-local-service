# SPDX-License-Identifier: AGPL-3.0-only
"""Single-account ChatGPT HTTP transport; no browser, tools, account pool or history writes.

Request preparation follows yukkcat/chatgpt2api d58db04. WebSocket handoff framing
follows suphotP/chatgpt-api f998a6d (MIT); see README.md and UPSTREAM_NOTICE.
"""
from __future__ import annotations

import base64
import json
import os
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from curl_cffi import requests
import websocket

from pow import build_legacy_requirements_token, build_proof_token, parse_pow_resources
from turnstile import solve_turnstile_token

BASE = "https://chatgpt.com"
MODEL = "gpt-6-astra-wm"
PUBLIC_MODEL = "chatgpt-web/gpt-6-astra"
EFFORTS = {"low": "min", "medium": "standard", "high": "extended", "xhigh": "xhigh", "max": "max"}


class WebError(Exception):
    def __init__(self, code: str, status: int = 502):
        self.code, self.status = code, status
        super().__init__(code)


def load_session(path: Path) -> dict:
    try:
        if path.stat().st_mode & 0o077:
            raise WebError("web_session_permissions", 503)
        state = json.loads(path.read_text())
        auth = state.get("headers", {}).get("authorization", "")
        if not auth.startswith("Bearer ") or state.get("personalization") is not False or state.get("temporary_chat") is not True:
            raise WebError("web_session_invalid", 503)
        piece = auth.split(" ", 1)[1].split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(piece + "=" * (-len(piece) % 4)))
        if claims.get("exp", 0) <= time.time() + 60:
            raise WebError("web_session_expired", 503)
        return state
    except WebError:
        raise
    except Exception:
        raise WebError("web_session_unavailable", 503) from None


def text_content(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list) and all(isinstance(c, dict) and c.get("type") in ("text", "input_text", "output_text") and isinstance(c.get("text"), str) for c in content):
        return "\n".join(c["text"] for c in content)
    raise WebError("unsupported_web_input", 400)


def payload_for(body: dict) -> dict:
    if body.get("model") != PUBLIC_MODEL or body.get("tools") or body.get("previous_response_id") or body.get("background"):
        raise WebError("unsupported_web_request", 400)
    effort = (body.get("reasoning") or {}).get("effort", "low")
    if effort not in EFFORTS:
        raise WebError("web_effort_unavailable", 400)
    source = body.get("input")
    if isinstance(source, str):
        source = [{"role": "user", "content": source}]
    if not isinstance(source, list) or not source:
        raise WebError("unsupported_web_input", 400)
    messages = []
    def add(role, content):
        if role not in ("user", "assistant", "system", "developer"):
            raise WebError("unsupported_web_input", 400)
        messages.append({"id": str(uuid.uuid4()), "author": {"role": role},
                         "content": {"content_type": "text", "parts": [text_content(content)]}, "metadata": {}})
    if body.get("instructions"):
        add("system", body["instructions"])
    fmt = (body.get("text") or {}).get("format") or {}
    if fmt.get("type") == "json_object":
        add("system", "Return only a valid JSON object, without Markdown fences.")
    elif fmt.get("type") == "json_schema":
        add("system", "Return only JSON matching this schema, without Markdown fences: " + json.dumps(fmt.get("schema", {})))
    elif fmt.get("type") not in (None, "text"):
        raise WebError("unsupported_web_format", 400)
    for message in source:
        if not isinstance(message, dict) or message.get("tool_calls") or message.get("type", "message") != "message":
            raise WebError("unsupported_web_input", 400)
        add(message.get("role"), message.get("content"))
    if not any(m["author"]["role"] == "user" for m in messages):
        raise WebError("web_user_message_required", 400)
    return {
        "action": "next", "messages": messages, "model": MODEL, "thinking_effort": EFFORTS[effort],
        "parent_message_id": str(uuid.uuid4()), "conversation_mode": {"kind": "primary_assistant"},
        "conversation_origin": "tpp", "history_and_training_disabled": True,
        "temporary_chat_requests_personalization": False, "enable_message_followups": False,
        "force_use_sse": True, "supported_encodings": [], "system_hints": [],
        "timezone": "Asia/Shanghai", "timezone_offset_min": -480,
        "client_contextual_info": {"app_name": "chatgpt.com"},
    }


def sse_data(lines):
    data, size = [], 0
    for line in lines:
        if isinstance(line, bytes):
            line = line.decode("utf-8")
        line = line.rstrip("\r\n")
        if line.startswith("data:"):
            data.append(line[5:].lstrip()); size += len(line)
            if size > 8 * 1024 * 1024:
                raise WebError("web_event_too_large")
        elif not line and data:
            yield from decode_data("\n".join(data)); data, size = [], 0
    if data:
        yield from decode_data("\n".join(data))


def decode_data(data):
    if data == "[DONE]":
        yield {"type": "done"}
    else:
        try:
            value = json.loads(data)
        except ValueError:
            raise WebError("web_invalid_event") from None
        if not isinstance(value, dict):
            raise WebError("web_invalid_event")
        yield value


def websocket_events(item: dict, topic: str):
    for catchup in (item.get("reply") or {}).get("catchups", []):
        yield from websocket_events(catchup, topic)
    if item.get("type") != "message" or item.get("topic_id") != topic:
        return
    outer = item.get("payload") or {}
    if outer.get("type") != "conversation-turn-stream":
        return
    inner = outer.get("payload") or {}
    if inner.get("type") == "done":
        yield {"type": "done"}
    elif isinstance(inner.get("encoded_item"), str):
        yield from sse_data(inner["encoded_item"].splitlines())


class Answer:
    """Only verified final text is exposed; a silent model downgrade fails before output."""
    def __init__(self, effort: str, input_ids=()):
        self.effort, self.text, self.message_id = effort, "", None
        self.input_ids = set(input_ids)
        self.finished, self.verified = False, False

    def accept(self, event: dict) -> str:
        if event.get("error") or event.get("error_code"):
            raise WebError("web_upstream_error")
        message = event.get("message") or {}
        if message.get("id") in self.input_ids:
            return ""
        if message.get("author", {}).get("role") != "assistant" or message.get("channel") not in (None, "final"):
            return ""
        if message.get("content", {}).get("content_type") != "text" or message.get("recipient", "all") != "all":
            return ""
        metadata = message.get("metadata") or {}
        actual = metadata.get("resolved_model_slug") or metadata.get("model_slug")
        if actual != MODEL:
            raise WebError("web_model_mismatch")
        if metadata.get("thinking_effort") != self.effort:
            raise WebError("web_effort_mismatch")
        self.verified = True
        if self.message_id and self.message_id != message.get("id"):
            raise WebError("web_multiple_final_messages")
        self.message_id = message.get("id")
        parts = message.get("content", {}).get("parts", [])
        if not all(isinstance(part, str) for part in parts):
            raise WebError("unsupported_web_output")
        text = "".join(parts)
        if not text.startswith(self.text):
            raise WebError("web_non_append_output")
        delta, self.text = text[len(self.text):], text
        if message.get("status") == "finished_successfully":
            self.finished = True
        return delta

    def complete(self):
        if not self.verified or not self.finished or not self.text:
            raise WebError("web_response_incomplete")


class Transport:
    def __init__(self, state: dict, proxy: str, timeout: float = 110):
        self.deadline = time.monotonic() + timeout
        self.state, self.proxy = state, proxy
        self.headers = {**state["headers"], "origin": BASE, "referer": BASE + "/?temporary-chat=true"}
        self.session = requests.Session(impersonate="chrome", proxy=proxy or None, headers=self.headers)
        for c in state["cookies"]:
            if c["domain"].lstrip(".") in ("chatgpt.com", "openai.com"):
                self.session.cookies.set(c["name"], c["value"], domain=c["domain"], path=c["path"])

    def remaining(self, maximum=30):
        left = self.deadline - time.monotonic()
        if left <= 0:
            raise WebError("web_timeout", 504)
        return min(maximum, left)

    def request(self, method, path, **kwargs):
        headers = {"X-OpenAI-Target-Path": path, "X-OpenAI-Target-Route": path, **kwargs.pop("headers", {})}
        response = self.session.request(method, BASE + path, headers=headers, timeout=self.remaining(),
                                        allow_redirects=False, **kwargs)
        status = response.status_code
        if response.headers.get("cf-mitigated") == "challenge":
            response.close(); raise WebError("web_verification_required", 503)
        if status >= 300:
            response.close()
            raise WebError("web_rate_limited" if status == 429 else "web_auth_expired" if status == 401 else "web_upstream_http_error",
                           429 if status == 429 else 503 if status == 401 else 502)
        return response

    def requirements(self):
        homepage = self.request("GET", "/")
        try:
            scripts, build = parse_pow_resources(homepage.text)
        finally:
            homepage.close()
        agent = self.headers["user-agent"]
        initial = build_legacy_requirements_token(agent, scripts, build)
        prepared = self.request("POST", "/backend-api/sentinel/chat-requirements/prepare", json={"p": initial}).json()
        if (prepared.get("arkose") or {}).get("required"):
            raise WebError("web_verification_required", 503)
        challenge = prepared.get("proofofwork") or {}
        proof = build_proof_token(challenge.get("seed", ""), challenge.get("difficulty", ""), agent, scripts, build) if challenge.get("required") else ""
        challenge = prepared.get("turnstile") or {}
        token = solve_turnstile_token(challenge["dx"], initial) if challenge.get("required") and challenge.get("dx") else ""
        if challenge.get("required") and not token:
            raise WebError("web_verification_required", 503)
        final = self.request("POST", "/backend-api/sentinel/chat-requirements/finalize", json={
            "prepare_token": prepared.get("prepare_token", ""), "proof_token": proof, "turnstile_token": token}).json()
        if not final.get("token"):
            raise WebError("web_requirements_missing")
        headers = {"Accept": "text/event-stream", "OpenAI-Sentinel-Chat-Requirements-Token": final["token"]}
        for name, value in [("OpenAI-Sentinel-Proof-Token", proof), ("OpenAI-Sentinel-Turnstile-Token", token), ("OpenAI-Sentinel-SO-Token", final.get("so_token"))]:
            if value:
                headers[name] = value
        return headers

    def follow(self, topic):
        info = self.request("GET", "/backend-api/celsius/ws/user").json()
        url = info.get("websocket_url", "")
        parsed = urlsplit(url)
        if parsed.scheme != "wss" or parsed.hostname != "ws.chatgpt.com" or parsed.username or parsed.password:
            raise WebError("web_untrusted_stream_url")
        proxy = urlsplit(self.proxy) if self.proxy else None
        options = {"http_proxy_host": proxy.hostname, "http_proxy_port": proxy.port} if proxy else {}
        ws = websocket.create_connection(url, timeout=self.remaining(), origin=BASE,
                                         header=["User-Agent: " + self.headers["user-agent"]], **options)
        try:
            ws.send(json.dumps([{"id": 1, "command": {"type": "connect", "presence": {"type": "presence", "state": "foreground"}}},
                                {"id": 2, "command": {"type": "subscribe", "topic_id": topic, "offset": "0"}}]))
            while True:
                ws.settimeout(self.remaining())
                raw = ws.recv()
                if not raw or len(raw) > 8 * 1024 * 1024:
                    raise WebError("web_stream_interrupted")
                parsed = json.loads(raw)
                for item in parsed if isinstance(parsed, list) else [parsed]:
                    for event in websocket_events(item, topic):
                        yield event
                        if event.get("type") == "done":
                            return
        finally:
            ws.close()

    def events(self, payload):
        headers = self.requirements()
        response = self.request("POST", "/backend-api/conversation", headers=headers, json=payload, stream=True)
        topic = None
        try:
            for event in sse_data(response.iter_lines()):
                self.remaining()
                if event.get("type") == "stream_handoff":
                    topic = next((o["topic_id"] for o in event.get("options", []) if o.get("type") == "subscribe_ws_topic"), None)
                    if not topic:
                        raise WebError("web_unsupported_stream_handoff")
                yield event
        finally:
            response.close()
        if topic:
            yield from self.follow(topic)

    def close(self):
        self.session.close()
