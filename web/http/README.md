# Browser-free ChatGPT transport

This directory is an independently executed AGPL-3.0-only Python worker. Its
license is in `LICENSE`. The Bun HTTP host and existing Codex gateway exchange
normalized JSON events with this worker over private stdin/stdout pipes.

Protocol preparation adapts `yukkcat/chatgpt2api` revision
`d58db042411f512449dd90e3b7a73de79ab38c46` (2026-09-09). `pow.py` and
`turnstile.py` retain that implementation; the only functional change to `pow.py`
is replacing its application-wide UUID dependency with Python's UUID function.
Original copyright, upstream MIT notices and AGPL terms are retained in
`UPSTREAM_NOTICE` and `LICENSE`.

WebSocket stream handoff framing is adapted from the MIT-licensed
`suphotP/chatgpt-api` revision `f998a6d83f324cb3187396dd7efced0c40f29601`.
Its full MIT notice is also included in `UPSTREAM_NOTICE`.

Local changes limit this worker to one already-authorized ChatGPT account and
text inference. There is no account registration, account pool, external
challenge service, external prompt review, local tool execution, global settings
mutation or access to Codex OAuth credentials. Cloudflare challenge pages and
unsupported verification fail to the gateway's normal Codex fallback.

ChatGPT may still invoke its own hosted web search while answering a plain text
request. This was observed in real upstream `web.run` events without explicit
search flags. The adapter now forwards allowlisted search queries, original source
URLs/titles and citation annotations, and resolves internal citation markers to
Markdown links. Late citation metadata is buffered without changing already-sent
text. Explicit API tool declarations remain unsupported on the web transport;
Codex fallback now has hosted live search enabled. See [search API fields](../../docs/search-api.md)
and [search validation](../../docs/search-validation.md).

All conversation requests set `history_and_training_disabled=true` and
`temporary_chat_requests_personalization=false`, use fresh parent/message IDs,
and never append to a user's stored conversation. GPT-6 Astra requires
`model=gpt-6-astra-wm`, `conversation_origin=tpp`, and `thinking_effort=min` for
the verified light-thinking configuration. Omitting the origin can silently
resolve to GPT-5.6. The worker checks the actual final message's model and effort
before exposing text. Historical input messages, analysis messages and unrelated
WebSocket topics are excluded from output.

Install pinned `requirements.txt` dependencies into a dedicated virtual
environment; the upstream account-management app is not needed. Credentials are
loaded only from the service-owned, mode-0600
`$CODEX_CHATGPT_WEB_HOME/http-session.json`. They never enter argv, stdout, logs
or this repository. The gateway terminates each child on cancellation, timeout
or shutdown. Signed WebSocket URLs must use exactly `wss://ws.chatgpt.com`;
authenticated HTTP redirects are disabled.

```sh
python -m unittest discover -s web/http -p 'test_*.py'
```

Deployment and session refresh: [../../docs/http-web.md](../../docs/http-web.md).
