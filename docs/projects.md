# 项目路线对比

核对日期：2026-09-17。以下特征以项目维护者文档为依据，不等同于本机对全部功能的实测。

| 项目 | 路线 | 适合的需求 |
| --- | --- | --- |
| [mehdic/codex-proxy](https://github.com/mehdic/codex-proxy) | 包装官方 `codex app-server` 的 stdio JSON-RPC，提供 OpenAI 风格 HTTP 接口，认证由 Codex 管理 | 已有官方 Codex 登录态，希望为本机项目增加统一推理入口 |
| [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | 多种 CLI/OAuth 后端及 OpenAI、Gemini、Claude 等兼容接口，包含多账户路由 | 需要跨厂商统一网关和较复杂路由 |
| [anxkhn/codex-openai-proxy](https://github.com/anxkhn/codex-openai-proxy) | 轻量 Python/FastAPI 代理，自行管理 Codex OAuth token 与刷新 | 希望直接控制 OAuth 转发实现并维护其认证存储 |

本项目沿用第一条路线，重点增加独立部署、固定配置位置、服务守护和跨项目接入技能。当前单账户本机复用没有引入另一套网关的必要。

另一个容易混淆的概念是“让 Codex 客户端连接第三方模型”：官方 [自定义 provider 配置](https://learn.chatgpt.com/docs/config-file/config-advanced) 支持 `base_url` 等参数。那是 Codex 消费其他服务；本项目则让业务后端通过 HTTP 使用官方 Codex App Server。两者方向不同。

官方 [App Server 文档](https://learn.chatgpt.com/docs/app-server) 是底层协议依据；上方三个社区项目的 HTTP 兼容性各自实现，需要按实际使用的字段与功能验证。
