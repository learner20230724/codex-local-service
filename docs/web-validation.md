# 首次集成验证记录

2026-09-20，Linux x64，单网页任务，固定上游 5.0.8。

## 已通过

- 主代理构建与 147 项自动化测试，包括网页优先、缺失登录、额度错误、超时取消、单任务并发溢出、流式中断和配置软链接的持久化切换。网页响应在这些路由测试中使用模拟数据。
- Bun 适配契约及隐私保护的 3 项测试；浏览器桥接代码打包检查；Python 脚本语法检查。
- 已部署服务的 `auto → codex → auto` 切换与持久化。
- 真实 Codex 推理：auto 在 `web_login_required` 时回退成功；Responses JSON 和 Chat Completions SSE 均成功，响应头表明实际后端为 Codex。
- 无密钥访问被拒绝；携带 Origin 的直接访问被拒绝；推理与维护服务端口仅在回环地址监听。

## 首次资源采样

采样 30 秒，网页处于**首次登录等待状态**，没有执行网页模型推理。统计来自 systemd 服务完整 cgroup，CPU 百分比相对于一个逻辑 CPU。

| 服务 | 采样结束内存 | 采样峰值 | 本次服务生命周期峰值 | 平均 CPU |
| --- | ---: | ---: | ---: | ---: |
| 网页桥接 + Xvfb + Chromium | 671.1 MiB | 671.7 MiB | 695.7 MiB | 1.27% |
| 主代理 | 113.8 MiB | 117.6 MiB | 118.5 MiB | 3.50% |

主代理在该时段还承担了验证请求。临时 noVNC / x11vnc 维护服务属于另外的进程组，不包含在网页服务这行中。

## 尚未通过真实验证的项目

首次 ChatGPT 登录需要账号所有者在专用浏览器完成；截至此记录仍未登录。因此，**网页真实回答、网页 SSE、账号可用模型、实际聊天期间的内存峰值，以及账号侧普通历史隔离尚未实测**。代码的临时聊天和非个性化检查会在无法证明状态时拒绝发送，但不能把代码检查等同于登录后的验收。

登录完成后依次运行 `codex-proxyctl smoke web`、`smoke auto`、`smoke codex`，用实际客户端检查 Responses / SSE / 多轮完整历史，并在网页推理期间运行 `python3 scripts/measure-resources.py --seconds 30`。记录实际模型和响应头；如果网页未成功，不应将自动回退的成功计为网页成功。

自动化命令：

```bash
npm test --prefix upstream
bun test web/contract.test.ts
bun build web/bridge.ts --target=bun --outdir /tmp/codex-web-build-check
python3 -m py_compile scripts/*.py scripts/codex-proxyctl
```

全新机器的完整安装器尚未在第二台干净主机验收；当前机器按相同配置约定分步部署。
