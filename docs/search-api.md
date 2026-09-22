# 搜索状态、来源与引用

2026-09-22 起，HTTP 网页通道和原生 Codex 通道均可根据问题自行联网。原生 Codex 子进程以 `web_search="live"` 启动；只开放托管网页搜索，宿主机 shell、文件编辑、MCP、插件等限制保持不变。无需修改客户端 URL、密钥或普通请求体。

## 调用方如何读取

两个接口的成功响应均新增顶层 `search`：

```json
{
  "search": {
    "enabled": true,
    "performed": true,
    "queries": ["Python downloads official"],
    "sources": [
      {
        "type": "url",
        "url": "https://www.python.org/downloads/",
        "title": "Download Python",
        "provenance": "search_result"
      }
    ],
    "sources_complete": false
  }
}
```

- `enabled`：该通道提供搜索能力；不是每次都搜索。
- `performed`：本次实际观察到搜索/浏览工具活动或上游搜索结果。普通回答中的网址和模型声称“已搜索”不构成这项证据。未搜索时为 `false`，列表为空。
- `queries`：上游实际给出的查询词，去重。仅打开已知网址时可能为空。
- `sources`：本次上游提供的原始 URL 和标题，按完整 URL 去重，包含未在正文引用的检索结果。`provenance` 区分 `search_result`（结构化结果）、`citation`（网页引用元数据）、`opened_page`（浏览动作网址）、`answer_link`（缺少结构化结果时从最终回答提取的引用）。不同追踪参数的 URL 保留其原始形式。
- `sources_complete`：目前固定 `false`，因为两种社区上游协议都不保证给出所有检索记录。不把可见来源冒充完整浏览历史，也不把模型写出的链接冒充结构化搜索结果。

来源只向当前调用方返回，不写入每日统计，也不记录到服务日志。不会转发工具原文、搜索片段、隐藏思考或认证信息。

## 引用格式

正文保留原来的位置。网页内部 `cite…` 在有来源映射时转换为可点击的 Markdown 链接；一个引用对应多个来源时全部保留。Codex 使用 Markdown 原始链接，并可将结构化结果能解析的内部引用转换为链接。

| 接口 | 正文 | 标准引用字段 |
| --- | --- | --- |
| Chat Completions | `choices[0].message.content` | `choices[0].message.annotations[]`，每项为 `{type:"url_citation",url_citation:{url,title,start_index,end_index}}` |
| Responses | `output[0].content[0].text` 和 `output_text` | `output[0].content[0].annotations[]`，每项直接包含 `type,url,title,start_index,end_index` |

偏移基于最终返回正文的 Unicode 码点，区间为 `[start_index,end_index)`。JavaScript 包含 emoji 时可用 `Array.from(text).slice(start,end).join("")` 获取引用片段。

Responses 的 `output` 同时含 `web_search_call` 项，带动作和完成状态。为兼容现有只读取 `output[0]` 的应用，助手消息仍放在第一个位置，搜索项附在后面。遇到上游未给来源的引用，保留原文，不编造链接；完整来源列表仍可通过 `search.sources` 读取。

字段形式参照 [OpenAI Docs：Web search](https://developers.openai.com/api/docs/guides/tools-web-search)。顶层 `search`、来源 `provenance` 和上述输出顺序是本代理的兼容扩展，不代表官方 API 完全等价。

## 流式返回

- **Chat Completions**：正常 `delta.content` 持续输出；`finish_reason="stop"` 的最终 chunk 带顶层 `search` 和 `choices[0].delta.annotations`，即使没有请求 usage 也会提供。随后仍是 `[DONE]`。已有函数工具模拟若以 `tool_calls` 结束，则最终工具 chunk 也包含 `search`。
- **Responses**：提供 `response.output_text.annotation.added`、搜索项的 `response.output_item.added/done` 和 `response.web_search_call.completed`；`response.completed.response` 带完整正文、引用、搜索项和 `search`。搜索结果事件在完成时送出，不承诺实时搜索进度。
- 引用元数据可能晚于正文到达。从第一个内部引用标记起暂缓这段正文，等待来源解析后继续发送，保证拼接后的正文与最终正文一致。保活和阶段提示使用 SSE 注释，不混入正文，以免破坏 JSON 或引用偏移。

支持新增字段的客户端可直接显示“已联网”与来源卡片；只读取正文的既有客户端无需改动。对响应字段做严格白名单校验的客户端需要允许这些新增字段，界面要显示独立搜索状态仍需主动读取 `search`。

## 路由和范围

网页仍优先，输出前失败仍可回退 Codex，开始输出后不切换后端。实际通道看 `X-Codex-Proxy-Backend`；回退原因看 `X-Codex-Proxy-Fallback`。原生搜索配置仅影响本代理启动的子进程，不改全局 Codex 设置；官方模式说明见 [OpenAI Docs：web_search](https://learn.chatgpt.com/docs/config-file/config-reference)。

自然语言提问无需声明 tools。现有显式 API 工具路由保持不变：`tools:[{"type":"web_search"}]` 在 auto 下进入原生 Codex，可执行搜索；强制 web 仍拒绝显式 tools。本次没有声称兼容搜索的所有高级选项（例如域名过滤、位置、图片搜索或强制 tool_choice），也没有新增本机工具执行能力。

这是 HTTP 网页通道的增强；旧 `transport=browser` 浏览器适配器不在此次引用映射范围内。Cloudflare、账号状态或上游故障仍可能导致网页通道回退。
