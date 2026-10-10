"""Public management settings; never reads or writes .env or credential files."""
from __future__ import annotations

import math
import os
import re
from urllib.parse import urlsplit


def normalize_allowed_origins(value):
    """Normalize a comma/space separated origin list; bare hosts default to HTTPS."""
    entries = [entry for entry in re.split(r"[\s,]+", value.strip()) if entry]
    if len(entries) > 32:
        raise ValueError("admin_allowed_origins: 来源数量超出上限")
    normalized = []
    for entry in entries:
        candidate = entry if "://" in entry else f"https://{entry}"
        try:
            parts = urlsplit(candidate)
            port = parts.port
        except ValueError:
            raise ValueError(f"admin_allowed_origins: 来源无效 {entry!r}") from None
        if (parts.scheme not in ("http", "https") or not parts.hostname
                or parts.username is not None or parts.password is not None
                or parts.path not in ("", "/") or parts.query or parts.fragment
                or (port is not None and not 1 <= port <= 65535)):
            raise ValueError(f"admin_allowed_origins: 来源无效 {entry!r}")
        host = f"[{parts.hostname}]" if ":" in parts.hostname else parts.hostname
        default_port = 443 if parts.scheme == "https" else 80
        origin = f"{parts.scheme}://{host}" + (f":{port}" if port is not None and port != default_port else "")
        if origin not in normalized:
            normalized.append(origin)
    return ",".join(normalized)


def validate_projection_max_bytes(value):
    """Allow zero or enough room for a bounded head/tail warning."""
    if value != 0 and value < 256:
        raise ValueError("responses_projection_max_bytes 必须为 0 或至少 256")
    return value


def _item(default, type_, label, *, mode="hot", env=None, minimum=None, maximum=None,
          choices=None, sensitive=False, allow_empty=False, max_length=255, validator=None):
    value = {"default": default, "type": type_, "label": label, "mode": mode,
             "env": env, "sensitive": sensitive}
    if minimum is not None:
        value["min"] = minimum
    if maximum is not None:
        value["max"] = maximum
    if choices is not None:
        value["choices"] = choices
    if allow_empty:
        value["allow_empty"] = True
    if max_length != 255:
        value["max_length"] = max_length
    if validator is not None:
        value["validator"] = validator
    return value


SCHEMA = {
    "host": _item("127.0.0.1", "string", "监听地址", mode="restart", env="CODEBUDDY2API_BIND"),
    "port": _item(8787, "integer", "监听端口", mode="restart", env="CODEBUDDY2API_PORT", minimum=1, maximum=65535),
    "api_key": _item(None, "secret", "管理与推理密钥", mode="startup", env="CODEBUDDY2API_KEY", sensitive=True),
    "auth_file": _item(None, "paths", "显式凭证文件", mode="startup", sensitive=True),
    "auth_dir": _item(None, "path", "凭证目录", mode="startup", env="CODEBUDDY_AUTH_DIR", sensitive=True),
    "import_dir": _item(None, "path", "导入目录", mode="startup", env="CODEBUDDY_IMPORT_DIR", sensitive=True),
    "log_path": _item(None, "path", "旧文本日志（已停用）", mode="startup", env="CODEBUDDY2API_LOG", sensitive=True),
    "admin_allowed_origins": _item("", "string", "管理页额外信任来源", env="CODEBUDDY2API_ADMIN_ORIGINS",
                                   allow_empty=True, max_length=2000, validator=normalize_allowed_origins),
    "desensitize": _item(False, "boolean", "提示词脱敏"),
    "no_compact": _item(False, "boolean", "保留提示词全文"),
    "keep_tool_metadata": _item(False, "boolean", "保留工具描述", env="CODEBUDDY2API_KEEP_TOOL_METADATA"),
    "skip_check": _item(False, "boolean", "跳过启动预检", mode="restart"),
    "credit_price_cny": _item(0.014, "number", "国内积分单价", minimum=0),
    "usd_rate": _item(7.15, "number", "美元人民币折算率", minimum=0.000001),
    "credit_price_usd": _item(0.03, "number", "国际积分单价", minimum=0),
    "model_catalog_ttl": _item(21600, "integer", "模型目录缓存秒数", minimum=0, maximum=31536000),
    "model_guard": _item(True, "boolean", "表外模型拦截"),
    "model_capability_guard": _item(True, "boolean", "模型能力预检", env="CODEBUDDY2API_MODEL_CAPABILITY_GUARD"),
    # Fusion 融合层: 账号池调度与冷却（借鉴 workbuddy2api-panel）
    "model_soft_cooldown": _item(True, "boolean", "模型级软冷却（429 按 账号×模型 隔离，对齐重置墙钟）",
                                 env="CODEBUDDY2API_MODEL_SOFT_COOLDOWN"),
    "model_cooldown_s": _item(600, "integer", "429 无重置文案时的模型冷却秒数",
                              env="CODEBUDDY2API_MODEL_COOLDOWN", minimum=1, maximum=86400),
    "model_cooldown_max_s": _item(86400, "integer", "模型软冷却封顶秒数（与持久化天花板一致）",
                                  env="CODEBUDDY2API_MODEL_COOLDOWN_MAX", minimum=60, maximum=86400),
    "model_cooldown_no_stack": _item(True, "boolean", "软冷却中重复 429 不延长冷却、不推进计数",
                                     env="CODEBUDDY2API_MODEL_COOLDOWN_NO_STACK"),
    "auth_fail_threshold": _item(3, "integer", "连续 401/403 多少次才禁用账号",
                                 env="CODEBUDDY2API_AUTH_FAIL_THRESHOLD", minimum=1, maximum=100),
    "auth_disable_seconds": _item(3600, "integer", "达到认证失败阈值后的禁用秒数",
                                  env="CODEBUDDY2API_AUTH_DISABLE_SECONDS", minimum=60, maximum=2592000),
    "account_pause": _item(True, "boolean", "账号级暂停（只退出选号，签到/旅行/保号照跑）",
                           env="CODEBUDDY2API_ACCOUNT_PAUSE"),
    "maintenance_account_gap_s": _item(0.8, "number", "保号任务跨账号循环间休眠秒数（0 关闭）",
                                       env="CODEBUDDY2API_MAINTENANCE_ACCOUNT_GAP", minimum=0, maximum=60),
    "credit_floor": _item(0, "number", "积分保底余额（0 关闭；低于保底的账号不派收费模型）",
                          env="CODEBUDDY2API_CREDIT_FLOOR", minimum=0),
    "credit_floor_cost_alpha": _item(0.3, "number", "扣费台账 EMA 平滑系数",
                                     env="CODEBUDDY2API_CREDIT_FLOOR_COST_ALPHA", minimum=0.01, maximum=1.0),
    "credit_floor_cost_ttl_s": _item(21600, "integer", "扣费台账观测有效期秒数（防跨时段复活）",
                                     env="CODEBUDDY2API_CREDIT_FLOOR_COST_TTL", minimum=60, maximum=2592000),
    "expiring_credit_window_s": _item(604800, "integer", "快过期积分判定窗口秒数（0 关闭加权）",
                                      env="CODEBUDDY2API_EXPIRING_CREDIT_WINDOW", minimum=0, maximum=31622400),
    "expiring_credit_weight": _item(3, "integer", "窗口内快过期账号的选号权重倍数",
                                    env="CODEBUDDY2API_EXPIRING_CREDIT_WEIGHT", minimum=1, maximum=16),
    "max_images": _item(16, "integer", "单请求图片上限", env="CODEBUDDY2API_MAX_IMAGES", minimum=0, maximum=10000),
    "image_policy": _item("truncate", "string", "超额图片策略", env="CODEBUDDY2API_IMAGE_POLICY", choices=["truncate", "error"]),
    "max_request_bytes": _item(32 * 1024 * 1024, "integer", "请求字节上限", env="CODEBUDDY2API_MAX_REQUEST_BYTES", minimum=1, maximum=1024**3),
    "log_body_limit": _item(65536, "integer", "旧文本预览（已停用）", env="CODEBUDDY2API_LOG_BODY_LIMIT", minimum=0, maximum=1024**2),
    "failover_max": _item(0, "integer", "换凭证重放次数", env="CODEBUDDY2API_FAILOVER_MAX",
                          minimum=0, maximum=10),
    "retry_write_timeout": _item(False, "boolean", "写超时参与重放",
                                 env="CODEBUDDY2API_RETRY_WRITE_TIMEOUT"),
    "upstream_keepalive": _item(False, "boolean", "上游连接复用", mode="restart",
                                env="CODEBUDDY2API_UPSTREAM_KEEPALIVE"),
    "max_inflight_per_account": _item(0, "integer", "单账号在途上限（0 不限制）",
                                      env="CODEBUDDY2API_MAX_INFLIGHT_PER_ACCOUNT", minimum=0, maximum=10000),
    "read_timeout": _item(300, "number", "上游流式读取超时秒数", env="CODEBUDDY2API_READ_TIMEOUT",
                          minimum=1, maximum=86400),
    "ttfb_timeout": _item(45.0, "number", "上游首字节超时秒数（0 关闭）", env="CODEBUDDY2API_TTFB_TIMEOUT",
                          minimum=0, maximum=86400),
    "stream_idle_timeout": _item(60.0, "number", "上游流空闲超时秒数（0 关闭）",
                                 env="CODEBUDDY2API_STREAM_IDLE_TIMEOUT", minimum=0, maximum=86400),
    "stream_tools": _item(False, "boolean", "带 tools 请求逐字节流式",
                          env="CODEBUDDY2API_STREAM_TOOLS"),
    "coalesce_reasoning": _item(True, "boolean", "思考链合并成单块（上游 v1.3.2 行为）；关闭则逐帧实时流式",
                                 env="CODEBUDDY2API_COALESCE_REASONING"),
    "thinking_pin_models": _item("deepseek", "string", "思考开关注入模型子串（逗号分隔，空关闭）",
                                 env="CODEBUDDY2API_THINKING_PIN_MODELS", allow_empty=True,
                                 max_length=500),
    "request_context_mode": _item("legacy", "string", "请求上下文模式",
                                  env="CODEBUDDY2API_REQUEST_CONTEXT_MODE", choices=["legacy", "scoped"]),
    "responses_projection_mode": _item("balanced", "string", "Responses 投影模式",
                                      env="CODEBUDDY2API_RESPONSES_PROJECTION_MODE",
                                      choices=["balanced", "passthrough"]),
    "responses_projection_max_bytes": _item(
        40000, "integer", "Responses 单项字节上限（0 或 ≥256）",
        env="CODEBUDDY2API_RESPONSES_PROJECTION_MAX_BYTES", minimum=0, maximum=33554432,
        validator=validate_projection_max_bytes),
    "stream_mode": _item("compatible", "string", "流式模式（实时模式不重生成工具参数）",
                         env="CODEBUDDY2API_STREAM_MODE", choices=["compatible", "realtime"]),
    "audit_max_bytes": _item(256 * 1024 * 1024, "integer", "审计明细预算", minimum=1024**2, maximum=1024**4),
    "audit_retention_days": _item(30, "integer", "审计明细保留天数", minimum=1, maximum=36500),
    "audit_diagnostic_bytes": _item(8192, "integer", "失败诊断最大字节", minimum=0, maximum=8192),
    # -- 融合层：可观测性、告警与健康 --------------------------------------

    "alert_enabled": _item(False, "boolean", "告警总开关", env="CODEBUDDY2API_ALERT_ENABLED"),
    "alert_credits_expiry_days": _item(3, "integer", "积分将到期提醒阈值（天）",
                                       env="CODEBUDDY2API_ALERT_CREDITS_EXPIRY_DAYS", minimum=1, maximum=90),
    "alert_credits_burn_days": _item(7, "integer", "积分日均需耗统计窗口（天）",
                                     env="CODEBUDDY2API_ALERT_CREDITS_BURN_DAYS", minimum=1, maximum=30),
    "alert_throttle_seconds": _item(3600, "integer", "同事件去重节流窗口（秒）",
                                    env="CODEBUDDY2API_ALERT_THROTTLE_SECONDS", minimum=60, maximum=86400),
    "alert_history_limit": _item(200, "integer", "告警事件历史最大条数",
                                 env="CODEBUDDY2API_ALERT_HISTORY_LIMIT", minimum=10, maximum=1000),
    "alert_evaluator_interval_seconds": _item(60, "integer", "告警评估周期（秒，0 关闭周期评估）",
                                              env="CODEBUDDY2API_ALERT_EVALUATOR_INTERVAL_SECONDS",
                                              minimum=0, maximum=3600),
    "alert_timeout_seconds": _item(10, "number", "告警单次投递超时（秒）",
                                   env="CODEBUDDY2API_ALERT_TIMEOUT_SECONDS", minimum=1, maximum=120),
    "alert_retry_count": _item(2, "integer", "告警投递重试次数",
                               env="CODEBUDDY2API_ALERT_RETRY_COUNT", minimum=0, maximum=5),
    # 聚合记录级固定按 200ms 扣除 TTFB（历史口径需稳定），该键预留给后续下推热调，暂不生效。
    "stats_tokens_rate_ttfb_ms": _item(200, "number", "tokens/s 扣除 TTFB 阈值（毫秒，预留键：暂不生效，固定 200ms）",
                                       env="CODEBUDDY2API_STATS_TOKENS_RATE_TTFB_MS", minimum=0, maximum=60000),
    "health_service_name": _item("codebuddy2api", "string", "服务身份（/healthz 与告警头）",
                                 env="CODEBUDDY2API_HEALTH_SERVICE_NAME", max_length=64),
}


def validate_settings(values, *, legacy=False):
    if not isinstance(values, dict):
        raise ValueError("values 必须是对象")
    clean = {}
    for key, value in values.items():
        if legacy and key == "auto_trial" and type(value) is bool:
            continue  # Retired persisted switch: accept old databases without enabling claims.
        spec = SCHEMA.get(key)
        if spec is None or spec["sensitive"]:
            raise ValueError("未知或启动来源锁定的配置项")
        kind = spec["type"]
        valid = ((kind == "boolean" and type(value) is bool)
                 or (kind == "integer" and type(value) is int)
                 or (kind == "number" and type(value) in (int, float) and math.isfinite(value))
                 or (kind == "string" and isinstance(value, str)
                     and (spec.get("allow_empty") or 0 < len(value))
                     and len(value) <= spec.get("max_length", 255)
                     and not any(ord(c) < 32 for c in value)))
        if not valid:
            raise ValueError(f"{key}: 类型或值无效")
        if "min" in spec and value < spec["min"] or "max" in spec and value > spec["max"]:
            raise ValueError(f"{key}: 超出允许范围")
        if "choices" in spec and value not in spec["choices"]:
            raise ValueError(f"{key}: 不支持的选项")
        if spec.get("validator"):
            value = spec["validator"](value)
        clean[key] = value
    return clean


def apply_persisted_settings(config, explicit=(), environ=None):
    """Resolve startup precedence after CLI parsing; config holds parsed CLI values."""
    environ = os.environ if environ is None else environ
    saved = config["control_store"].snapshot()["settings"] if config.get("control_store") else {}
    sources = dict(config.get("settings_sources", {}))
    for key, spec in SCHEMA.items():
        if key in explicit:
            sources[key] = "cli"
        elif spec["env"] and spec["env"] in environ:
            sources[key] = "environment"
            if not spec["sensitive"]:
                raw = environ[spec["env"]]
                if spec["type"] == "boolean":
                    if raw.lower() not in ("1", "0", "true", "false", "yes", "no", "on", "off"):
                        raise ValueError(f"{key}: 环境变量布尔值无效")
                    raw = raw.lower() in ("1", "true", "yes", "on")
                elif spec["type"] == "integer":
                    raw = int(raw)
                elif spec["type"] == "number":
                    raw = float(raw)
                config.update(validate_settings({key: raw}))
        elif key in saved:
            config[key] = saved[key]
            sources[key] = "management"
        else:
            if key not in config or config[key] is None:
                config[key] = spec["default"]
            sources.setdefault(key, "default")
    config["settings_sources"] = sources
    return config


def resolve_settings(config):
    saved = config["control_store"].snapshot()["settings"] if config.get("control_store") else {}
    sources = config.get("settings_sources", {})
    result = []
    for key, spec in SCHEMA.items():
        source = sources.get(key, "default")
        locked = spec["sensitive"] or source in ("cli", "environment", "env", "dotenv")
        item = {"key": key, "value": None if spec["sensitive"] else (config[key] if config.get(key) is not None else spec["default"]),
                "stored": None if spec["sensitive"] else saved.get(key), "source": source,
                "mode": spec["mode"], "type": spec["type"], "label": spec["label"], "locked": locked}
        item.update({field: spec[field] for field in ("choices", "min", "max") if field in spec})
        result.append(item)
    return result
