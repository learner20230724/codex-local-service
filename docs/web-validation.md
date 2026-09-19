# 当前集成验证记录

2026-09-20，Linux x64，单网页任务，固定上游 5.0.8。

## 已通过

- 主代理构建与 147 项自动化测试，包括网页优先、缺失登录、额度错误、超时取消、单任务并发溢出、流式中断和配置软链接的持久化切换。网页响应在这些路由测试中使用模拟数据。
- Bun 适配契约、隐私保护与人工登录生命周期的 13 项测试；浏览器桥接代码打包检查；Python 脚本语法检查。其中 4 项使用独立 Chrome 和本地 HTML 夹具，覆盖新版原生临时聊天弹窗、延迟渲染、拒绝未知弹窗及拒绝歧义选项。测试浏览器不使用账号状态。
- 普通 API 的字符串输入和完整历史转换为上游要求的消息 ID、当前用户消息归属和独立 turn/thread ID。契约测试调用真实的上游身份、会话键和当前用户消息解析器；工具权限仍关闭。
- 已部署服务的 `auto → codex → auto` 切换与持久化。
- 真实 Codex 推理：auto 在 `web_login_required` 时回退成功；Responses JSON 和 Chat Completions SSE 均成功，响应头表明实际后端为 Codex。
- 无密钥访问被拒绝；携带 Origin 的直接访问被拒绝；推理与维护服务端口仅在回环地址监听。
- 用户已通过普通 Chrome 完成 Google/ChatGPT 登录；网页自己的 `/backend-api/me` 返回有效账号，临时聊天、非个性化状态均实际验证通过。模型菜单实际显示 5 档，含 High、Extra High、Pro；这不代表已验证各档剩余额度。
- 实际网页调用已完成创建临时页面、选模、附加文本等阶段；发送阶段的拦截见下文。

## 首次资源采样

采样 30 秒，网页处于**首次登录等待状态**，没有执行网页模型推理。统计来自 systemd 服务完整 cgroup，CPU 百分比相对于一个逻辑 CPU。

| 服务 | 采样结束内存 | 采样峰值 | 本次服务生命周期峰值 | 平均 CPU |
| --- | ---: | ---: | ---: | ---: |
| 网页桥接 + Xvfb + Chromium | 671.1 MiB | 671.7 MiB | 695.7 MiB | 1.27% |
| 主代理 | 113.8 MiB | 117.6 MiB | 118.5 MiB | 3.50% |

主代理在该时段还承担了验证请求。临时 noVNC / x11vnc 维护服务属于另外的进程组，不包含在网页服务这行中。

## 已登录后的发送尝试与资源

登录和推理均使用官方 Chrome 153.0.8010.52。一次 High 调用从浏览器启动运行到发送失败，采样 60.02 秒：网页服务采样峰值 **672.0 MiB**，systemd 记录的本次服务生命周期峰值 **711.6 MiB**，浏览器释放后 **157.6 MiB**，平均 CPU **32.98%**（相对于一个逻辑 CPU）。此时临时 VNC 服务已关闭。

这些是**启动、选模与失败发送尝试**的资源数据，包含服务 cgroup 的内存记账及缓存，不能称作成功回答时的稳定开销，也不能据此推算多路并发能力。

## 当前外部阻塞与待验收项

实际网页页面的对话/后端请求返回 HTTP **403**、`Content-Type: text/html`、`cf-mitigated: challenge`，表明遇到了 [Cloudflare 验证页面](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/)。页面同时出现“Failed to load subscription”；这不能直接解释为账号没订阅或额度用完。已经停止主动自动重试，并让账号所有者在普通 Chrome 中手动发送一句测试，区分普通浏览器/服务器网络问题和自动化会话问题。

截至此记录，**尚未得到成功的网页模型回答**。网页 SSE、多轮完整历史、成功对话的资源峰值及账号侧普通历史无新增均未通过真实验收。临时/非个性化状态检查已实测，但不能替代这些验收；Codex 回退成功也不能计为网页成功。`web-status.ready` 表示登录资料和桥接进程准备好，不保证网站接受推理请求。

人工验证后再运行 `codex-proxyctl web-login-finish`、`smoke web`、`smoke auto`、`smoke codex`，用实际客户端检查 Responses / SSE / 多轮完整历史，并在网页推理期间采样资源。人工窗口尚在输入时不得提前执行 finish。

自动化命令：

```bash
npm test --prefix upstream
CODEX_WEB_TEST_CHROME=/path/to/chrome bun test web/contract.test.ts web/manual-login.test.ts web/privacy.browser.test.ts
bun build web/bridge.ts --target=bun --outdir /tmp/codex-web-build-check
python3 -m py_compile scripts/*.py scripts/codex-proxyctl
```

全新机器的完整安装器尚未在第二台干净主机验收；当前机器按相同配置约定分步部署。

## 人工登录修正

用户首次 Google 登录出现“不安全浏览器”提示。旧窗口由 Playwright 连接；改为独立启动官方稳定版 Chrome 153.0.8010.52，用户完成登录后才进行离线状态捕获与 ChatGPT 验证。安装包按 Google 签名的仓库索引及 SHA-256 校验。实机进程参数已确认没有自动化、远程调试、无头或禁用沙箱参数；登录页面 HTTP 200，维护 WebSocket 已收到 VNC 协议握手，公网入口仍要求认证。真实 Codex 回退在改动后再次成功。

普通 Chrome 登录已由用户完成并通过验证。随后补充兼容新版延迟渲染的临时聊天说明，且观察网页自身的认证请求，避免额外 `/api/auth/session` 探测被挑战时误判为登录失效。当前阻塞已转为上述网页对话请求的 Cloudflare 验证。
