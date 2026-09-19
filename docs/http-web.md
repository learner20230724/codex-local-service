# 无浏览器网页通道

`codex-proxy-web.service` 可选用 `transport=http`，由轻量 Bun 入口启动单次 Python HTTP 工作进程。正常推理不启动 Chrome、Playwright、Xvfb、VNC 或桌面。客户端继续访问 `http://127.0.0.1:3467/v1`，原有密钥、auto/web/codex 开关和 Codex 回退继续有效。

网页模型固定为 `chatgpt-web/gpt-6-astra`，真实网页型号为 `gpt-6-astra-wm`。默认 `reasoning.effort=low` 映射到网页的 Light thinking（`min`）。工作模式通过 `conversation_origin=tpp` 指定；若遗漏，上游可能接受请求却返回 GPT-5.6，因此适配器在输出前核验实际模型和思考档位，不接受静默降级。

## 使用现有登录

首次绑定仍沿用[浏览器登录流程](web-routing.md)。已有绑定无需重新输入账号密码。`web/capture-session.ts` 只恢复本机已有 ChatGPT Cookie，确认非个性化临时聊天，观察网页自身的认证请求，并将 HTTP 凭据原子写入 `/var/lib/codex-proxy/web/http-session.json`（0600）。它不访问 Codex `auth.json`，不导出 Google Cookie，不发送聊天，也不操作登录表单。

HTTP 凭据有效时无须浏览器。需要刷新时运行：

```sh
codex-proxyctl web-refresh
codex-proxyctl web-status
codex-proxyctl smoke web
```

`web-refresh` 仅在维护期间启动临时 Xvfb 与专用普通 Chrome，结束后退出，复用已有网页登录；不能保证被平台撤销的登录永久有效。刷新失败保留旧文件，鉴权失效或验证拦截走 Codex 回退，不循环重试或自动要求用户登录。健康状态只检查本地凭据结构与期限；`smoke web` 才验证真实推理。

## 从浏览器通道迁移

先保留已有私有登录目录和配置，安装独立 Python 运行环境：

```sh
python3 -m venv /opt/codex-proxy-web/http-venv
/opt/codex-proxy-web/http-venv/bin/pip install --index-url https://pypi.org/simple -r web/http/requirements.txt
```

在 `/etc/codex-proxy/web.json` 中增量设置：

```json
{
  "transport": "http",
  "http_python": "/opt/codex-proxy-web/http-venv/bin/python",
  "egress_proxy": "http://127.0.0.1:7890"
}
```

保留原有 state_dir、Bun、Chrome 和端口字段；出站代理按部署环境填写，没有则留空。升级 systemd 模板，使 ExecStart 直接启动 `scripts/serve-web.py`，不再在单元外层常驻 `xvfb-run`；该脚本会按 transport 决定是否需要虚拟屏幕。服务用户、回环监听与鉴权设置不变。

执行 `web-refresh` 取得已有账号的 HTTP 凭据，然后在 routing.json 中设置 `web_model=chatgpt-web/gpt-6-astra`、`default_reasoning_effort=low`、`mode=auto`。重新构建主反代，在没有在途请求时重启主反代和网页服务。新思考强度默认值也用于默认 GPT-6 Codex 回退；调用方明确指定的强度保留。

## 接口与隐私边界

- 支持 Chat Completions / Responses 的普通文本、完整多轮历史、JSON 和 SSE。每个请求独立创建临时会话；历史由调用方提供，不复用服务器上的会话 ID。
- 每次发送强制 `history_and_training_disabled=true`、`temporary_chat_requests_personalization=false`。不更新全局个性化设置，不把普通会话创建后再删除当作临时聊天。
- HTTP 直接读取文本，不经过浏览器 DOM→Markdown 转义。上游流转交 WebSocket 时只订阅本次请求的 topic，并处理历史回显、重放与终止事件。
- 工具、图像、音频、后台任务及 previous_response_id 仍不走网页通道。JSON 格式以提示词约束，不保证官方 Structured Outputs 的严格语法约束；max_output_tokens 没有上游硬限制保证。网页端未提供精确用量时 Responses 省略 usage，Chat 兼容输出中的零值表示未知，不能用于计费。
- 单网页槽位；超额并发走 Codex。输出前错误可以回退；输出之后发生错误不能拼接另一个模型的答案。工作进程在请求取消或超时后清理。
- HTTP 模式只提供新的 GPT-6 网页型号；旧 light/high 等浏览器型号由 `transport=browser` 提供。回滚时同时恢复浏览器 web_model，并在无在途请求时重启网页服务。

Python 进程及协议改动采用独立目录中的 AGPL-3.0-only 许可，保留原作者和 MIT 上游声明；详见 [HTTP 组件说明](../web/http/README.md) 和 [第三方声明](../THIRD_PARTY_NOTICES.md)。
