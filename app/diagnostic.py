"""Fusion diagnostic aggregation: per-account cooldown reasons and the pool-wide model lock view.

Everything reported here is derived from existing pool state, the persisted
cooldown table and the account inventory; the view never reads upstream bodies
or tokens, and reason strings stay short and fixed so they cannot leak them.
"""
from __future__ import annotations

import hashlib
import time

from fastapi import Request
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse

from .admin_auth import error_response
from .health_endpoints import pool_counts
from .site_routing import DOMAIN_PROFILES

_REASON_LIMIT = 200
_MAX_LOCKS = 512


def _safe_text(value, limit=_REASON_LIMIT):
    if not isinstance(value, str):
        return None
    text = "".join(ch for ch in value if ch.isprintable())[:limit]
    return text or None


def _identity(entry, path):
    """Same identity formula as Management.admin_credential_inventory."""
    return entry.get("account_key") or hashlib.sha256(str(path).encode()).hexdigest()


def _account_view(row, identity, now):
    """Project one inventory row into the diagnostic account readout.

    The inventory already resolves enabled/health/paused; this view only adds
    the human-readable reason for why the account is not serving traffic.
    """
    enabled = bool(row.get("enabled"))
    paused = row.get("paused") if isinstance(row.get("paused"), bool) else (not enabled)
    health = row.get("health") or ("disabled" if not enabled else "ready")
    reason = None
    if health == "disabled":
        reason = "人工停用"
    elif health == "circuit_open":
        reason = "认证熔断"
    elif health == "expired":
        reason = "登录身份过期"
    elif health == "error":
        reason = "同步失败" if row.get("sync_error") else "后端错误"
    until = float(row.get("fail_until") or 0)
    cooldowns = []
    for item in (row.get("cooldowns") or [])[:64]:
        if not isinstance(item, dict):
            continue
        deadline = float(item.get("until") or 0)
        if deadline <= now:
            continue
        cooldowns.append({"model": _safe_text(item.get("model"), 160) or "unknown",
                          "until": deadline, "remaining_seconds": max(0.0, round(deadline - now, 1))})
    return {"id": identity, "name": _safe_text(row.get("name"), 160) or "unknown",
            "profile": _safe_text(row.get("profile"), 64) or "unknown",
            "health": health, "enabled": enabled, "paused": paused,
            "disabled_reason": reason,
            "cooldown": {"fail_until": until,
                         "remaining_seconds": max(0.0, round(until - now, 1)) if until > now else 0.0,
                         "reason": _safe_text(row.get("last_error_code") or row.get("sync_error"), 160)},
            "model_cooldowns": cooldowns,
            "last_error_code": _safe_text(row.get("last_error_code"), 80),
            "last_failure_at": float(row.get("last_failure_at") or 0) or None,
            "sync_error": _safe_text(row.get("sync_error"), _REASON_LIMIT),
            "catalog_ready": bool(row.get("catalog_ready"))}


def _model_locks(config, now):
    """Aggregate per-account model cooldowns and backend model blocks by profile+model."""
    pool = config.get("cred_pool")
    if pool is None:
        return []
    try:
        with pool._lock:
            entries = {entry["id"]: entry for entry in pool.entries()}
            failures = {key: value for key, value in pool._model_fail.items() if value > now}
            blocks = pool.model_blocks_detail() if hasattr(pool, "model_blocks_detail") else []
    except Exception:
        return []
    grouped: dict[tuple, dict] = {}
    for (path, model), deadline in sorted(failures.items(), key=lambda item: item[1]):
        entry = entries.get(path) or {}
        profile = entry.get("profile") or "unknown"
        key = (profile, model)
        group = grouped.setdefault(key, {"profile": profile, "model": model, "kind": "rate_limit",
                                        "reason": "模型额度冷却", "account_ids": [], "deadlines": []})
        group["account_ids"].append(_identity(entry, path))
        group["deadlines"].append(deadline)
        if len(grouped) > _MAX_LOCKS:
            break
    for block in (blocks or [])[:_MAX_LOCKS]:
        endpoint = str(block.get("endpoint") or "")
        host = endpoint.split("#", 1)[0]
        profile = DOMAIN_PROFILES.get(host.rsplit("/", 1)[-1]) if host else None
        if profile is None and host:
            # Tolerate a bare host (no scheme) recorded by older block snapshots.
            bare = host if "://" not in host else host.split("://", 1)[1].split("/", 1)[0]
            profile = DOMAIN_PROFILES.get(bare)
        model = _safe_text(block.get("model"), 160) or "unknown"
        key = (profile or "unknown", model)
        deadline = float(block.get("until") or 0)
        if deadline <= now:
            continue
        group = grouped.setdefault(key, {"profile": profile or "unknown", "model": model,
                                        "kind": "model_block", "reason": "后端模型不可用",
                                        "account_ids": [], "deadlines": []})
        if block.get("msg"):
            group["reason"] = _safe_text(block.get("msg"), 120) or group["reason"]
        group["deadlines"].append(deadline)
        group["advisory"] = True
    locks = []
    for key in sorted(grouped, key=lambda k: (str(k[0]), str(k[1])))[:_MAX_LOCKS]:
        group = grouped[key]
        deadlines = sorted(float(d) for d in group.pop("deadlines"))
        account_ids = sorted({str(item) for item in group.pop("account_ids")})
        lock = {"profile": group.pop("profile"), "model": group.pop("model"),
                "locked_accounts": len(account_ids), "account_ids": account_ids,
                "earliest_unlock_at": deadlines[0] if deadlines else 0.0,
                "latest_unlock_at": deadlines[-1] if deadlines else 0.0,
                "all_unlock_in_seconds": max(0.0, round(deadlines[-1] - now, 1)) if deadlines else 0.0,
                "kind": group.pop("kind", "rate_limit"), "reason": group.pop("reason", None)}
        if group.get("advisory"):
            lock["advisory"] = True
        locks.append(lock)
    return locks


def diagnostic(config):
    """Build the full diagnostic payload from pool state and the credential inventory."""
    now = time.time()
    management = config.get("management")
    rows = []
    if management is not None:
        try:
            inventory = management.admin_credential_inventory()
        except Exception:
            inventory = []
        for row in inventory:
            if not isinstance(row, dict):
                continue
            rows.append(_account_view(row, str(row.get("id") or ""), now))
    counts = pool_counts(config)
    cooldown_view = {"available": False, "degraded": True, "rows": None, "last_error": None}
    pool = config.get("cred_pool")
    if pool is not None and hasattr(pool, "cooldown_storage"):
        try:
            cooldown_view = pool.cooldown_storage()
        except Exception as error:
            cooldown_view["last_error"] = str(error)[:200]
    return {"generated_at": now,
            "pool": {"total": counts["total"], "healthy": counts["healthy"],
                     "servable": counts["servable"]},
            "accounts": rows, "model_locks": _model_locks(config, now),
            "cooldown_storage": cooldown_view}


def install(app, config):
    """Register the diagnostic endpoint behind management authentication."""

    @app.get("/admin/diagnostic")
    async def admin_diagnostic(request: Request):
        try:
            return await run_in_threadpool(lambda: JSONResponse(diagnostic(config)))
        except ValueError as error:
            return error_response(400, str(error))
        except Exception:
            return error_response(500, "诊断聚合读取失败，请检查存储状态后重试")
