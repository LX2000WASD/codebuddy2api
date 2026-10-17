# codebuddy2api

Use your **WorkBuddy / CodeBuddy (Tencent)** subscription as local **OpenAI- and Anthropic-compatible APIs**.

[中文文档](README.zh-CN.md)

- Chat Completions, Responses and Anthropic Messages, with tool calling and streaming.
- Built-in **WebUI** for browser login, models, credentials, logs and settings — no desktop client required.
- Automatic multi-account routing across domestic and international sites, with credential refresh.
- Per-account automation: domestic personal accounts check in and dispatch Buddy travel by default, with independent switches; international check-in is opt-in. The growth center is personal-only, so enterprise accounts are excluded.
- **Local port layer** on top of upstream v1.3.6: per-account×model soft cooldown, credit floor, expiry-aware routing, transport-failure demotion, diagnostics, alerting and trend analytics — see [Local port layer](#local-port-layer).

## Where this repository comes from

This checkout is a **personal fork** that tracks two upstream projects and adds a local port layer of its own.

| Role | Repository | Notes |
|------|------------|-------|
| Upstream gateway (base) | [maiphucgiang/codebuddy2api](https://github.com/maiphucgiang/codebuddy2api) | Python gateway + WebUI. This fork tracks upstream **v1.3.6** (merged 2026-10-15, previously based on v1.3.2). |
| Second upstream (ideas) | [linguo2625469/workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) | Go gateway with a Web panel (MIT), an enhanced fork of the now-deleted `Sliverkiss/workbuddy2api`. Its account-pool operations and observability ideas were ported into the local layer below; no Go code is used. |
| This fork | `LX2000WASD/codebuddy2api` (branch `local/main`) | Upstream base + the local port layer. Published as its own images; changes are **not** sent back upstream. |

Upstreaming policy: the fork deliberately stays **semi-detached** — it does not follow every upstream commit, and it does not push back. Upstream feature intake is decided per release and applied on top of the local layer.

## Local port layer

Added on top of upstream v1.3.6 (`local/main`), all of it optional and switchable through the WebUI or `.env`:

**Routing and account operations**

- Model-level **soft** cooldown (upstream already had a fixed per-model cooldown): the 429 window is isolated per account × model, aligned to the reset clock in the upstream message, switched by a single global toggle, with switching models bypassing a cooldown, and repeat 429s during a soft cooldown no longer stacking.
- Credentials are disabled only after N consecutive auth failures (default 3); a successful refresh/chat or a manual reset clears the counter.
- Account-level `paused`: leaves selection but keeps check-in / travel / maintenance running.
- Credit floor: an EMA spend ledger plus upstream catalogue multipliers keep low-balance accounts off paid models; a fully drained pool returns 503 instead of hammering upstream.
- Expiring credits are softly weighted in selection (168 h window), without breaking stickiness or zero-multiplier priority.
- Transport-failure demotion: accounts that repeatedly fail at the transport layer (connect/write/TTFB stalls) leave the pool temporarily, orthogonal to circuit breaking, 429 cooldown and `paused`.
- Timeout policy tuned for the 502/524 class of stalls: write-timeout replay on by default, write 20 s, TTFB 30 s.

**Observability and automation**

- `GET /healthz` (no auth, service-identity header), `GET /admin/status` and `GET /admin/diagnostic` (per-account cooldown reasons + pool-wide model locks).
- Latency histogram (P50/P95/P99), tokens/s excluding TTFB, and per-account / per-model / per-product queries.
- Alerts (balance exhausted, credits expiring, circuit break, catalogue sync failure, audit degradation, pool drained) delivered to webhook / Bark / email; off by default.
- WebUI views: trends, diagnostics, alert centre and a credits-expiry card, with skeleton placeholders, optimistic updates with rollback, debounced and cancellable requests, and dependency-free SVG charts.

The full management-API contract for these endpoints is [docs/fusion-api.md](docs/fusion-api.md) (Chinese).

## Quick start

Requires Git and Docker Compose. Images are prebuilt and include the WebUI; no local build is needed.

```bash
git clone https://github.com/LX2000WASD/codebuddy2api.git
cd codebuddy2api
cp .env.example .env
```

Edit `.env`: set `CODEBUDDY2API_KEY` to your own random key and pick the image. Preserve an existing `.env` on upgrades:

```dotenv
# This fork (local port layer, pinned to a commit)
CODEBUDDY2API_IMAGE=ghcr.io/lx2000wasd/codebuddy2api:local
# Or the upstream image, without the local layer
# CODEBUDDY2API_IMAGE=ghcr.io/maiphucgiang/codebuddy2api:latest
```

```bash
docker compose pull
docker compose up -d --no-build
```

`:local` follows the newest `local/main` build; each build also publishes an immutable `:local-<sha>` tag (the full 40-character commit sha) — pin that for reproducible deployments. Upstream `latest` tracks upstream stable releases and does **not** contain the local port layer.

First use:

1. Open **http://127.0.0.1:8787/dashboard** and sign in with your API key.
2. In **Credentials**, add a domestic or international account through browser login, or import an `.info` file.
3. In **Models**, find an available model and use its public ID in your client.

The template binds to localhost only. Configure HTTPS and restrict network access before allowing remote connections; keep and securely back up the `auth/` data directory. To run current source or log in from a terminal instead, see the [deployment guide](docs/deployment.md).

## Client setup

| Protocol | Base URL |
|----------|----------|
| OpenAI Chat / Responses | `http://127.0.0.1:8787/v1` |
| Anthropic Messages | `http://127.0.0.1:8787` |

- **API key:** the same key used to sign in to the WebUI.
- **Model:** a public ID from the WebUI or `GET /v1/models`.
- All accounts share these URLs; no region parameter is needed. Anthropic SDKs append `/v1/messages` themselves, so leave it out of the Base URL.

[Codex CLI, Claude Code / CC Switch and other client examples →](docs/clients.md)

## Building the local image

The fork is shipped as an overlay image: the official upstream image as the base, plus the local Python layer and a locally built WebUI.

```bash
docker build -f Dockerfile.local -t codebuddy2api:local .
```

Building needs network access (Node image, vite-plus release, pnpm registry) and is not recommended on a small VPS. The normal path is CI: pushing to `local/main` runs the full test suite and then publishes `ghcr.io/lx2000wasd/codebuddy2api:local` and `:local-<sha>` — see [.github/workflows/build-local-image.yml](.github/workflows/build-local-image.yml).

## Project structure

```
.
├── converter.py         # Gateway entry: protocol adaptation, routing, scheduling
├── app/                 # Management API, credentials, catalogs, audit and policy modules
│   ├── alerting.py      # Local layer: alert events and delivery channels
│   ├── diagnostic.py    # Local layer: per-account cooldown and pool-wide model locks
│   ├── health_endpoints.py  # Local layer: /healthz and /admin/status
│   ├── credit_floor.py  # Local layer: credit floor and spend ledger
│   └── credential_cooldowns.py  # Local layer: model cooldowns and account pauses
├── web/                 # WebUI frontend (React/TypeScript; build output served by the gateway)
│   └── src/fusion/      # Local layer: fusion client, types and development mock
├── tests/               # Offline regression suites
├── docs/                # User guides (English/Chinese pairs) + the Chinese fusion API contract
├── examples/            # Client configuration examples
├── scripts/             # Version and dependency-lock tooling
├── Dockerfile           # Upstream multi-stage image: frontend build + Python runtime
├── Dockerfile.local     # Fork overlay image: upstream base + local Python and frontend
├── docker-compose.yml   # Recommended deployment
├── .env.example         # Every runtime environment variable, annotated
└── .github/workflows/   # CI: tests, image publishing, CodeQL, local image
```

## Documentation

| Guide | Contents |
|-------|----------|
| [WebUI guide](docs/webui.md) | Accounts, model routing, audit logs, settings and backups |
| [Deployment](docs/deployment.md) | Published images, upgrades, reverse proxy/HTTPS, local setup and CLI login |
| [Client configuration](docs/clients.md) | Codex CLI, Claude Code, CC Switch and generic clients |
| [Advanced reference](docs/advanced.md) | Options, APIs, model scheduling, request limits and troubleshooting |
| [Fusion management API](docs/fusion-api.md) | Local-layer endpoint contract: health, status, diagnostics, stats, alerts (Chinese) |

## FAQ

- **WebUI sign-in fails behind an HTTPS domain/reverse proxy?** Trust your public origin via `admin_allowed_origins` — see [Management Origin checks](docs/advanced.md#management-origin--csrf-switch).
- **No Docker?** After installing dependencies and the WebUI, run `uv run converter.py` or `python3 converter.py` without `.env`. First local startup saves a default key and displays it once — see [Local Python setup](docs/deployment.md#local-python-setup).
- **Where is my data?** Everything lives in `auth/` (or `/data/auth` in Docker): credentials, settings and log databases — see [Data and backups](docs/webui.md#data-and-backups).
- **Which image tag should I use?** `local` follows this fork, `local-<sha>` pins one build of it, upstream `latest`/`edge` follow upstream releases. Tags are listed at [GHCR: LX2000WASD/codebuddy2api](https://github.com/LX2000WASD/codebuddy2api/pkgs/container/codebuddy2api); docs/deployment.md describes the upstream images only.
- **Which local-layer switches are on by default?** Resilience options are on (write-timeout replay, write 20 s, TTFB 30 s, transport demotion 5 failures / 600 s); the conservative ones are off (`CODEBUDDY2API_CREDIT_FLOOR=0`, `CODEBUDDY2API_ALERT_ENABLED=false`, and `stats_tokens_rate_ttfb_ms` is a reserved key that is not in effect yet).
- **Responses tool output/arguments compressed or need verbatim passthrough?** Set `responses_projection_mode` (default `balanced`, or `passthrough` to disable projection) and `responses_projection_max_bytes` (default `40000`, `0` disables per-item trimming). Balanced trimming keeps the head/tail and reports original bytes, estimated tokens and total lines; client addresses stay unchanged — see [Responses projection](docs/clients.md#responses-projection) and [details](docs/advanced.md#responses-projection).

## Credits

- [maiphucgiang/codebuddy2api](https://github.com/maiphucgiang/codebuddy2api) — the gateway this fork is based on.
- [linguo2625469/workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) (MIT) — source of the account-operations and observability ideas ported into the local layer.
- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) — the project both of the above descend from.

## Disclaimer

For personal learning only — no commercial use. Not affiliated with Tencent, WorkBuddy, CodeBuddy, OpenAI, or Anthropic. This project only calls official APIs of accounts you are logged into; use it solely with subscriptions you legally own. You are solely responsible for your account, credentials, and all associated risks.

## License

[MIT](LICENSE)

## Community

Thanks to the [LINUX DO](https://linux.do) community for providing an open and friendly platform for technical discussions.
