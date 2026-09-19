---
name: local-codex-proxy
description: 为这台服务器上的项目接入、检查或维护已部署的 Codex 反代公共服务。用户说“使用 Codex 反代”“接入本机 Codex 服务”时使用。
---

# 本机 Codex 反代

复用 `codex-proxy.service`。接入信息以 `/etc/codex-proxy/client.json` 为准；当前入口 `http://127.0.0.1:3467/v1`，模型 `gpt-6-astra`，本机代理密钥文件 `/etc/codex-proxy/proxy.key`。它是后端推理接口；Codex 账户认证由官方 CLI 管理。

## 接入项目

1. 执行 `codex-proxyctl info` 和 `codex-proxyctl check`，查看不含密钥的配置并验证服务。`check` 不调用模型。
2. 按项目所用 SDK 配置 `base_url`、模型、从密钥文件读取的 `api_key`，请求超时建议 245 秒。Python/Node、systemd 和容器示例见 [接入说明](../../README.md)。默认用 Chat Completions；Responses 也有兼容接口，但具体字段按项目需求验证。
3. 可用 `codex-proxyctl run -- <程序及参数>` 给后端子进程注入 `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL`。后两个模型相关环境变量不是所有 SDK 自动识别的配置；代码仍需显式传入模型。不要用 `run -- env` 等方式打印环境。
4. 完成接入后用项目实际代码做一次最小请求；仅检查服务时可用 `codex-proxyctl smoke`，它会消耗一次正常模型调用。

现有服务已经安装并开机自启。普通项目接入不需要再部署一套代理、重新登录或更改全局 Codex provider。保留用户现有模型选择；未指定时采用服务配置中的默认值。多个项目共享当前账户额度和 2 个池工作进程，应用需要合理排队和限流。

若已安装网页通道，同一入口支持 `codex-proxyctl mode auto|web|codex`。`auto` 优先 ChatGPT 非个性化临时聊天，网页未登录、限额或服务故障时使用现有 Codex；响应头会标明实际后端。单网页任务并发，额外并发走 Codex；不支持的网页请求也保留原 Codex 行为。`web-status` 检查登录，`resources` 查看整个服务进程组资源，`smoke web` 才是网页真实调用验证。详细接入与边界见 [网页通道说明](../../docs/web-routing.md)。

本机新增 `transport=http` 通道，普通推理无需 Chrome/Xvfb。网页默认 `chatgpt-web/gpt-6-astra`，实际上游 `gpt-6-astra-wm`，低思考强度映射 Light thinking（`min`）；原生备用仍为 `gpt-6-astra`。以实际 routing.json 与 web-status 为准。已有网页登录应直接复用，`codex-proxyctl web-refresh` 仅临时启动浏览器来刷新现有会话，结束后关闭；不要默认要求用户重新登录。凭据只在私有状态目录中，不输出或提交。HTTP 通道设置见[说明](../../docs/http-web.md)。

首次网页登录使用 `web-login` 开启普通人工 Chrome，登录阶段不连接自动化。用户确认看到 ChatGPT 聊天页后运行 `web-login-finish`，或让用户关闭专用窗口，才开始验证与绑定。不得在用户尚未完成输入时运行 finish；`web-status` 的 waiting_for_login 不代表已认证。维护入口约 30 分钟过期，收到用户报错后先核对服务与登录期限。

## 必须保留的本机约定

- 由项目后端访问，前端不携带代理密钥；本机密钥不是 OpenAI Platform API key。不要读取、复制或显示 Codex 的 `auth.json`。
- 只监听 `127.0.0.1`；拒绝含 `Origin` 的直连。不要为普通接入开放公网端口或放宽只读沙箱、工具禁用设置。
- 密钥由 `ubuntu/root` 读取。其他 systemd 服务用户可用 `LoadCredential`，不要为方便接入把密钥改成所有人可读。
- Docker 默认网络中的 `127.0.0.1` 不是宿主机；本机 Linux 部署可选 `network_mode: host` 并以只读文件挂载凭据，具体方式应适配项目。其他机器需另行建立可达连接。
- `/v1/models` 是上游静态列表，可能未列出已可调用的默认模型；不能把该列表当账户完整授权清单。模型变更要实测。
- 这是社区兼容层。普通文本、JSON 和流式接口可用；不能假定图像、工具调用、结构化输出、Responses 的每个字段都与官方 API 等价。按实际功能验证，失败要如实报告。

## 维护

查看 `systemctl status codex-proxy.service`、`journalctl -u codex-proxy.service`。只在排查或修改服务确有需要时重启。服务源码与部署文件位于本 Skill 的 `../..`（本机安装目录 `/home/ubuntu/services/codex-proxy`），不再依赖某个业务项目；本机旧名 `learning-codex-proxy.service` 是同一服务的别名。

登录失效时使用服务身份 `ubuntu` 的官方 `codex login` 流程。维护、回滚与现有客户端兼容说明见 [接入说明](../../README.md)。
