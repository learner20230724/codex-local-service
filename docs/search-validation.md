# 搜索能力验证

> 2026-09-20 是初次发现能力时的历史记录；其中引用未透传、Codex 搜索关闭两项限制已在 2026-09-22 修复，当前协议见[搜索字段说明](search-api.md)。

2026-09-20，沿用 HTTP GPT-6 Astra、Light thinking（`min`）、非个性化临时聊天。没有修改模型、启用本机工具、切换出站代理或更换账号。

## 结论

**当前网页通道能够由 ChatGPT 自己调用内置搜索。** 请求中不必声明 API `tools`，也不必添加 `force_use_search`。这和调用方要求执行自定义函数或本机工具是不同路径。

测试问题为 Python 官网当前最新正式稳定版本、发布日期和官方出处。普通提问版本没有写“联网搜索”，也没有添加搜索工具参数。

| 验证 | 结果 |
| --- | --- |
| 同一传输实现的上游事件诊断，明确要求查官网 | 17.99 秒成功；实际 `gpt-6-astra-wm` / `min`；观察到 assistant→`web.run` 及 `web.run` 工具返回；包含 2 条搜索查询、9 组搜索结果，以及 Python 官方来源 URL |
| 正式 `/v1/responses`，普通自然语言提问 | HTTP 200；17.11 秒；实际 backend=web，无 Codex 回退；返回正文和引用标记 |
| 来源转发检查 | 上游存在 `content_references`、`search_result_groups` 等元数据；正式接口的 `annotations` 仍为空，只留下正文中的内部引用标记 |

这里验收的是搜索确实发生、工具事件与来源结构是否存在，不把生成答案中的版本或发布日期当作已独立核实的事实。搜索也不表示每个问题都会检索，由上游根据问题选择。

## 2026-09-20 当时的边界（历史）

- `tools: [{"type":"web_search"}]` 等调用方声明的工具仍属于网页适配器不支持的请求。auto 会转到原生 Codex，强制 web 会拒绝。不能把这项过滤等同于禁止 ChatGPT 自带的搜索。
- 原生 Codex 备用由现有只推理配置以 `web_search="disabled"` 启动，因此回退后不能假定仍有网页搜索能力；本次未放宽其工具权限。
- 搜索进度、结果列表和可点击引用尚未完整映射为对外 API 的工具事件及引用注释。应用可能看到无法直接点击的内部引用标记。
- 测试开始时遇到 `web_cooldown` / `web_verification_required`。复用已有登录执行了一次 `web-refresh` 后完成上述成功验证，没有重新输入密码；维护 Chrome/Xvfb 已结束。另一次诊断在 WebSocket 接续接口仍遇到验证拦截，说明该限制是间歇性的，不能承诺每次都成功。
- 诊断只查看本次合成测试的工具名称、元数据字段和公开来源，未导出隐藏思考、账号凭据或业务对话。

官方对 ChatGPT 内置搜索及来源显示的说明见 [OpenAI Docs](https://learn.chatgpt.com/docs/web-search?surface=web)。官方能力描述不替代本机实测，也不说明社区反代已兼容所有搜索参数。

## 2026-09-22 修复与正式接口验收

实现见[搜索字段说明](search-api.md)。两条通道均通过正式入口 `127.0.0.1:3467/v1` 调用默认 GPT-6 Astra + low；网页实际为 `gpt-6-astra-wm` / min。请求询问 Python 官方下载页用途与官方出处，用搜索工具证据验收，不依赖模型自述，也不以生成的版本信息验证事实。

| 通道 | 接口 | 传输 | 实际搜索 | 来源 URL 数 | 引用数 | 用时 |
| --- | --- | --- | --- | ---: | ---: | ---: |
| 网页 | Responses | JSON | 是 | 28 | 1 | 18.23 秒 |
| 网页 | Responses | SSE | 是 | 36 | 1 | 17.71 秒 |
| 网页 | Chat Completions | JSON | 是 | 28 | 2 | 31.19 秒 |
| 网页 | Chat Completions | SSE | 是 | 28 | 2 | 18.47 秒 |
| Codex | Responses | JSON | 是 | 18 | 1 | 29.17 秒 |
| Codex | Responses | SSE | 是 | 28 | 1 | 27.96 秒 |
| Codex | Chat Completions | JSON | 是 | 15 | 1 | 56.37 秒 |
| Codex | Chat Completions | SSE | 是 | 28 | 1 | 35.84 秒 |

全部 HTTP 200，实际后端与指定通道一致。检查 `search.performed=true`、原始来源非空、标准引用结构、引用偏移指向正文链接；Responses 流的文本增量拼接与最终正文完全一致，存在引用和搜索完成事件；Chat 流保留 `[DONE]`。URL 数按完整 URL 计数，含上游带不同追踪参数的形式，不等同于独立网站数量。Codex app-server 当前版本确实提供 `webSearch.results` 的结构化来源，适配器未输出其中的片段内容或隐藏思考。

部署前 163 项主服务测试、12 项 Python 测试、6 项 HTTP 桥接/并发 Bun 测试通过，TypeScript 与 Bun 构建通过。覆盖中文/emoji 引用位置、分片到达的引用标记、晚到的来源元数据、非法 URL、普通网址不冒充搜索、两个公共接口的 JSON/SSE 透传和现有取消/回退行为。

诊断开始有一次 `web_verification_required`，复用登录刷新未成功且旧凭据保留。随后沿用原凭据的独立诊断和四个正式网页搜索测试均成功，没有让用户重新登录，也没有常驻浏览器或虚拟屏幕。平台验证仍可能间歇发生，继续保留网页优先、Codex 备用与输出后不切换的原则。

补充自动路由测试：`auto` 请求声明 `tools:[{"type":"web_search"}]`，按既有规则以 `unsupported_web_request` 转到原生 Codex；26.30 秒成功，搜索状态为真，18 条来源、1 处引用。原生普通 JSON 流式测试返回 `{"ok":true}`，搜索状态为假，无来源。网页普通 JSON 流式测试首次遇到上游错误，单独记录，不计入上表八项成功搜索验收。

网页普通 JSON 流式的第二次检查为 `web_transport_failed`，第一次具体为 `web_verification_required`；两次均在正文提交前失败，属于上游可回退错误。此次不声称网页普通 JSON 的实时验收成功。实际未认证请求和带 Origin 的直连均被拒绝（HTTP 401）。

最后默认 auto 的普通 Chat JSON 检查成功走网页，12.95 秒返回合法 `{"ok":true}`，`search.performed=false`、无来源；证明普通 JSON 不被新增搜索字段或提示文字污染。与原生普通 JSON SSE 的成功结果一起验证既有调用路径。
