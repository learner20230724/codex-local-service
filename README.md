# Codex Local Service

把本机已登录的官方 Codex 整理成可供多个项目复用的本地推理服务：固定 HTTP 入口、systemd 守护、独立本机密钥，以及供 Codex 自动发现的接入 Skill。

现支持可选的 **ChatGPT 网页临时聊天优先、Codex 备用**：同一入口用 `codex-proxyctl mode auto|web|codex` 切换，普通文本与流式请求自动调配。新增[无浏览器 HTTP 通道](docs/http-web.md)，复用已有网页登录，调用 GPT-6 Astra＋轻量思考；正常推理无需 Chrome 或虚拟屏幕。两种网页传输均强制临时聊天和非个性化。接入、切换边界和资源检查见 [网页通道说明](docs/web-routing.md)。

`codex-proxyctl stats` 查看按天持久保存的网页/Codex 调用次数、成功/失败/取消、回退及 Token 用量；实报与估算分开显示。HTTP 网页并发可通过 `codex-proxyctl concurrency 1`～`5` 调整，超额请求继续回退。详见[每日统计与并发](docs/daily-stats.md)。

基于 [mehdic/codex-proxy](https://github.com/mehdic/codex-proxy) `0.4.8`，固定提交 `da828dafa0bb98a932e022edb608e6b35f0a8d9b`，保留原有 MIT 许可及本机加固补丁。仓库包含可构建的上游源码，不包含账号凭据、代理密钥、业务数据或 node_modules。

```text
项目后端 / OpenAI SDK
        │ HTTP + 本机 Bearer 密钥
        ▼
codex-proxy.service · 127.0.0.1:3467
        ├─ auto 网页优先 → 私有 HTTP worker → ChatGPT 非个性化临时聊天
        └─ 原生 / 回退 → 官方 codex app-server → Codex 账户可用模型与额度
```

官方 [App Server 文档](https://learn.chatgpt.com/docs/app-server) 说明了其嵌入接口。本项目是社区协议适配层；兼容 HTTP 接口不意味着提供官方 Platform API，也不保证其所有参数和功能等价。认证和续期交给官方 Codex，不复制 OAuth token。

## 安装（Linux + systemd）

准备 Python 3.11+、Node.js 20+、npm，以及已安装并登录的官方 Codex CLI。服务使用已有普通用户身份，例如 `ubuntu`。

```bash
git clone https://github.com/learner20230724/codex-local-service.git
cd codex-local-service
sudo python3 scripts/install.py --user ubuntu
sudo -u ubuntu codex-proxyctl check
sudo -u ubuntu codex-proxyctl smoke
```

默认程序目录 `/opt/codex-local-service`，可用 `--prefix` 修改。`--model` 默认 `gpt-6-astra`，应按账户可用模型选择；`--port` 默认 `3467`。若官方 Codex 需要本机出站代理，可加 `--egress-proxy http://127.0.0.1:7890`。这与项目调用的 `3467` 推理接口用途不同。

安装器拒绝覆盖已有服务、配置和密钥，也拒绝占用中的端口。已有实例应直接复用。构建失败时保留文件供检查；清理本次新建的目录后可重试。此安装器不会修改全局 Codex provider、自动登录或安装官方 CLI。

## 固定接入约定

实际配置以 `/etc/codex-proxy/client.json` 为准，可以安全查看 `codex-proxyctl info`。其中只存密钥路径，不存密钥内容。

| 项目 | 默认值 |
| --- | --- |
| Base URL | `http://127.0.0.1:3467/v1` |
| 模型 | `gpt-6-astra` |
| 本机代理密钥文件 | `/etc/codex-proxy/proxy.key` |
| 健康检查 | `GET /health`，需要同一 Bearer 密钥 |
| 文本接口 | `POST /v1/chat/completions` |
| Responses 兼容接口 | `POST /v1/responses` |
| 请求超时建议 | 245 秒 |
| 池工作进程数 | 2 |

只由项目后端连接。服务拒绝带 `Origin` 的请求；前端通过自己的后端使用 AI，不接触代理密钥。模型请求默认独立临时线程，应用负责传入业务上下文。禁用宿主机 shell、编辑、插件、MCP 等工具，保留只读沙箱。

### Python（OpenAI SDK）

```python
import json
from pathlib import Path
from openai import OpenAI

cfg = json.loads(Path('/etc/codex-proxy/client.json').read_text())
client = OpenAI(
    base_url=cfg['base_url'],
    api_key=Path(cfg['api_key_file']).read_text().strip(),
    timeout=cfg['timeout_seconds'],
    max_retries=0,
)
result = client.chat.completions.create(
    model=cfg['model'],
    messages=[{'role': 'user', 'content': '请用一句话介绍这个服务。'}],
)
print(result.choices[0].message.content)
```

### Node.js（OpenAI SDK）

```javascript
import { readFileSync } from 'node:fs';
import OpenAI from 'openai';

const cfg = JSON.parse(readFileSync('/etc/codex-proxy/client.json', 'utf8'));
const client = new OpenAI({
  baseURL: cfg.base_url,
  apiKey: readFileSync(cfg.api_key_file, 'utf8').trim(),
  timeout: cfg.timeout_seconds * 1000,
  maxRetries: 0,
});
const result = await client.chat.completions.create({
  model: cfg.model,
  messages: [{ role: 'user', content: '请用一句话介绍这个服务。' }],
});
console.log(result.choices[0].message.content);
```

### 给后端进程注入环境变量

```bash
codex-proxyctl run -- python app.py
codex-proxyctl run -- node server.mjs
```

注入 `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL` 和带 `CODEX_PROXY_` 前缀的地址、模型、密钥路径。具体 SDK 是否自动读取地址需看其实现；请求中的模型仍应显式设置。命令不打印密钥，但不要用它执行 `env`、`printenv` 或会输出完整环境的诊断程序。

### systemd 与不同服务用户

以相同服务用户运行的项目可以直接读取密钥文件，或将 `codex-proxyctl run -- ...` 用作 `ExecStart`。其他服务用户建议使用 systemd 凭据，不要把密钥设为所有用户可读：

```ini
[Unit]
After=codex-proxy.service
Wants=codex-proxy.service

[Service]
LoadCredential=codex-proxy.key:/etc/codex-proxy/proxy.key
Environment=OPENAI_BASE_URL=http://127.0.0.1:3467/v1
Environment=OPENAI_MODEL=gpt-6-astra
```

此时应用从 `${CREDENTIALS_DIRECTORY}/codex-proxy.key` 读取密钥并传给 SDK，而非调用需要原始密钥权限的 `codex-proxyctl run`。

Docker 默认网络中的 `127.0.0.1` 指容器自身。对于同机 Linux 容器，可以使用宿主网络并只读挂载密钥文件，匹配容器用户权限；宿主配置的路径也要正确挂载或在应用中指定。不要仅把 base URL 原样复制进桥接网络容器。

## 让 Codex 听懂“使用 Codex 反代”

读取 [接入技能](skills/local-codex-proxy/SKILL.md)。将这个目录链接到对应用户的 `~/.agents/skills/local-codex-proxy`（也可兼容 `~/.codex/skills`），并在 `~/.codex/AGENTS.md` 中追加：

```markdown
## 本机 Codex 反代
当用户要求项目“使用 Codex 反代”或“接入本机 Codex 服务”时，读取
<安装目录>/skills/local-codex-proxy/SKILL.md，复用现有 codex-proxy.service。
接入参数以 /etc/codex-proxy/client.json 为准。不要重复部署代理或复制 Codex OAuth 凭据。
```

把 `<安装目录>` 替换成实际路径；Skill 内维护路径也需与安装位置保持一致。重新进入 Codex 会话后可发现技能。只在用户要求接入该服务时使用，不应把每个项目自动改成这一模型后端。

## 运维与限制

```bash
codex-proxyctl info       # 非敏感配置
codex-proxyctl check      # 进程健康，不调用模型
codex-proxyctl smoke      # 一次真实模型请求，消耗正常额度
systemctl status codex-proxy.service
journalctl -u codex-proxy.service
sudo systemctl restart codex-proxy.service
```

- 修改 `/etc/codex-proxy/client.json` 中的模型或池大小后重启。现有客户端若缓存配置也需重新加载。
- 多个项目共享一个账户的额度和并发能力，当前没有按项目计量、独立配额或独立密钥；调用方应控制并发、排队和超时。
- `GET /v1/models` 是上游静态列表，可能遗漏可用的默认模型；以实际推理验证为准。
- 普通文本、JSON 输出和 SSE 流有兼容实现。工具调用、图像和 Responses 特殊字段需按项目实测；JSON 输出仍应做业务校验。
- 支持单次请求的推理档位：Chat Completions 的 `reasoning_effort`、Responses 的 `reasoning.effort` 会传到 Codex `turn/start.effort`。未指定的客户端保持服务原有默认档位。日序已用 `gpt-6-astra` + `high` 完成真实调用验证；这不修改全局 Codex 配置。
- 上游 `usage.cost` 是 API 等价费用估算，不是本机账户实际账单；使用 token 数做调用统计更合适。
- 登录失效时，在服务用户身份下执行官方 `codex login`。不要从其他项目复制 OAuth token。
- 保持仅回环监听；当前服务适合可信本机后端复用，不提供公网多租户隔离。

## 开发与来源

```bash
cd upstream
npm ci --ignore-scripts
npm run build
```

[继承的本机补丁](docs/inherited-local.patch) 记录了相对固定上游版本的改动：Bearer 鉴权、Origin 拒绝、只读推理设置和依赖覆盖。`scripts/serve.py` 接替原业务项目启动器，把程序、工作目录和密钥放到独立位置。

上游原有测试可运行 `npm test`。这些测试不代表当前账户的真实模型调用一定成功；部署前还应检查健康、鉴权和一个真实推理请求。

本机迁移时 127 项测试及真实 Chat Completions、Responses、SSE 调用通过。完整范围及未验证项目见 [验证记录](docs/validation.md)；其他相关项目见 [路线对比](docs/projects.md)。

MIT License。详见 [本项目许可](LICENSE) 与 [第三方说明](THIRD_PARTY_NOTICES.md)。
