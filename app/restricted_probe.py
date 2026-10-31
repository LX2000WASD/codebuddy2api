"""Probe accounts the upstream parked with 403 / 11140, one real chat request at a time.

B1 treats that verdict as durable: the credential is disabled in the control store with no
expiry, and nothing in the gateway ever puts it back on its own. The consequence is that a
restricted account can only return by hand, even though the platform itself is documented
(and observed) to lift restrictions after one to three working days. This module is the one
automated way back, and it is deliberately the narrowest request that can carry the verdict:

* one real POST to /v2/chat/completions, the same endpoint the refusal came from — probing
  credits, catalogs, models or refresh returns 200 for a restricted account (report 30 A4),
  so those endpoints cannot answer the question at all;
* the first message is a system message, because the international gateway rejects a
  user-first conversation with 400 / 11128 and that would look like a dead account;
* a small output cap, since what is being tested is the credential, not the model.

The cost of a wrong "still restricted" is one request every six hours per account; the cost
of never probing is an account that can only be recovered by an operator who remembers it.
Report 21 recommends manual-only probes, and this module deliberately goes further: a switch
exists (restricted_probe), a floor exists (restricted_probe_interval_s), three consecutive
11140 answers back the account off to a day, and one cycle never probes more than one account.
"""
from __future__ import annotations

import threading
import time
import uuid

import httpx

from . import model_policy, model_rates, rate_measurement
from .client_profiles import chat_headers
from .site_routing import chat_url_for_headers, profile_for_headers
from .upstream_compat import channel_fallback_url
from .upstream_io import open_backend_stream_sync

# Same request shape as the rate probe, minus the billing calibration: a fixed nonce'd prompt
# so no earlier probe is a cache hit, and one small completion.
PROBE_SYSTEM_PROMPT = "You are a helpful assistant."
PROBE_MAX_OUTPUT_TOKENS = 16
PROBE_CONVERSATION_PREFIX = "restricted-probe-"
# Three consecutive 11140 answers back the account off to a day: the platform is not going to
# change its mind about a credential it has now refused four times.
PROBE_FAIL_THRESHOLD = 3
PROBE_BACKOFF_S = 24 * 3600
# How often the loop looks for a due account. The floor between two probes of one account is
# the setting, so this only bounds how late a due probe can run.
PROBE_TICK_S = 300
REQUEST_TIMEOUT = httpx.Timeout(60, connect=10, write=15)

_lock = threading.Lock()
# account_key -> {"last_at", "fails", "last_status", "last_code", "released_at"}
_state: dict[str, dict] = {}


def reset_state():
    """Forget every probe record (used by tests and by a manual reset)."""
    with _lock:
        _state.clear()


def state_of(account_key):
    with _lock:
        row = _state.get(account_key)
        return dict(row) if row else {}


def view(config):
    """Per-account probe records for the management views, newest attempt first."""
    rows = []
    with _lock:
        for key, row in _state.items():
            rows.append({"account_key": key, **{name: row.get(name) for name in
                                                ("last_at", "fails", "last_status", "last_code",
                                                 "released_at", "trigger", "message")}})
    rows.sort(key=lambda item: item.get("last_at") or 0, reverse=True)
    return {"enabled": config.get("restricted_probe") is True,
            "interval_s": _interval(config), "fail_threshold": PROBE_FAIL_THRESHOLD,
            "backoff_s": max(_interval(config), PROBE_BACKOFF_S), "accounts": rows}


def _interval(config):
    value = config.get("restricted_probe_interval_s")
    return float(value) if isinstance(value, (int, float)) and value > 0 else 21600.0


def _now():
    return time.time()


def restricted_entries(config, policy=None):
    """Pool entries whose control-store record carries the upstream restriction verdict."""
    pool = config.get("cred_pool")
    if pool is None:
        return []
    out = []
    for entry in pool.entries():
        identity = entry.get("account_key")
        if not identity:
            continue
        restriction = model_policy.credential_restriction(config, entry, policy)
        if restriction["restricted"]:
            out.append((entry, restriction))
    return out


def due_at(config, identity, restricted_at, record=None):
    """The next instant this account may be probed again."""
    record = record if record is not None else state_of(identity)
    base = record.get("last_at") or restricted_at or 0.0
    try:
        base = float(base)
    except (TypeError, ValueError):
        base = 0.0
    interval = _interval(config)
    if (record.get("fails") or 0) >= PROBE_FAIL_THRESHOLD:
        interval = max(interval, PROBE_BACKOFF_S)
    return base + interval


def _probe_model(gateway, entry):
    """A model this account's own catalog serves, free-rate ones first."""
    catalogs = gateway.CONFIG.get("account_catalogs") or {}
    account = catalogs.get(entry.get("account_key")) or {}
    scope = gateway._catalog_account_scope(account, "serves") if account else []
    items = gateway._usable_models(scope) if scope else []
    if not items:
        return None
    free = [item for item in items if model_rates.is_free_multiplier(item.get("credits"))]
    return (free or items)[0]["id"]


def _one_chat(gateway, entry, model):
    """Send the probe and return (status, code, message). Never raises for a refusal."""
    cm = entry["cm"]
    with cm._lock:
        headers = cm.get_headers()
    headers.update(gateway._dynamic_request_headers(None))
    headers["X-Conversation-ID"] = PROBE_CONVERSATION_PREFIX + uuid.uuid4().hex
    headers["Accept"] = "text/event-stream"
    headers = chat_headers(headers)
    profile = profile_for_headers(headers)
    routed = gateway._upstream_model(model, profile)
    body = {"model": routed, "stream": True, "stream_options": {"include_usage": True},
            "max_tokens": PROBE_MAX_OUTPUT_TOKENS,
            "messages": [{"role": "system", "content": PROBE_SYSTEM_PROMPT},
                         {"role": "user", "content": rate_measurement.probe_prompt()}]}
    url = chat_url_for_headers(headers)
    with httpx.Client(follow_redirects=False, timeout=REQUEST_TIMEOUT) as client:
        with open_backend_stream_sync(client, url, headers=headers, body=body,
                                      fallback_url=channel_fallback_url(url)) as (response, raw):
            if response.status_code != 200:
                # Classify with the same reader the inference path uses, so "11140" here means
                # exactly what B1 parks an account for.
                code, message, _body = gateway._upstream_diagnostic(raw or b"")
                return response.status_code, None if code is None else str(code), message or ""
            # Drain so the connection closes cleanly; the answer itself is not used.
            for _chunk in response.iter_bytes():
                break
    return 200, None, ""


def probe(gateway, entry, *, trigger="auto"):
    """Probe one restricted account exactly once and apply the verdict.

    Only a 200 releases the account, and only through control_store.clear_restricted: this
    function never touches fail_until, cooldowns, restricted_at or the credential files, so a
    failed probe leaves the durable restriction exactly as B1 wrote it.
    """
    config = gateway.CONFIG
    identity = entry.get("account_key")
    if not identity:
        return {"ok": False, "status": None, "code": None, "released": False, "message": "账号指纹缺失"}
    model = _probe_model(gateway, entry)
    started = _now()
    if not model:
        _record(identity, started, status=None, code="no_model", trigger=trigger,
                message="账号目录里没有可用模型，等下一次")
        return {"ok": False, "status": None, "code": "no_model", "released": False,
                "message": "账号目录里没有可用模型"}
    try:
        status, code, message = _one_chat(gateway, entry, model)
    except Exception as error:  # Transport failure: not evidence about the restriction.
        status, code, message = None, type(error).__name__, str(error)
    released = False
    if status == 200:
        released = _release(gateway, identity)
    _record(identity, started, status=status, code=code, trigger=trigger,
            released=released, message=message[:200])
    _log(gateway, identity, status, code, released)
    _event(gateway, identity, status, code, released, trigger=trigger)
    return {"ok": status == 200, "status": status, "code": code, "released": released,
            "message": message[:200], "model": model}


def _record(identity, started, *, status, code, trigger, released=False, message=""):
    with _lock:
        row = _state.setdefault(identity, {"fails": 0})
        row.update(last_at=started, last_status=status, last_code=code, trigger=trigger,
                   message=message)
        if status == 200:
            row["fails"] = 0
            row["released_at"] = started
        elif code == "11140":
            row["fails"] = int(row.get("fails") or 0) + 1


def _release(gateway, identity):
    store = gateway.CONFIG.get("control_store")
    if store is None:
        return False
    try:
        return bool(store.clear_restricted(identity))
    except Exception as error:
        _log(gateway, identity, 200, None, False, note=f"解除停权写入失败: {type(error).__name__}")
        return False


def _log(gateway, identity, status, code, released, *, note=""):
    label = "已解封" if released else ("仍受限" if code == "11140" else f"未解封 HTTP {status}")
    detail = f" | {note}" if note else ""
    gateway._log(f"[probe] 受限号探活 @ {str(identity)[:12]}… | {label}"
                 f"{(' code=' + str(code)) if code and code != '11140' else ''}{detail}")


def _event(gateway, identity, status, code, released, *, trigger):
    """One audit row per probe so the count of probes and releases is answerable later."""
    store = gateway.CONFIG.get("audit_store")
    action = getattr(store, "event", None)
    if not callable(action):
        return
    try:
        action("runtime", "credential.restricted_probe", {
            "credential": identity, "trigger": trigger, "http_status": status,
            "upstream_code": code, "released": released, "source": "probe"})
    except Exception:
        pass  # Audit owns its own failure mode; a probe must not fail because of logging.


def run_once(gateway):
    """Probe at most one due restricted account; returns its result or None.

    One account per cycle keeps probes serial: two restricted credentials answering at the
    same instant is the pattern the platform's own client never produces.
    """
    config = gateway.CONFIG
    if config.get("restricted_probe") is not True:
        return None
    now = _now()
    candidates = []
    for entry, restriction in restricted_entries(config):
        identity = entry["account_key"]
        due = due_at(config, identity, restriction.get("restricted_at"))
        if due <= now:
            candidates.append((due, identity, entry))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0])
    _due, identity, entry = candidates[0]
    return probe(gateway, entry, trigger="auto")


def probe_now(gateway, identity):
    """Manual entry point: probe one named account now, whatever the switch and the floor say.

    The operator asking is the strongest signal there is, so neither the global switch nor
    the per-account floor applies here; what still applies is one request, no retry.
    """
    pool = gateway.CONFIG.get("cred_pool")
    if pool is None:
        return {"ok": False, "status": None, "code": None, "released": False,
                "message": "账号池未就绪"}
    entry = next((item for item in pool.entries() if item.get("account_key") == identity), None)
    if entry is None:
        return {"ok": False, "status": None, "code": None, "released": False,
                "message": "账号不存在"}
    return probe(gateway, entry, trigger="manual")


def loop(gateway):
    """Background loop: one due probe per tick, skipped entirely while the switch is off."""
    while True:
        try:
            run_once(gateway)
        except Exception as error:
            gateway._log(f"[probe] 循环异常: {type(error).__name__}")
        time.sleep(PROBE_TICK_S)
