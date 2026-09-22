# Third-party software

`web/http/` is an independently executed **AGPL-3.0-only** Python component, with
its license in [web/http/LICENSE](web/http/LICENSE). It adapts protocol helpers
from [yukkcat/chatgpt2api](https://github.com/yukkcat/chatgpt2api), revision
`d58db042411f512449dd90e3b7a73de79ab38c46`, and WebSocket framing from the
MIT-licensed [suphotP/chatgpt-api](https://github.com/suphotP/chatgpt-api), revision
`f998a6d83f324cb3187396dd7efced0c40f29601`. Original notices and MIT license text
are retained in [web/http/UPSTREAM_NOTICE](web/http/UPSTREAM_NOTICE). This subtree
is not covered by the repository's default MIT license. The Bun host and gateway
communicate with it through JSON pipes; no upstream account-management app is run.

`upstream/` contains source from [mehdic/codex-proxy](https://github.com/mehdic/codex-proxy), version 0.4.8, commit `da828dafa0bb98a932e022edb608e6b35f0a8d9b`, with local inference and authentication patches.

The original MIT license is retained in [upstream/LICENSE](upstream/LICENSE). Node dependencies are recorded in `upstream/package-lock.json`; their licenses remain applicable. Dependencies and build artifacts are not committed.

The official Codex CLI is separately installed and authenticated by the service operator. This project is not affiliated with or endorsed by OpenAI.

`web/upstream` is a Git submodule of [miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web), version 5.0.8, pinned to `eaf4f09ae92d4dc4429fa597b0861663138f08f8`. Its MIT license and bundled third-party notices remain in that directory. Initialize it with `git submodule update --init --recursive`.

`scripts/prepare-web.py` copies the pinned source to the ignored `.runtime/web` directory, adds the mandatory non-personalized Temporary Chat check from `web/privacy.ts`, uses the owned normal-Chrome lifecycle from `web/browser-host.ts`, sanitizes exported browser state, and suppresses the Codex-specific local-tools warning for plain inference. The Chrome connection uses the dedicated sign-in profile and loopback CDP only after manual authentication ends; task cleanup closes the owned process. It does not run upstream setup, install Codex routes, import Codex OAuth credentials, or enable the full tool harness. Bun and Chromium are separately installed runtime dependencies; their licenses apply.

## 2026-09-22 本地搜索适配

主代理启用 Codex 托管 live 搜索，新增来源与引用适配、两类接口及 SSE 的搜索元数据。HTTP 网页 worker 新增允许列表元数据解析与引用链接转换。未修改宿主机工具执行限制，未包含凭据或上游搜索内容。接口与协议边界见 `docs/search-api.md`。
