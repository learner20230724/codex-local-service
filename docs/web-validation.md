# 当前集成验证记录

2026-09-20，Linux x64，单网页任务，固定上游 5.0.8，官方 Chrome 153.0.8010.52。

## 自动化验证

- 主代理构建与 **147 项测试通过**，包括网页优先、缺失登录、额度错误、超时取消、并发溢出、流式中断和配置软链接的持久化切换。这部分网页响应使用模拟数据。
- 浏览器桥接、请求契约和人工登录生命周期的 **17 项测试通过**。真实浏览器测试使用全新空白资料目录及本地 HTML，不使用账号状态，覆盖临时聊天说明、隐私选项、一次刷新上限、会话保存、Chrome 退出和 CDP 只监听回环地址。
- Bun 桥接打包、Python 脚本语法及固定上游补丁锚点检查通过。
- 普通 API 输入补齐上游要求的消息/轮次标识，完整历史保留角色与内容；工具权限仍关闭。

## 真实接口验证

以下请求访问部署后的公共代理入口，使用真实网页账号或现有 Codex；以返回的实际后端与完成事件为准。

| 场景 | 实际结果 | 用时 |
| --- | --- | ---: |
| auto / Chat Completions JSON | 网页 Light，精确返回 CODEXPROXYOK | 17.56 秒 |
| auto / Responses SSE，带入多轮完整历史 | 网页 Light，正确返回先前轮次的暗号，收到 completed | 17.82 秒 |
| 强制网页 / Chat Completions SSE，刷新修正后 | 网页 Light，精确返回 WEBSTREAMOK，流正常结束 | 26.28 秒 |
| 强制网页 / Responses JSON，字符串输入 | 网页 Light，精确返回 WEBRESPONSESOK，status=completed | 28.01 秒 |
| 网页槽位占用时第二个 auto 请求 | Codex，fallback=web_busy，精确返回 CODEXPROXYOK | 6.08 秒 |
| 网页发送被验证拦截 | Codex，fallback=upstream_server_error，流式答案完成 | 21.16 秒 |
| 后续冷却期请求 | Codex，fallback=web_cooldown，答案正常 | 6.40 秒 |
| 最终重启后的 auto 烟雾测试 | 网页 Light，精确返回 CODEXPROXYOK，无回退 | 35.70 秒 |

Responses 非流式网页请求也实际完成。首次精确标记检查使用下划线，返回值被 DOM→Markdown 转义，因此该次不能计为逐字节相等；烟雾测试现使用纯字母标记。这是网页文本转换的兼容性边界，不表示请求走了 Codex。

发送前一次刷新部署后，Chat Completions SSE 与 Responses JSON 均通过强制网页复核；未用 Codex 回答冒充网页成功。

## 临时聊天与账号历史

用户已在普通 Chrome 完成登录和手动对话。网页自身的 `/backend-api/me` 返回有效账号，临时聊天和非个性化状态实际验证通过；已完成网页请求记录到 `history_and_training_disabled: true`。每次请求创建独立临时聊天，带入调用方提供的完整历史。

真实测试前后的普通历史列表对比完成：**返回列表未出现新增会话，账户历史总数不变**。比较仅保存会话 ID 的单向摘要，不输出标题、对话内容或账号信息。这是本次测试窗口的结果，后续仍依靠每次发送前的临时/非个性化检查。

维护 VNC/noVNC 已关闭，临时 HTTPS 登录路由已移除；推理接口保留原有 Bearer 鉴权、Origin 拒绝和回环监听。浏览器资料、导出状态、诊断均留在私有目录，不进入仓库。

## 成功回答期间的资源

统计来自 systemd 完整 cgroup，包含 Bun、Xvfb、Chrome 和文件缓存；CPU 百分比相对于一个逻辑 CPU。VNC/noVNC 均关闭。

| 成功网页调用 | 网页采样峰值 | 结束后网页服务内存 | 平均 CPU |
| --- | ---: | ---: | ---: |
| Chat Completions JSON / Light | 870.1 MiB | 205.4 MiB | 104.42% |
| Responses SSE + 多轮历史 / Light | 820.5 MiB | 196.8 MiB | 103.20% |

采样周期约 18.3 秒，间隔 1 秒，可能漏掉更短的峰值。同期 systemd 生命周期峰值为 994.9 MiB，包含先前 High 失败尝试，不能将它单独归因于 Light。Chrome 在请求结束后正常保存状态并退出，网页服务无需一直保留完整浏览器进程。单路已验证；没有宣称多路网页并发能力。

最终代码重启后另做一次成功 Light 调用，用时 35.70 秒；该次服务生命周期只有这一条推理，systemd 捕获的完整网页进程组瞬时峰值为 **1234.0 MiB（约 1.21 GiB）**，浏览器退出后为 **195.5 MiB**。这说明 1 秒采样会漏掉短时峰值，容量规划应参考约 1.2 GiB 的实测上界，而不是仅采用前两次 820–870 MiB 的采样峰值。同期主代理空闲内存约 79.3 MiB。

## 已处理的问题与保留边界

普通 Chrome 手动对话成功，但将登录状态导入新 Playwright 浏览器会遇到 HTTP 403、`cf-mitigated: challenge`，即 [Cloudflare 验证页面](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/)。现改为保留专用普通 Chrome profile，在人工登录结束后才连接回环 CDP，验证与推理使用同一版本。正常关闭 Chrome 以保存会话；不会修改网页指纹或自动点击验证码。

网站仍可能间歇性挑战某些请求，不能承诺网页通道比 Codex 更稳定。已补入原项目启动器采用的发送前一次页面刷新；它发生在填写提示词之前，发送后不刷新重投。持续失败遵循自动回退与 60 秒冷却，不把两个后端的答案拼接起来。

本机 High 在 120 秒内未完成，因此默认改为已成功回答的 Light；High、Extra High、Pro 的剩余额度与长期可用性没有得到验证。模型菜单可见不等于已通过推理验收。网页内容由 DOM 还原 Markdown，不保证原始字节一致；工具、图像及增量 previous_response_id 请求按原有路由限制处理。

自动化命令：

```bash
npm run build --prefix upstream
npm test --prefix upstream
xvfb-run -a env CODEX_WEB_TEST_CHROME=/path/to/chrome bun test web/*.test.ts
bun build web/bridge.ts --target=bun --outdir /tmp/codex-web-build-check
python3 -m py_compile scripts/*.py scripts/codex-proxyctl
```

全新机器安装器尚未在第二台干净主机验收；当前机器按同一配置约定分步部署。
