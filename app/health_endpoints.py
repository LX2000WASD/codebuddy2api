"""Fusion health probes: an unauthenticated liveness endpoint and a guarded status view.

The liveness endpoint mirrors the panel /healthz contract: never authenticated,
answer 2xx/503 only, and carry the service identity in both the body and the
X-Service header so a probe cannot mistake a leftover process on the same port
for this service. The status view reuses the same pool classification but is
only reachable through the management authentication middleware.
"""
from __future__ import annotations

import time

from fastapi import Request
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse

from . import model_policy
from .admin_auth import error_response


def int_param(request: Request, name, default, minimum, maximum):
    """Parse a bounded integer query parameter; anything else is a client error."""
    raw = request.query_params.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        raise ValueError(f"参数 {name} 必须是整数") from None
    if not minimum <= value <= maximum:
        raise ValueError(f"参数 {name} 超出允许范围")
    return value


def float_param(request: Request, name, default=None, minimum=None, maximum=None):
    """Parse an optional numeric query parameter with the same strictness."""
    raw = request.query_params.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = float(str(raw).strip())
    except (TypeError, ValueError):
        raise ValueError(f"参数 {name} 必须是数值") from None
    if value != value or value in (float("inf"), float("-inf")):
        raise ValueError(f"参数 {name} 必须是有限数值")
    if minimum is not None and value < minimum:
        raise ValueError(f"参数 {name} 超出允许范围")
    if maximum is not None and value > maximum:
        raise ValueError(f"参数 {name} 超出允许范围")
    return value


def _zero_counts():
    return {"total": 0, "healthy": 0, "cooling": 0, "disabled": 0,
            "expired": 0, "error": 0, "servable": False, "by_profile": {}}


def pool_counts(config):
    """Classify every pool account with the same states the inventory reports.

    The states must stay in lockstep with Management.admin_credential_inventory
    so /healthz semantics match what the WebUI shows: ready means enabled, no
    sync error, no open circuit breaker and a live token.
    """
    pool = config.get("cred_pool")
    if pool is None:
        return _zero_counts()
    now = time.time()
    try:
        with pool._lock:
            entries = {entry["id"]: entry for entry in pool.entries()}
            rows = pool.snapshot()
    except Exception:
        return _zero_counts()
    counts = _zero_counts()
    counts["total"] = len(rows)
    for row in rows:
        path = row.get("auth_file", "")
        entry = entries.get(path) or {}
        profile = entry.get("profile") or "unknown"
        bucket = counts["by_profile"].setdefault(profile, {"total": 0, "healthy": 0, "servable": False})
        bucket["total"] += 1
        enabled = model_policy.credential_enabled(config, entry)
        until = row.get("fail_until") or 0
        if not enabled:
            state = "disabled"
        elif row.get("error"):
            state = "error"
        elif until > now:
            state = "circuit_open"
        elif row.get("token_expired"):
            state = "expired"
        else:
            state = "ready"
        if state == "ready":
            counts["healthy"] += 1
            bucket["healthy"] += 1
        elif state == "disabled":
            counts["disabled"] += 1
        elif state == "circuit_open":
            counts["cooling"] += 1
        elif state == "expired":
            counts["expired"] += 1
        else:
            counts["error"] += 1
    counts["servable"] = counts["healthy"] > 0
    for bucket in counts["by_profile"].values():
        bucket["servable"] = bucket["healthy"] > 0
    return counts


def service_name(config):
    return str(config.get("health_service_name") or "codebuddy2api")


def install(app, config, *, version=""):
    """Register the health probes; the unauthenticated route stays public by design."""
    started = time.monotonic()

    @app.get("/healthz")
    async def healthz(request: Request):
        counts = await run_in_threadpool(pool_counts, config)
        servable = bool(counts["servable"])
        body = {"service": service_name(config), "version": version,
                "status": "ok" if servable else "degraded",
                "total": counts["total"], "healthy": counts["healthy"],
                "servable": servable, "generated_at": time.time()}
        return JSONResponse(body, status_code=200 if servable else 503,
                            headers={"X-Service": service_name(config)})

    @app.get("/admin/status")
    async def admin_status(request: Request):
        def build():
            counts = pool_counts(config)
            audit = config.get("audit_store")
            audit_view = {"degraded": True, "failure_count": None, "dropped_records": None, "last_error": None}
            if audit is not None:
                try:
                    storage = audit.storage()
                    audit_view = {"degraded": bool(storage.get("degraded")),
                                  "failure_count": storage.get("failure_count"),
                                  "dropped_records": storage.get("dropped_records"),
                                  "last_error": storage.get("last_error")}
                except Exception as error:
                    audit_view["last_error"] = str(error)[:200]
            cooldown_view = {"available": False, "degraded": True, "rows": None, "last_error": None}
            pool = config.get("cred_pool")
            if pool is not None and hasattr(pool, "cooldown_storage"):
                try:
                    cooldown_view = pool.cooldown_storage()
                except Exception as error:
                    cooldown_view["last_error"] = str(error)[:200]
            alerts_view = {"enabled": False, "evaluator_running": False,
                           "pending_deliveries": 0, "last_event_at": None}
            from . import alerting
            bus = alerting.get_bus(config)
            if bus is not None:
                alerts_view = bus.status()
            return JSONResponse({"service": service_name(config), "version": version,
                                 "uptime_seconds": round(time.monotonic() - started, 1),
                                 "generated_at": time.time(), "pool": counts,
                                 "audit": audit_view, "cooldown_storage": cooldown_view,
                                 "alerts": alerts_view})
        try:
            return await run_in_threadpool(build)
        except ValueError as error:
            return error_response(400, str(error))
        except Exception:
            return error_response(500, "服务状态读取失败，请检查存储状态后重试")
