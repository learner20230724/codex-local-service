# 网页优先与 Codex 备用

同一个 `codex-proxy.service` HTTP 入口和本机密钥管理两条推理通道。默认端口仍为 `127.0.0.1:3467/v1`。可选的私有 `codex-proxy-web.service` 在 `127.0.0.1:3468` 驱动一个浏览器任务，使用固定版本的 `miuuyy/codex-chatgpt-web`。它不是独立对外产品，也不改全局 Codex 配置。

首次部署的实测结果、资源采样和待验收项见 [验证记录](web-validation.md)。

```text
应用 → :3467 → auto 路由 → :3468 → Xvfb / Chromium → ChatGPT 临时聊天
                      └→ 原有 codex app-server（备用）
```

## 开关和状态

```bash
codex-proxyctl mode             # 当前模式、网页忙碌、冷却原因和请求计数
codex-proxyctl mode auto        # 网页优先；符合条件的失败转 Codex
codex-proxyctl mode codex       # 只用原有 Codex
codex-proxyctl mode web         # 只用网页，失败如实返回
codex-proxyctl web-status       # 登录、临时聊天策略和单任务状态
codex-proxyctl resources        # systemd 整个进程组的内存与 CPU
codex-proxyctl smoke auto       # 一次真实推理；输出实际 backend 和 fallback
codex-proxyctl smoke web        # 必须由网页成功回答
codex-proxyctl smoke codex      # 必须由 Codex 成功回答
```

开关写入 `/etc/codex-proxy/routing.json`，下一次请求生效，无需重启。鉴权后的 `GET /routing` 和 `PUT /routing` 提供相同管理能力。`PUT` 请求体只接受 `{"mode":"auto"}`、`web` 或 `codex`。请求头 `X-Codex-Proxy-Backend` 可按次覆盖。

安装器让该配置路径链接到服务用户私有的 `/var/lib/codex-proxy/routing.json`，模式写入采用原子替换，无需放宽整个 `/etc/codex-proxy` 目录权限。手工部署也应采用这一布局。

已有部署未安装 routing.json 时仍为 Codex 模式。安装网页通道后采用 auto。默认模型请求可自动路由；明确指定其他 Codex 模型继续走 Codex。明确指定 `chatgpt-web/*` 的请求不偷偷切成 Codex。网页模式响应包含实际网页模型名，以及 `X-Codex-Proxy-Backend` / `X-Codex-Proxy-Model`；备用响应还包含 `X-Codex-Proxy-Fallback`。网页 High 与 Codex 模型不是等价型号。

## 切换边界

- 支持普通文本的 Chat Completions、Responses、JSON 输出和 SSE。完整对话历史由调用方每次传入。系统提示词、角色与历史会转换到 Responses。
- 工具、图像、音频、后台任务和仅有 `previous_response_id` 的增量请求不交给网页通道；auto 保留原 Codex 行为，web 模式返回明确错误。不宣称全部 API 字段等价。
- 单次推理档位映射到明确网页模式：low→light、medium→medium、high→high、xhigh→extra-high、max→pro；模型必须在网页账号实际可用。
- 网页健康/登录检查失败、额度限制、服务故障或超时可以转 Codex；请求本身的 400 错误不会通过切换重试。
- 网页一次只接受一个推理任务；auto 的并发溢出走 Codex，web 模式繁忙返回 503。登录窗口打开时也不接受网页推理。
- SSE 的元信息先缓冲，第一段实质输出发给调用方后不再自动切换；中断返回错误，不把两个模型的答案拼接起来。
- 默认网页预算 120 秒，备用 Codex 使用原请求总预算剩余时间。一次失败后网页冷却 60 秒，可用 `mode auto` 清除冷却。流式响应没有完成事件时不能当作成功。

## 无桌面 Linux 与首次登录

使用 Linux x64、Bun 1.4.0、Chromium/Chrome、Xvfb。浏览器必须运行，但不需要完整桌面或物理显示器。首次由用户在专用普通浏览器完成登录，登录期间不启动 Playwright 或调试连接；不读取现有 Codex `auth.json`。建议使用 Google 官方稳定版 Chrome 进行 Google 联合登录，`web.json` 的 `login_chrome_bin` 可与推理用的 `chrome_bin` 分别配置，省略时复用后者。

1. `git submodule update --init --recursive` 取得固定源码。
2. 安装 Bun、Chromium、Xvfb 与浏览器所需系统库；下载二进制时核对其发布 SHA-256。准备的 Chromium 可执行文件可通过包装脚本加入本机出站代理。
3. 以服务用户执行 `python3 scripts/prepare-web.py --bun /path/to/bun`，准备隔离源码和锁定依赖。
4. 将 `config/web.example.json` 和 `config/routing.example.json` 放到 `/etc/codex-proxy/`，按实际路径配置；权限 0600，服务用户所有。浏览器状态目录也仅允许该用户访问。
5. 用 `deploy/codex-proxy-web.service.in` 生成 systemd 单元。填入用户、项目路径、出站代理；无代理时环境变量留空。确认 `:97` 虚拟显示未被占用；需要改显示号时同步修改维护连接。
6. 构建主代理 `cd upstream && npm ci --ignore-scripts && npm run build`。启动并启用网页服务，在无在途推理时重启主代理。
7. 执行 `codex-proxyctl web-login`。通过 SSH 隧道或受认证 HTTPS 的临时 noVNC 维护入口操作该虚拟屏幕。VNC、调试与网页推理端口始终只在本机监听；不能公开无认证的登录窗口。
8. 手动登录并看到 ChatGPT 聊天页后，关闭这个专用 Chrome 窗口，或执行 `codex-proxyctl web-login-finish`。程序先结束人工登录浏览器，再离线提取这个专用 profile 的 ChatGPT/OpenAI 状态，排除 Google cookies，随后验证 ChatGPT 服务端登录状态、临时聊天、非个性化和账号模型能力。等待登录时不监视密码输入；单纯打开浏览器不算登录成功。窗口 30 分钟超时关闭，验证最多 120 秒。用 `web-status` 确认 ready，再分别进行 web / auto / codex 真实调用。

对于已经安装主代理且准备好运行时的机器，第 3–5 步可以一次执行（拒绝覆盖已有网页配置）：

```bash
sudo python3 scripts/install-web.py --user ubuntu \
  --bun /opt/codex-proxy-web/bin/bun \
  --chrome /opt/codex-proxy-web/chromium/chrome \
  --login-chrome /usr/bin/google-chrome-stable \
  --egress-proxy http://127.0.0.1:7890
```

它不自动重启正在服务的主代理；在没有在途调用时完成构建和主服务重启。`codex-proxyctl resources` 的内存包含 Bun、Xvfb 和整个 Chromium 进程组，不能只看主进程 RSS。连续采样可用 `python3 scripts/measure-resources.py --seconds 30`；应分别测登录待机、回答中和回答完成后的占用。

`codex-proxyctl web-login-stop` 可提前关闭浏览器登录窗口。远程维护代理也应设置 30 分钟期限并在登录后关闭；重新绑定时重新开启，不把它当常驻公开页面。

若 Google 报 “This browser or app may not be secure”，参考 [Google 支持的浏览器说明](https://support.google.com/accounts/answer/7675428?hl=en)。初版集成的 Playwright 登录窗口已替换为普通人工 Chrome。不要反复重试自动化登录，也不要关闭账号验证；如果普通浏览器仍被拒绝，需要按账号提供方提示处理受支持浏览器、网络或账号验证问题。登录时必须继续使用原账号的登录方式。

仓库提供 `deploy/codex-proxy-web-vnc.service.in` 与 `deploy/codex-proxy-web-login.service.in` 模板（需要 x11vnc/noVNC/websockify），默认均只监听回环且 30 分钟到期。可用 SSH 本地转发访问 6087；使用 Caddy 时必须将整个 noVNC 静态目录和 WebSocket 路径一起置于已有 HTTPS 认证之后。登录结束后停止两个维护单元。浏览器状态只存服务用户私有目录，不能将 profile 或 storage-state 放到网页目录。

## 历史与隔离

每次业务请求创建独立临时聊天，带入完整业务历史；结束后释放浏览器会话。发送前强制检查 `temporary-chat=true` 和非个性化状态，无法证明则失败。程序不保存为普通聊天、不修改账号全局记忆设置，也不启用 MCP/终端/编辑工具。当前隐私控件识别支持英文和简体中文，其他页面结构会明确失败。

临时聊天不会因为这个服务而进入普通历史，但它仍消耗同一账号的网页额度；不是本地推理，也不是无限额度。登录会话、缓存、浏览器诊断均留在私有状态目录，不提交到 Git。

## 升级和回退

先停止网页服务，保留 `/var/lib/codex-proxy/web`。审查并更新 Git 子模块固定提交，将旧 `.runtime/web` 移到私有备份，再运行 prepare-web.py；补丁不匹配时安装会拒绝继续。重启后重新验证隐私检查与真实对话。

网页异常时可立即 `codex-proxyctl mode codex` 恢复原有推理路线。关闭网页 systemd 服务可以释放虚拟显示与浏览器资源；主代理仍可服务。不要通过重置或清除正常 ChatGPT 历史修复登录问题。
