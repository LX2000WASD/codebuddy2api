# codebuddy2api

把 **WorkBuddy / CodeBuddy（腾讯代码助手）** 订阅变成本机可用的 **OpenAI / Anthropic 兼容 API**。

[English](README.md)

- 支持 Chat Completions、Responses 和 Anthropic Messages，包含工具调用与流式输出。
- 内置 **WebUI**：浏览器登录添加账号，管理模型、凭证、日志与设置，无需桌面端。
- 多账号自动选路，兼容国内／国际站，自动刷新凭证。
- 按账号配置自动任务：国内默认签到后派 Buddy 旅行，可分别关闭；国际自动签到默认关闭。
- 在上游 v1.3.6 之上叠加**本地移植层**：账号×模型级**软**冷却、积分保底、临期积分加权、传输层连败降权、诊断与告警、趋势统计——见[本地移植层](#本地移植层)。

## 仓库来源（两个上游）

本仓库是**个人分支**，跟随两个上游项目，并叠加了自己的本地移植层。

| 角色 | 仓库 | 说明 |
|------|------|------|
| 上游网关（基座） | [maiphucgiang/codebuddy2api](https://github.com/maiphucgiang/codebuddy2api) | Python 网关 + WebUI。本分支已跟进上游 **v1.3.6**（2026-10-15 合并，此前基于 v1.3.2）。 |
| 第二上游（借鉴） | [linguo2625469/workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) | Go 网关 + Web 管理面板（MIT），是已删库的 `Sliverkiss/workbuddy2api` 的增强分支。其**账号运营与可观测性**思路被移植进下面的本地层，未使用其 Go 代码。 |
| 本分支 | `LX2000WASD/codebuddy2api`（分支 `local/main`） | 上游基座 + 本地移植层。使用自己发布的镜像，改动**不向上游回流**。 |

上游策略：本分支有意保持**半脱离**——不逐条跟随上游提交，也不向上游推送；上游能力的取舍按发行版逐个评估后叠加到本地层之上。

## 本地移植层

在上游 v1.3.6（`local/main`）之上新增，全部可选，可在 WebUI 或 `.env` 中开关：

**选路与账号运营**

- 模型级**软**冷却（上游已有固定的模型冷却）：429 窗口按「账号 × 模型」隔离，文案带重置时间时对齐墙钟，可整表开关，且软冷却期间的重复 429 不再叠加延长。
- 认证类错误连续 N 次（默认 3）才禁用账号；refresh/chat 成功或手工复位即清零。
- 账号级 `paused`：只退出选号，签到／旅行／保号任务照常运行。
- 积分保底：本地 EMA 扣费台账 + 上游目录倍率双判据，余额过低的账号不派发收费模型；全池触底返回 503 而不打穿上游。
- 临期积分加权选号（168 小时窗口内软加权），不破坏账号粘性与零倍率优先。
- 传输层连败降权：反复在传输层失败（连接／写入／TTFB 卡住）的账号临时出池，与熔断、429 冷却、`paused` 正交。
- 针对 502/524 一类的卡顿调优超时体系：写超时重放默认开启，写 20 秒、TTFB 30 秒。

**可观测与告警**

- `GET /healthz`（无鉴权、带服务身份响应头）、`GET /admin/status`、`GET /admin/diagnostic`（逐账号冷却原因 + 全池模型锁视图）。
- 延迟直方图（P50/P95/P99）、扣除 TTFB 的 tokens/s，以及按账号／模型／产品的维度查询。
- 告警（余额耗尽、积分将到期、认证熔断、目录同步失败、审计降级、全池触底）投递到 webhook / Bark / 邮件；默认关闭。
- WebUI 新视图：趋势、诊断、告警中心与积分到期卡片；配合骨架屏、乐观更新与回滚、防抖与可取消请求、零依赖 SVG 图表。

这些端点的完整管理面契约见 [docs/fusion-api.md](docs/fusion-api.md)。

## 快速开始

需要 Git 和 Docker Compose；镜像已预构建并内含 WebUI，无需在本机编译。

```bash
git clone https://github.com/LX2000WASD/codebuddy2api.git
cd codebuddy2api
cp .env.example .env
```

编辑 `.env`：将 `CODEBUDDY2API_KEY` 设置为自己的随机密钥，并指定镜像；升级时保留已有 `.env`：

```dotenv
# 本分支（含本地移植层，建议固定到某个提交）
CODEBUDDY2API_IMAGE=ghcr.io/lx2000wasd/codebuddy2api:local
# 或改用上游镜像（不含本地移植层）
# CODEBUDDY2API_IMAGE=ghcr.io/maiphucgiang/codebuddy2api:latest
```

```bash
docker compose pull
docker compose up -d --no-build
```

`:local` 跟随 `local/main` 的最新构建；每次构建同时发布不可变的 `:local-<sha>` 标签（完整 40 位提交号），需固定部署时用后者。上游 `latest` 跟随上游稳定发行版，**不含**本地移植层。

首次使用：

1. 打开 **http://127.0.0.1:8787/dashboard**，使用刚设置的 API key 登录。
2. 在「凭证管理」通过浏览器登录添加国内或国际账号，也可导入 `.info` 文件。
3. 在「模型路由」查看可用模型，将其对外 ID 填入客户端。

按模板配置时仅允许本机访问。远程访问前请配置 HTTPS 并限制网络访问；保留并妥善备份 `auth/` 数据目录。如需直接运行源码或在终端登录，见[部署指南](docs/deployment.zh-CN.md)。

## 客户端接入

| 协议 | Base URL |
|------|----------|
| OpenAI Chat / Responses | `http://127.0.0.1:8787/v1` |
| Anthropic Messages | `http://127.0.0.1:8787` |

- **API Key**：与 WebUI 登录使用同一个密钥。
- **模型**：使用 WebUI 中的对外 ID，或查询 `GET /v1/models`。
- 国内、国际账号共用这些地址，无需额外的地域参数。Anthropic SDK 会自行追加 `/v1/messages`，不要把它写入 Base URL。

[Codex CLI、Claude Code / CC Switch 等配置示例 →](docs/clients.zh-CN.md)

## 构建本地镜像

本分支以「覆盖层」方式发布：官方上游镜像作底座，叠加本地 Python 层与本地构建的前端。

```bash
docker build -f Dockerfile.local -t codebuddy2api:local .
```

构建需要网络（Node 镜像、vite-plus 发行包、pnpm registry），不建议在小型 VPS 上直接构建。常规路径是 CI：推送到 `local/main` 后先跑全量测试，再发布 `ghcr.io/lx2000wasd/codebuddy2api:local` 与 `:local-<sha>`——见 [.github/workflows/build-local-image.yml](.github/workflows/build-local-image.yml)。

## 项目结构

```
.
├── converter.py         # 网关入口：协议适配、选路、调度
├── app/                 # 管理 API、凭证、目录、审计与策略模块
│   ├── alerting.py      # 本地层：告警事件与投递通道
│   ├── diagnostic.py    # 本地层：逐账号冷却与全池模型锁
│   ├── health_endpoints.py  # 本地层：/healthz 与 /admin/status
│   ├── credit_floor.py  # 本地层：积分保底与扣费台账
│   └── credential_cooldowns.py  # 本地层：模型冷却与账号暂停
├── web/                 # WebUI 前端（React/TypeScript，构建产物由网关托管）
│   └── src/fusion/      # 本地层：融合层客户端、类型与开发期 mock
├── tests/               # 离线回归测试
├── docs/                # 用户文档（中英对照）+ 中文融合层 API 契约
├── examples/            # 客户端配置示例
├── scripts/             # 版本与依赖锁定工具
├── Dockerfile           # 上游多阶段镜像：前端构建 + Python 运行时
├── Dockerfile.local     # 分支覆盖层镜像：上游底座 + 本地 Python 与前端
├── docker-compose.yml   # 推荐部署方式
├── .env.example         # 全部运行时环境变量及注释
└── .github/workflows/   # CI：测试、镜像发布、CodeQL、本地镜像
```

## 文档

| 指南 | 内容 |
|------|------|
| [WebUI 使用指南](docs/webui.zh-CN.md) | 添加账号、模型路由、日志审计、设置与备份 |
| [部署指南](docs/deployment.zh-CN.md) | 发布镜像、升级、反向代理/HTTPS、本地运行与命令行登录 |
| [客户端配置](docs/clients.zh-CN.md) | Codex CLI、Claude Code、CC Switch 与通用客户端 |
| [进阶参考](docs/advanced.zh-CN.md) | 参数、API、模型调度、请求限制与故障排查 |
| [融合层管理 API](docs/fusion-api.md) | 本地层端点契约：健康、状态、诊断、统计、告警 |

## 常见问题

- **绑定域名后经 HTTPS 反代无法登录 WebUI？** 将对外来源加入 `admin_allowed_origins` 信任列表——见[管理 Origin 校验](docs/advanced.zh-CN.md#管理-origin--csrf-开关)。
- **没有 Docker？** 准备依赖和 WebUI 后，直接 `uv run converter.py` 或 `python3 converter.py`，无需 `.env`；首次本地启动保存默认 key 并仅在终端显示一次——见[本地 Python 运行](docs/deployment.zh-CN.md#本地-python-运行)。
- **数据在哪里？** 全部位于 `auth/`（Docker 中为 `/data/auth`）：凭证、设置与日志数据库——见[数据与备份](docs/webui.zh-CN.md#数据与备份)。
- **镜像标签怎么选？** `local` 跟随本分支，`local-<sha>` 固定其中一次构建，上游 `latest`/`edge` 跟随上游发行版。本分支标签见 [GHCR: LX2000WASD/codebuddy2api](https://github.com/LX2000WASD/codebuddy2api/pkgs/container/codebuddy2api)；docs/deployment.zh-CN.md 只描述上游镜像。
- **本地移植层哪些开关默认打开？** 弹性项默认开（写超时重放、write 20s、TTFB 30s、传输连败 5 次/600s 出池）；保守项默认关（`CODEBUDDY2API_CREDIT_FLOOR=0`、`CODEBUDDY2API_ALERT_ENABLED=false`），`stats_tokens_rate_ttfb_ms` 为预留键、暂不生效。
- **Responses 工具输出/参数被压缩或需要完全原样？** 设置 `responses_projection_mode`（默认 `balanced`，设 `passthrough` 可完全关闭投影）及 `responses_projection_max_bytes`（默认 `40000`，`0` 禁用单项裁剪）。balanced 裁剪保留头尾并显示原始 bytes、估算 tokens 与总行数，客户端地址不变——见 [Responses 投影](docs/clients.zh-CN.md#responses-投影)及[详细说明](docs/advanced.zh-CN.md#responses-投影)。

## 致谢

- [maiphucgiang/codebuddy2api](https://github.com/maiphucgiang/codebuddy2api)——本分支所基于的网关。
- [linguo2625469/workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel)（MIT）——本地移植层中账号运营与可观测性思路的来源。
- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)——上述两个项目的共同前身。

## 免责声明

本项目仅供个人学习使用，不得用于商业用途。与腾讯、WorkBuddy、CodeBuddy、OpenAI、Anthropic 无官方关联。本项目仅调用你已登录账号的官方接口，请仅在你合法拥有订阅的前提下使用；账号与凭据的一切使用责任及风险由使用者自行承担。

## 开源协议

[MIT](LICENSE)

## 社区

感谢 [LINUX DO](https://linux.do) 社区提供开放、友善的技术交流平台。
