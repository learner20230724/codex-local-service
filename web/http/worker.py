# SPDX-License-Identifier: AGPL-3.0-only
"""One bounded inference child. Only normalized response events are written to stdout."""
import json
import os
import signal
import sys
from pathlib import Path
from transport import Answer, MODEL, PUBLIC_MODEL, Transport, WebError, load_session, payload_for


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    transport = None
    def cancel(_signum, _frame):
        raise WebError("web_cancelled", 499)
    signal.signal(signal.SIGTERM, cancel)
    try:
        body = json.loads(sys.stdin.readline(2 * 1024 * 1024))
        payload = payload_for(body)
        state = load_session(Path(os.environ.get("CODEX_CHATGPT_WEB_HOME", "/var/lib/codex-proxy/web")) / "http-session.json")
        transport = Transport(state, os.environ.get("CODEX_WEB_EGRESS_PROXY", ""))
        answer = Answer(payload["thinking_effort"], (m["id"] for m in payload["messages"]))
        visible, held = "", False
        for event in transport.events(payload):
            delta = answer.accept(event)
            if delta and not held:
                if "" in delta:
                    delta = delta.split("", 1)[0]
                    held = True
                if delta:
                    visible += delta
                    emit({"type": "delta", "text": delta})
        answer.complete()
        rendered, annotations = answer.search.render(answer.text)
        if not rendered.startswith(visible):
            raise WebError("web_non_append_output")
        if rendered[len(visible):]:
            emit({"type": "delta", "text": rendered[len(visible):]})
        search, calls = answer.search.result()
        emit({"search": search, "search_calls": calls, "annotations": annotations, "type": "done", "model": PUBLIC_MODEL, "upstream_model": MODEL, "thinking_effort": payload["thinking_effort"]})
    except WebError as error:
        emit({"type": "error", "code": error.code, "status": error.status})
    except Exception:
        # HTTP libraries can include cookies, signed URLs and payloads in exception text.
        emit({"type": "error", "code": "web_transport_failed", "status": 502})
    finally:
        if transport:
            transport.close()


if __name__ == "__main__":
    main()
