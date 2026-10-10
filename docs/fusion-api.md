# Fusion 管理面 API 契约（codebuddy2api 融合层）

> 适用范围：codebuddy2api local/main（v1.3.2 + 本地融合层）。
> 本文件是**前后端对接的唯一契约**，由 Fusion-B（可观测性与告警体系）维护。
> 前端（Fusion-C）按本文档实现；后端字段新增保持向后兼容，破坏性变更须先改本文档。

## 0. 通用约定

- 所有 `/admin/*` 端点复用现有管理面鉴权：会话 Cookie（+ CSRF Token，POST/PUT/PATCH/DELETE）或 `Authorization: Bearer <API key>` / `X-Api-Key`。鉴权失败 401；CSRF/Origin 失败 403；未配置 API key 时 503。
- 时间戳均为 Unix epoch 秒（浮点），除非字段名以 `_ms` / `_at` 后缀显式标注；`_at` 亦为 epoch 秒。
- 错误响应沿用现有信封：`{"error": {"message": <中文消息>, "type": "admin_error"}}`，HTTP 状态码 400（参数无效）/ 404（不存在）/ 503（存储降级）/ 500（内部错误）。
- 管理面所有响应带 `Cache-Control: no-store`（已有中间件行为）。
- 未登录会话可访问的端点仅 `GET /healthz` 与 `POST /admin/session`（已有）。

---

## 1. 健康探活：`GET /healthz`（无鉴权）

供负载均衡 / 编排 / 宿主进程探活。**恒无鉴权**，只区分 2xx / 503 语义。

- 响应头：`X-Service: codebuddy2api`（服务身份，防同端口残留旧服务返回 2xx 造成「假成功」）。
- 响应体（200 或 503，503 时仍返回此结构）：

```json
{
  "service": "codebuddy2api",
  "version": "1.3.2-local",
  "status": "ok" | "degraded",
  "total": 5,          // 凭证池账号总数
  "healthy": 3,        // 可用（ready）账号数
  "servable": true,    // 是否存在可服务账号（healthy>0 即 true；503 当且仅当 servable=false）
  "generated_at": 1718083200.0
}
```

- 判定口径（与凭证池 inventory 的 health 同源）：`ready` = 启用（enabled）且无错误（error）且认证未熔断（fail_until<=now）且 token 未过期。`total` 为池内全部账号（含 disabled）。凭证池未初始化时 `total=0, healthy=0, servable=false, status="degraded"`，HTTP 503。
- 该端点不读审计库、不触发同步、不持有锁，可高频探活。

## 2. 服务详细状态：`GET /admin/status`（强校验）

比 `/healthz` 更完整的服务画像，供 WebUI 状态栏与诊断页头部使用。

```json
{
  "service": "codebuddy2api",
  "version": "1.3.2-local",
  "uptime_seconds": 3612.4,
  "generated_at": 1718083200.0,
  "pool": {
    "total": 5, "healthy": 3, "cooling": 1, "disabled": 1, "expired": 0, "error": 0,
    "servable": true
  },
  "by_profile": {
    "cn-cli": {"total": 2, "healthy": 2, "servable": true},
    "intl-work": {"total": 3, "healthy": 1, "servable": true}
  },
  "audit": {"degraded": false, "failure_count": 0, "dropped_records": 0, "last_error": null},
  "cooldown_storage": {"available": true, "degraded": false, "rows": 4, "last_error": null},
  "alerts": {"enabled": true, "evaluator_running": true, "pending_deliveries": 0, "last_event_at": 1718081000.0}
}
```

- `cooling` = 认证熔断中（circuit_open）；`expired` = token 过期；`error` = 同步/其他错误状态。
- 字段缺失时为 `null`（例如审计库不可用时 `audit.degraded=true` 且带 `last_error`）。

---

## 3. 诊断聚合：`GET /admin/diagnostic`

单次请求给出「逐账号冷却/禁用原因 + 模型锁全池视图」，供诊断视图与模型锁池视图。

```json
{
  "generated_at": 1718083200.0,
  "pool": {"total": 5, "healthy": 3, "servable": true},
  "accounts": [
    {
      "id": "9b2c（account_key，同 /admin/credentials 的 id）",
      "name": "xxx.info",
      "profile": "cn-cli",
      "health": "ready | disabled | circuit_open | expired | error",
      "enabled": false,
      "paused": true,                     // 独立暂停状态: 只退出选号, 与 enabled 正交 (见 §10)
      "disabled_reason": "人工停用 | 认证熔断 | 登录身份过期 | 同步失败 | 后端错误 | null",
      "cooldown": {
        "fail_until": 1718084000.0,       // 无熔断时为 0
        "remaining_seconds": 800,
        "reason": "backend HTTP 401"      // 冷却原因（安全过滤后的简短文本）
      },
      "model_cooldowns": [
        {"model": "deepseek-chat", "until": 1718085000.0, "remaining_seconds": 1800}
      ],
      "last_error_code": "http_401 | credential_error | null",
      "last_failure_at": 1718080000.0,
      "sync_error": null,                 // 余额/目录同步错误文本
      "catalog_ready": true
    }
  ],
  "model_locks": [
    {
      "profile": "cn-cli",                // 「域」= 产品域 profile
      "model": "deepseek-chat",           // 路由级模型名（public/upstream 口径同 /admin/models 的 id）
      "locked_accounts": 2,
      "account_ids": ["9b2c", "7f3a"],
      "earliest_unlock_at": 1718084000.0, // 最早单账号解锁
      "latest_unlock_at": 1718085000.0,   // 全池解锁（最晚）
      "all_unlock_in_seconds": 1800,      // max(0, latest_unlock_at - now)
      "kind": "rate_limit",               // rate_limit=429 额度冷却 | model_block=后端不提供该模型
      "reason": "模型额度冷却"
    }
  ],
  "cooldown_storage": {"available": true, "degraded": false, "rows": 4, "last_error": null}
}
```

- `model_locks` 按 `profile + model` 聚合**全部账号**的模型级冷却（含 Fusion-A 的模型级冷却表），并合并 `model_block`（后端确认不支持的模型对，与 `/admin/model-blocks` 同源）。kind=model_block 时 reason 为「后端模型不可用」，`account_ids` 为受影响绑定账号（可能为全部启用账号，此时为提示性锁定）。
- 冷却原因文本为安全过滤后的固定短文本，不含上游返回体。
- 503 当且仅当凭证池未初始化（此时 accounts 与 model_locks 为空数组）。

---

## 4. 统计增强（分位数 / 维度切分 / tokens 每秒）

### 4.1 `GET /admin/stats/summary?days=7`

全局窗口汇总，含延迟分位数与 tokens/s。

```json
{
  "generated_at": 1718083200.0,
  "range": {"days": 7, "start": 1717392000.0, "end": 1718083200.0, "granularity": "day"},
  "summary": {
    "requests": 128, "success": 120, "error": 6, "cancelled": 2,
    "input_tokens": 210000, "output_tokens": 95000, "total_tokens": 305000,
    "credit": 420.5,
    "duration_avg_ms": 3200.5, "first_token_avg_ms": 410.2,
    "latency_p50_ms": 2100.0, "latency_p95_ms": 8400.0, "latency_p99_ms": 15200.0,
    "latency_known": 128,                    // 参与分位数/均值的样本数
    "tokens_per_s": 31.6,                    // 口径见 4.4
    "tokens_per_s_known": 126                // 参与tokens_per_s的样本数
  },
  "degraded": false
}
```

- `days` 含义与取值同 dashboard：∈ {1, 7, 30, 90}，默认 7；非法 400。
- `degraded: true` 表示审计库降级（不可用 503），与 `/admin/dashboard` 同口径。

### 4.2 `GET /admin/stats/series?days=7&granularity=auto&dimension=model&key=deepseek-chat`

趋势序列，支持按账号 / 模型切分；每个 bucket 附分位数与 tokens/s（延迟分位曲线数据源）。

- 参数：
  - `days` ∈ {1,7,30,90}，默认 7；小时粒度上限 90 天，超出 400。
  - `granularity` ∈ {auto, hour, day}，默认 auto（days=1→hour，其余→day）。
  - `dimension` ∈ {global, model, profile, credential}，默认 global。
  - `key`：当 dimension ≠ global 时**必填**（模型名 / profile / 账号 id）；dimension=global 时须缺省，否则 400。`key` 最大 160 字符且必须为安全标识符（与日志筛选同口径）。
- 响应：

```json
{
  "generated_at": 1718083200.0,
  "range": {"days": 7, "start": 1717392000.0, "end": 1718083200.0,
            "granularity": "day", "dimension": "model", "key": "deepseek-chat", "partial": false},
  "series": [
    {
      "bucket": 1717392000.0, "date": "2026-06-30",
      "requests": 20, "success": 19, "error": 1, "cancelled": 0,
      "input_tokens": 30000, "output_tokens": 12000, "total_tokens": 42000,
      "credit": 61.0,
      "duration_avg_ms": 3050.0, "first_token_avg_ms": 388.0,
      "latency_p50_ms": 2000.0, "latency_p95_ms": 8000.0, "latency_p99_ms": 14000.0,
      "latency_known": 20,
      "tokens_per_s": 30.2, "tokens_per_s_known": 19
    }
  ],
  "summary": { },
  "degraded": false
}
```

- `summary` 与 4.1 同结构（该维度在该窗口的汇总）。
- 空桶（无请求）仍返回，数值字段为 0 / null（与 `/admin/dashboard` 填充口径一致）。
- `partial`：小时序列缺失历史时为 true（与 dashboard 同口径）。

### 4.3 `GET /admin/stats/dimensions?dimension=credential&days=30`

逐账号 / 逐模型 / 逐 profile 聚合列表（用于趋势切分选择器与维度汇总卡片）。

- 参数：`dimension` ∈ {model, profile, credential}（**必填**）；`days` ∈ {1,7,30,90}，默认 30。
- 响应：

```json
{
  "generated_at": 1718083200.0,
  "dimension": "credential",
  "days": 30,
  "items": [
    {
      "key": "9b2c",                  // 账号 id / 模型名 / profile，对应 series 的 key
      "label": "xxx.info",           // 仅 credential 维度附带文件名，其余为 null
      "profile": "cn-cli",           // 仅 credential 维度附带，其余为 null
      "requests": 64, "success": 60, "error": 3, "cancelled": 1,
      "output_tokens": 50000, "total_tokens": 160000, "credit": 220.0,
      "duration_avg_ms": 3100.0, "first_token_avg_ms": 402.0,
      "latency_p50_ms": 2050.0, "latency_p95_ms": 8200.0, "latency_p99_ms": 15000.0,
      "latency_known": 64,
      "tokens_per_s": 29.8, "tokens_per_s_known": 60
    }
  ],
  "degraded": false
}
```

- 列表按 `requests` 降序，最多 200 条。

### 4.4 口径定义（重要）

- **分位数**：由固定延迟直方图（end-to-end duration_ms）插值估算，桶边界（ms）：
  `0, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200, +∞`（11 桶）。
  P50/P95/P99 为桶内线性插值结果；样本数 < 5 时分位数返回 `null`。
  直方图随审计聚合持久化，明细清理（clear / 超额淘汰）不影响分位数。
- **tokens/s**（生成速率）：`sum(output_tokens) / sum(effective_seconds)`，其中单请求
  `effective_seconds = (duration_ms - first_token_ms) / 1000`（流式且 first_token_ms ≥ 阈值
  `stats_tokens_rate_ttfb_ms`，默认 200ms），否则回退为 `duration_ms / 1000`（端到端口径）。
  仅统计 duration_ms 与 output_tokens 均已知的请求（`tokens_per_s_known`）。
  该口径扣除了 TTFB（首字节等待），更接近真实生成速率；TTFB 过小（如上游本地缓存命中）时自动回退，避免除数过小导致虚高。
- 已知数（`*_known`）用于前端展示数据完整度；`null` 表示该指标无已知样本。
- 维度 `credential` 的 key 与 `/admin/credentials` 的 `id` 一致（account_key）。

---

## 5. 凭证 paused 切换（变更现有端点）

`PATCH /admin/credentials/{id}` 在原有 `{"enabled"}` 基础上**新增** `{"paused": true|false}`：

- 请求体（二选一，不可混用）：`{"paused": true}` 暂停选号但保留签到/旅行/保号任务；与 `{"enabled": false}`（整体停用）语义正交，不可互相替代。
- 响应：

```json
{"id": "9b2c", "field": "paused", "paused": true, "enabled": true, "revision": 12}
// 注: enabled 为附加字段 (便于前端同步显示停用状态), 语义见 §10; 两个开关取值相互独立。
```

- 原有 `{"enabled": ...}` 行为不变，响应仍为 `{"id","field":"enabled","enabled":...,"revision"}`（不混返两组字段，字段名随请求字段）。
- paused 语义：账号池层面的独立暂停状态（只退出选号，签到/旅行/保活/同步等维护照跑），与停用（enabled）正交；池侧完整契约见第 10 节。`/admin/diagnostic` 的 `accounts[].paused` 读取 inventory 的显式 `paused` 字段，未携带时回退为 `not enabled`。
- 后端实现优先调用 `gateway.admin_set_credential_paused(identity, paused)`，未落地时回退 `admin_set_credential_enabled(identity, not paused)`（行为连续，详见第 10 节）。

---

## 6. 告警体系

### 6.1 事件历史：`GET /admin/alerts/events`

- 参数：`limit`（1..200，默认 50）、`kind`（可选，逗号分隔多值）、`severity`（可选）、`since`（epoch 秒，可选）。
- 响应：

```json
{
  "generated_at": 1718083200.0,
  "enabled": true,
  "items": [
    {
      "id": "evt-3f1a",
      "kind": "credits_expiring",
      "severity": "warning",            // info | warning | critical
      "title": "积分即将到期",
      "detail": "账号 xxx.info 剩余 120 积分将在 2.1 天后到期",
      "account_id": "9b2c",             // 无账号维度时为 null
      "context": {                      // 机器可读上下文（有界、脱敏）
        "remaining_credits": 120.0,
        "days_remaining": 2.1,
        "soonest_expiry": 1718265600.0
      },
      "fired_at": 1718081000.0,
      "delivered": [                    // 各通道最近一次投递结果
        {"channel": "webhook", "ok": true, "at": 1718081001.2, "error": null}
      ]
    }
  ],
  "has_more": false
}
```

- 事件按 `fired_at` 降序，最多保留 `alert_history_limit` 条（默认 200，可配置）。
- 历史持久化于数据目录 `alerts-state.json`（独立于审计库，审计降级不影响告警）。

### 6.2 事件类型（kind 枚举）

| kind | severity | 触发条件（周期评估，默认 60s 一次） |
| --- | --- | --- |
| `balance_exhausted` | critical | 账号余额确认 ≤ 0（非部分同步结果） |
| `credits_expiring` | warning | 账号最早到期积分 < 阈值 `alert_credits_expiry_days`（默认 3 天）且仍有剩余 |
| `token_circuit` | warning | 账号认证熔断激活（fail_until > now） |
| `catalog_sync_failed` | warning | 账号余额/目录同步失败（sync_error 存在） |
| `audit_degraded` | critical | 审计存储降级（failure_count>0 或不可用） |
| `pool_exhausted` | critical | 全池无可服务账号（即 /healthz 503 的同口径触底） |

- 去重与节流：同一 `kind + account_id`（全局事件为 kind）在 `alert_throttle_seconds`（默认 3600s）内不重复投递；条件持续存在时节流窗口过后会重发（重提醒语义）。
- 评估器由 `alert_evaluator_interval_seconds` 控制周期（默认 60s，0 关闭周期评估，事件历史与手动投递不受影响）。
- 线程按需启动，默认部署无任何常驻告警线程：`alert_enabled=false`（默认）时安装与 `/admin/status` 轮询都不起线程；发送线程在首次投递时才启动；评估器在告警打开（安装时 `alert_enabled=true`）或首次访问告警 API（events/channels/test 任一）时启动。`/admin/status` 的 `alerts.evaluator_running` 反映评估器是否在运行。

### 6.3 通道配置读取：`GET /admin/alerts/channels`

```json
{
  "generated_at": 1718083200.0,
  "alert_enabled": true,
  "channels": {
    "webhook": {
      "enabled": true,
      "url_masked": "https://hook.example.com/path",   // 脱敏：去掉 userinfo/query
      "has_secret": true,                              // 原 url 是否含 query/userinfo
      "headers_template": {"X-Service": "codebuddy2api"}
    },
    "bark": {
      "enabled": false,
      "server": "https://api.day.app",
      "key_masked": "abcd****"                         // 前 4 位 + 掩码
    },
    "email": {
      "enabled": false,
      "smtp_host": "smtp.example.com",
      "smtp_port": 465,
      "username": "alert@example.com",
      "password_masked": "********",                   // 已设置时固定 8 星号，未设置 null
      "from": "alert@example.com",
      "to": ["ops@example.com"],
      "use_tls": true
    }
  },
  "persisted": true                                    // false=仅内存（无可写数据目录时）
}
```

- 读端点**永不回显密钥**：webhook 明文 url、bark key、smtp password 均返回掩码字段。

### 6.4 通道配置写入：`PUT /admin/alerts/channels`

请求体（全量覆盖语义；未提供通道键视为禁用该通道）：

```json
{
  "channels": {
    "webhook": {"enabled": true, "url": "https://hook.example.com/path?token=SECRET"},
    "bark": {"enabled": true, "server": "", "key": "abcdef1234", "sound": "bell", "group": "cb2api"},
    "email": {
      "enabled": true, "smtp_host": "smtp.example.com", "smtp_port": 465,
      "username": "alert@example.com", "password": "secret",
      "from": "alert@example.com", "to": ["ops@example.com", "ops2@example.com"], "use_tls": true
    }
  }
}
```

- 校验（失败 400，不部分写入）：
  - `webhook.url`：http/https，必有主机名，禁止 userinfo；整 URL 长度 ≤ 500。
  - `bark`：`server` 空时默认 `https://api.day.app`，非空必须 https；`key` 1..128 安全字符；`sound`/`group` 可选，≤64 字符。
  - `email`：`smtp_host` 非空（≤200）；`smtp_port` 1..65535；`from` 与 `to`（1..8 个）为简单邮箱格式；`use_tls` 布尔；`password` 允许空字符串（中继免密）。
  - 每个通道对象禁止未知字段。
- 响应：与 6.3 相同的脱敏结构（`alert_enabled` 不变），`persisted` 标志落盘结果；落盘失败 503（内存值已更新，提示检查数据目录权限）。
- 投递行为：异步（专用发送线程）、有限重试（`alert_retry_count` 次，退避 1s/2s/4s 上限 30s）、单次超时 `alert_timeout_seconds`（默认 10s）；**任何通道故障都不阻塞请求路径与评估器**。
- 通用 webhook 负载（JSON POST，头 `Content-Type: application/json`、`X-Service: codebuddy2api`、`X-Alert-Kind`）：

```json
{
  "service": "codebuddy2api", "version": "1.3.2-local",
  "kind": "credits_expiring", "severity": "warning",
  "title": "标题", "detail": "详情", "account_id": "9b2c",
  "context": {"remaining_credits": 120.0, "days_remaining": 2.1},
  "fired_at": 1718081000.0
}
```

### 6.5 通道测试：`POST /admin/alerts/test?channel=webhook`

- 参数 `channel` ∈ {webhook, bark, email}（必填）。
- 发送一条 severity=info 的测试事件（kind=`channel_test`），**绕过去重**，同步等待结果（线程池执行，不占用事件循环）。
- 响应：

```json
{"channel": "webhook", "ok": true, "attempts": 1, "duration_ms": 312.4, "error": null}
```

- 通道未启用或未配置 400；投递超时/失败为 200 且 `ok=false` + `error`（该结果也写入事件历史，kind=`channel_test`，供排障）。

### 6.6 阈值与开关

告警全局开关与阈值走 **settings**（`/admin/settings` 读写，支持热更新；见第 8 节键表），通道密钥走 6.3/6.4 的独立端点（避免明文出现在 settings 响应中）。

---

## 7. 积分到期提醒卡片：`GET /admin/credits/expiry?days=30&burn_days=7`

FEFO（先到期先出）明细 + 日均需耗，供首页提醒卡片。

- 参数：`days`（展示窗口，1..90，默认 30：仅列出到期日落在此窗口内的段）；`burn_days`（日均需耗统计窗口，1..30，默认 7）。
- 响应：

```json
{
  "generated_at": 1718083200.0,
  "threshold_days": 3,              // = alert_credits_expiry_days，供卡片标记紧急
  "burn_window_days": 7,
  "summary": {
    "expiring_accounts": 2,         // 窗口内有到期段的账号数
    "expiring_credits": 300.0,      // 窗口内到期段的剩余积分合计
    "urgent_accounts": 1,           // days_remaining < threshold_days 的账号数
    "total_credits": 5200.0,        // 全部账号剩余合计（已知口径）
    "daily_burn": 45.2,             // 全部账号日均需耗（burn 窗口总额/天数）
    "daily_burn_known": true        // false=审计库降级或无样本
  },
  "items": [
    {
      "account_id": "9b2c",
      "name": "xxx.info",
      "profile": "cn-cli",
      "remaining_credits": 520.0,   // 账号全部剩余（可能为 null=未知）
      "daily_burn": 12.4,           // 该账号日均需耗（该窗口 credit 消耗 / 天数），无样本 null
      "soonest_expiry": 1718265600.0,
      "days_remaining": 2.1,
      "projected_exhaustion_days": 41.9,  // remaining/daily_burn，daily_burn<=0 或未知为 null
      "urgent": true,               // days_remaining < threshold_days
      "segments": [                 // FEFO 明细（按到期升序，只保留 remaining>0）
        {
          "remaining": 120.0, "total": 500.0,
          "expires_at": 1718265600.0,
          "source": "旗舰版连续包月",
          "package_code": "p_tcaca_m_x",
          "in_window": true         // 到期日在 days 窗口内
        }
      ]
    }
  ]
}
```

- 日均需耗来源：审计库 per-credential 聚合的 credit 指标在 burn 窗口内的总和 ÷ 窗口天数；审计降级时该账号 `daily_burn=null` 且 `daily_burn_known=false`。
- 余额/段数据来自既有积分快照（`/admin/credits` 同源），不触发上游请求。
- `items` 按 `days_remaining` 升序（未知到期排最后），无到期段的账号不出现在 items 中。

---

## 8. 新增 settings 键（`/admin/settings` 可读写，env 可覆盖）

| 键 | 类型 | 默认 | env | 热更新 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `alert_enabled` | boolean | false | `CODEBUDDY2API_ALERT_ENABLED` | 是 | 告警总开关 |
| `alert_credits_expiry_days` | integer | 3 | `CODEBUDDY2API_ALERT_CREDITS_EXPIRY_DAYS` | 是 | 积分将到期提醒阈值（天） |
| `alert_credits_burn_days` | integer | 7 | `CODEBUDDY2API_ALERT_CREDITS_BURN_DAYS` | 是 | 日均需耗统计窗口（天） |
| `alert_throttle_seconds` | integer | 3600 | `CODEBUDDY2API_ALERT_THROTTLE_SECONDS` | 是 | 同事件去重/节流窗口 |
| `alert_history_limit` | integer | 200 | `CODEBUDDY2API_ALERT_HISTORY_LIMIT` | 是 | 事件历史最大条数（10..1000） |
| `alert_evaluator_interval_seconds` | integer | 60 | `CODEBUDDY2API_ALERT_EVALUATOR_INTERVAL_SECONDS` | 是 | 评估周期秒（0 关闭周期评估） |
| `alert_timeout_seconds` | number | 10 | `CODEBUDDY2API_ALERT_TIMEOUT_SECONDS` | 是 | 单次投递超时 |
| `alert_retry_count` | integer | 2 | `CODEBUDDY2API_ALERT_RETRY_COUNT` | 是 | 投递重试次数（0..5） |
| `stats_tokens_rate_ttfb_ms` | number | 200 | `CODEBUDDY2API_STATS_TOKENS_RATE_TTFB_MS` | 是 | tokens/s 扣除 TTFB 的阈值（低于此值回退端到端） |
| `health_service_name` | string | `codebuddy2api` | `CODEBUDDY2API_HEALTH_SERVICE_NAME` | 是 | 服务身份（/healthz 与 webhook 头） |

- 均为非敏感键，可在 `/admin/settings` 中读写；`.env.example` 同步增补注释。
- `/admin/settings` 的响应结构不变（items 数组追加上述键）。

---

## 9. 变更摘要（对现有 API 的影响）

1. `PATCH /admin/credentials/{id}`：新增 `{"paused": bool}` 请求体形式（enabled 行为不变）。
2. `GET /admin/settings`：items 追加第 8 节键。
3. `GET /admin/dashboard`：**不变**。分位数与 tokens/s 通过第 4 节新端点提供。
4. 新增端点：`/healthz`、`/admin/status`、`/admin/diagnostic`、`/admin/stats/summary`、`/admin/stats/series`、`/admin/stats/dimensions`、`/admin/alerts/events`、`/admin/alerts/channels`（GET/PUT）、`/admin/alerts/test`、`/admin/credits/expiry`。
5. 审计聚合内部新增延迟直方图与 effective_ms 累计（对 `/admin/dashboard` 响应透明，仅新增字段不改变既有字段语义）。

---

## 10. 凭证 paused 开关（Fusion-A 账号池调度与冷却体系）

- 端点：`PATCH /admin/credentials/{id}`，新增请求体形式 `{"paused": bool}`（与既有 `{"enabled"}` /
  `{"auto_checkin"}` / `{"auto_travel"}` / `{"auto_daily_chat"}` 并列，单次请求只接受一个布尔字段）。
- 响应：`{"id": identity, "field": "paused", "paused": <bool>, "revision": <int>}`，与既有字段的响应口径一致；实现可附加 `enabled` 字段（当前实现附加），便于前端同步显示停用状态，两个开关取值相互独立。
- 服务端入口：`gateway.admin_set_credential_paused(identity, paused)`——模块级函数，
  `Management.__getattr__` 转发；管理面以 `getattr(gateway, "admin_set_credential_paused", None)`
  探测，未落地时回退 `admin_set_credential_enabled(identity, not paused)`。
- 池内契约（`CredentialPool`）：
  - `pool.pause(identity, reason="") -> {"changed", "durable"}`：暂停选号；
  - `pool.resume(identity) -> {"changed", "durable"}`：恢复选号（幂等）；
  - `pool.is_paused` 经由 `pool.snapshot()` 行的 `"paused": bool` 暴露给
    `/admin/credentials` 与 `/admin/diagnostic` 的 `accounts[].paused`；
  - 持久化：数据目录 `account-pauses.json`（独立有界 JSON，原子写 0600），重启保留；
    写失败降级为内存态并报 `pause_storage()["last_error"]`。
- 语义边界：
  - 暂停只退出选号（`_candidates` / `headers_for` 重校验），`签到 / 旅行 / 每日打卡 /
    保活刷新 / 余额同步` 照常运行——这些链路只看 `credentials.enabled`，与 paused 正交；
  - 与「停用」（control_store `credentials.enabled=false`）完全独立：停用号不跑任何维护，
  - 暂停号照跑维护；两个状态可以任意叠加（暂停 + 停用 = 停用口径为准）。
  - 粘性会话自愈：被暂停账号不在候选集内，粘性命中自动失效并在下次选号时改绑，
  无需显式清粘性表。
- 相关配置：`account_pause`（`CODEBUDDY2API_ACCOUNT_PAUSE`，默认 true）为总开关，
  false 时暂停状态不再参与选号判定（暂停表本身保留，恢复开关后立即生效）。
