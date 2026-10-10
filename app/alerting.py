"""Fusion alerting: bounded event history, delivery channels and a periodic evaluator.

Design rules that must hold on every path:

* recording an event never blocks or raises into the caller; the audit store may
  be one of the things being alerted about, so alerting owns independent state;
* delivery happens on a dedicated sender thread with a bounded queue, bounded
  retries and a per-attempt timeout; channel failures are recorded as delivery
  outcomes, never propagated to callers;
* channel secrets (webhook URL query, Bark key, SMTP password) are persisted
  under the data directory with 0600 permissions and are only ever returned in
  masked form;
* threads start lazily: the sender exists only once an event is queued for
  delivery, and the evaluator is raised by an enabled setting or the first
  alerting request, so a default deployment gains no resident threads;
* the evaluator is a probe loop over existing management state; it never opens
  new upstream connections and defers to the pool and ledger snapshots.
"""
from __future__ import annotations

import json
import os
import queue
import re
import secrets
import smtplib
import threading
import time
from email.mime.text import MIMEText
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import Request
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse

from .admin_auth import error_response
from .health_endpoints import int_param, float_param, service_name

BARK_DEFAULT_SERVER = "https://api.day.app"
KIND_SEVERITY = {
    "balance_exhausted": "critical",
    "credits_expiring": "warning",
    "token_circuit": "warning",
    "catalog_sync_failed": "warning",
    "audit_degraded": "critical",
    "pool_exhausted": "critical",
    "channel_test": "info",
}
CHANNELS = ("webhook", "bark", "email")
_QUEUE_LIMIT = 512
_TEXT_LIMIT = 200
_DETAIL_LIMIT = 500
_TO_LIMIT = 8
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_RETRY_BACKOFF = (1.0, 2.0, 4.0, 8.0, 16.0, 30.0)


def _setting(config, key, default=None):
    """Read a settings value from the live config, falling back to its schema default."""
    value = config.get(key)
    if value is None:
        from .settings import SCHEMA
        spec = SCHEMA.get(key) or {}
        value = spec.get("default")
    return default if value is None else value


def _finite(value):
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def _clean_context(context):
    """Bound a machine-readable context to safe scalars; never free-form objects."""
    if not isinstance(context, dict):
        return {}
    result = {}
    for key, value in list(context.items())[:32]:
        name = str(key)[:64]
        if isinstance(value, bool):
            result[name] = value
        elif isinstance(value, (int, float)):
            number = _finite(value)
            if number is not None:
                result[name] = round(number, 4)
        elif isinstance(value, str):
            result[name] = value[:_TEXT_LIMIT]
    return result


def _safe_text(value, limit):
    if not isinstance(value, str):
        return ""
    return "".join(ch for ch in value if ch.isprintable())[:limit]


def _valid_url(url, *, https_only=False):
    if not isinstance(url, str) or len(url) > 500:
        raise ValueError("webhook 地址必须是 http/https URL")
    parts = urlsplit(url.strip())
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
        raise ValueError("webhook 地址必须是 http/https 且不含用户名密码")
    if https_only and parts.scheme != "https":
        raise ValueError("仅支持 https 地址")
    return url.strip()


def _valid_email(value, field):
    if not isinstance(value, str) or not _EMAIL.fullmatch(value.strip()):
        raise ValueError(f"邮箱地址无效：{field}")
    return value.strip()


def _validate_channels(channels):
    """Validate a full channel replacement; unknown fields or shapes are rejected whole."""
    if not isinstance(channels, dict) or set(channels) - set(CHANNELS):
        raise ValueError("通道键只能是 webhook、bark、email")
    result = {}

    webhook = channels.get("webhook") or {}
    if set(webhook) - {"enabled", "url"}:
        raise ValueError("webhook 通道包含未知字段")
    enabled = webhook.get("enabled")
    if enabled is not None and not isinstance(enabled, bool):
        raise ValueError("webhook.enabled 必须是布尔值")
    result["webhook"] = {"enabled": bool(enabled), "url": _valid_url(webhook.get("url")) if webhook.get("url") else ""}

    bark = channels.get("bark") or {}
    if set(bark) - {"enabled", "server", "key", "sound", "group"}:
        raise ValueError("bark 通道包含未知字段")
    enabled = bark.get("enabled")
    if enabled is not None and not isinstance(enabled, bool):
        raise ValueError("bark.enabled 必须是布尔值")
    server = (bark.get("server") or "").strip()
    if server:
        server = _valid_url(server, https_only=True)
    key = _safe_text(bark.get("key"), 128)
    if bark.get("enabled") and not key:
        raise ValueError("bark 通道启用时必须填写 key")
    result["bark"] = {"enabled": bool(enabled), "server": server or BARK_DEFAULT_SERVER, "key": key,
                      "sound": _safe_text(bark.get("sound"), 64) or "",
                      "group": _safe_text(bark.get("group"), 64) or ""}

    email = channels.get("email") or {}
    if set(email) - {"enabled", "smtp_host", "smtp_port", "username", "password", "from", "to", "use_tls"}:
        raise ValueError("email 通道包含未知字段")
    enabled = email.get("enabled")
    if enabled is not None and not isinstance(enabled, bool):
        raise ValueError("email.enabled 必须是布尔值")
    port = email.get("smtp_port")
    if port is None:
        port = 465
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise ValueError("email.smtp_port 必须是 1..65535 的整数")
    # An absent recipient list is only valid when the channel stays disabled; a
    # present one must be a bounded list of well-formed addresses.
    recipients = email.get("to")
    if recipients is None:
        recipients = []
    elif not isinstance(recipients, list) or not all(isinstance(item, str) for item in recipients):
        raise ValueError(f"email.to 必须是 1..{_TO_LIMIT} 个收件邮箱列表")
    elif not 1 <= len(recipients) <= _TO_LIMIT:
        raise ValueError(f"email.to 必须是 1..{_TO_LIMIT} 个收件邮箱列表")
    result["email"] = {"enabled": bool(enabled),
                       "smtp_host": _safe_text(email.get("smtp_host"), 200),
                       "smtp_port": port,
                       "username": _safe_text(email.get("username"), 200),
                       "password": email.get("password") if isinstance(email.get("password"), str) else "",
                       "from": _safe_text(email.get("from"), 200),
                       "to": [_valid_email(item, "to") for item in recipients],
                       "use_tls": bool(email.get("use_tls", True))}
    if result["email"]["enabled"]:
        if not result["email"]["smtp_host"]:
            raise ValueError("email 通道启用时必须填写 SMTP 主机")
        if not result["email"]["from"]:
            raise ValueError("email 通道启用时必须填写发件人")
    return result


def mask_url(url):
    """Render a webhook URL without its userinfo or query, flagging the hidden part."""
    if not isinstance(url, str) or not url:
        return None, False
    parts = urlsplit(url)
    if not parts.scheme or not parts.hostname:
        return None, False
    host = f"[{parts.hostname}]" if ":" in parts.hostname else parts.hostname
    default_port = 443 if parts.scheme == "https" else 80
    shown = parts.port not in (None, default_port)
    masked = f"{parts.scheme}://{host}" + (f":{parts.port}" if shown else "") + (parts.path or "")
    hidden = bool(parts.query or parts.fragment or parts.username or parts.password)
    return masked, hidden


class AlertBus:
    """Owns channels, event history and delivery; thread-safe and independently persisted."""

    def __init__(self, path=None, *, settings=None, clock=time.time):
        self.path = str(path) if path else None
        self._settings = settings or (lambda key, default=None: default)
        self._clock = clock
        self._lock = threading.RLock()
        self._channels: dict = {"webhook": {"enabled": False, "url": ""},
                                "bark": {"enabled": False, "server": BARK_DEFAULT_SERVER, "key": "",
                                         "sound": "", "group": ""},
                                "email": {"enabled": False, "smtp_host": "", "smtp_port": 465,
                                          "username": "", "password": "", "from": "", "to": [],
                                          "use_tls": True}}
        self._events: list[dict] = []
        self._suppressed: dict[str, float] = {}
        self.storage_error = None
        self._queue: queue.Queue = queue.Queue(maxsize=_QUEUE_LIMIT)
        # The sender starts on the first real delivery, not at construction: a
        # default deployment (alerting off) must gain no resident thread here.
        self._sender = None
        self._sender_started = False
        self._evaluator = None
        self._stop = threading.Event()
        self._load()

    # -- settings plumbing ------------------------------------------------

    def _setting(self, key, default=None):
        try:
            return self._settings(key, default)
        except Exception:
            return default

    def _service(self):
        return str(self._setting("health_service_name", "codebuddy2api") or "codebuddy2api")

    def _version(self):
        return str(self._setting("service_version", "") or "")

    # -- persistence ------------------------------------------------------

    def _load(self):
        if not self.path:
            return
        try:
            document = json.loads(Path(self.path).read_text(encoding="utf-8"))
        except (OSError, ValueError, RecursionError):
            # A damaged state file is not reused, but alerting must still run.
            return
        if not isinstance(document, dict) or document.get("version") != 1:
            return
        channels = document.get("channels")
        if isinstance(channels, dict):
            try:
                self._channels = _validate_channels(channels)
            except ValueError:
                pass
        events = document.get("events")
        if isinstance(events, list):
            now = self._clock()
            for item in events[-self._history_limit() * 2:]:
                if not isinstance(item, dict) or not isinstance(item.get("kind"), str):
                    continue
                if not isinstance(item.get("fired_at"), (int, float)):
                    continue
                self._events.append(item)
            self._events = self._events[-self._history_limit():]
        suppressed = document.get("suppressed")
        if isinstance(suppressed, dict):
            now = self._clock()
            self._suppressed = {str(key): float(value) for key, value in suppressed.items()
                                if isinstance(value, (int, float)) and float(value) > now}

    def _history_limit(self):
        # The settings schema enforces 10..1000; the bus itself only clamps to
        # keep a misconfigured value usable rather than inflating it.
        limit = self._setting("alert_history_limit", 200)
        try:
            limit = int(limit)
        except (TypeError, ValueError):
            limit = 200
        return max(1, min(limit, 1000))

    def _save_locked(self):
        """Persist under the lock; a failure is reported, never raised."""
        if not self.path:
            return True
        try:
            document = {"version": 1, "channels": self._channels,
                        "events": self._events[-self._history_limit():],
                        "suppressed": {key: value for key, value in self._suppressed.items()
                                       if value > self._clock()}}
            candidate = Path(str(self.path) + ".tmp")
            candidate.parent.mkdir(parents=True, exist_ok=True)
            candidate.write_text(json.dumps(document, ensure_ascii=False, separators=(",", ":")),
                                 encoding="utf-8")
            os.replace(candidate, self.path)
            os.chmod(self.path, 0o600)
            self.storage_error = None
            return True
        except (OSError, ValueError, RecursionError, TypeError) as error:
            self.storage_error = str(error)[:200]
            return False

    # -- events ------------------------------------------------------------

    def record(self, kind, *, severity=None, title="", detail="", account_id=None, context=None,
               deliver=True):
        """Record one event; returns whether it landed or was suppressed by throttling."""
        if kind not in KIND_SEVERITY:
            raise ValueError("未知告警事件类型")
        now = self._clock()
        severity = severity or KIND_SEVERITY[kind]
        key = f"{kind}:{account_id or ''}"
        with self._lock:
            if now < self._suppressed.get(key, 0.0):
                return {"recorded": False, "throttled": True}
            event = {"id": "evt-" + secrets.token_hex(8), "kind": kind, "severity": severity,
                     "title": _safe_text(title, _TEXT_LIMIT), "detail": _safe_text(detail, _DETAIL_LIMIT),
                     "account_id": _safe_text(account_id, 160) or None,
                     "context": _clean_context(context), "fired_at": round(now, 3), "delivered": []}
            self._events.append(event)
            self._events = self._events[-self._history_limit():]
            self._suppressed[key] = now + self._throttle_seconds()
            saved = self._save_locked()
        if deliver and self._setting("alert_enabled", False):
            self._ensure_sender()
            self._enqueue(event)
        return {"recorded": True, "throttled": False, "id": event["id"], "persisted": saved}

    def _throttle_seconds(self):
        try:
            return max(60, min(int(self._setting("alert_throttle_seconds", 3600)), 86400))
        except (TypeError, ValueError):
            return 3600

    def _ensure_sender(self):
        """Start the sender thread once, on the first queued delivery."""
        if self._sender_started:
            return
        with self._lock:
            if self._sender_started:
                return
            self._sender = threading.Thread(target=self._sender_loop, name="alert-sender", daemon=True)
            self._sender.start()
            self._sender_started = True

    def _enqueue(self, event):
        try:
            self._queue.put_nowait(event)
        except queue.Full:
            # The queue is bounded on purpose; a saturated sender means delivery
            # is already behind, so the newest event waits for the next one.
            pass

    def events(self, limit=50, kinds=None, severity=None, since=None):
        with self._lock:
            items = list(self._events)
        if kinds:
            items = [item for item in items if item.get("kind") in kinds]
        if severity:
            items = [item for item in items if item.get("severity") == severity]
        if since is not None:
            items = [item for item in items if (item.get("fired_at") or 0) >= since]
        items.sort(key=lambda item: item.get("fired_at") or 0, reverse=True)
        return [dict(item, context=dict(item.get("context") or {}),
                     delivered=[dict(row) for row in (item.get("delivered") or [])])
                for item in items[:max(1, min(int(limit), 500))]]

    def status(self):
        with self._lock:
            last = self._events[-1].get("fired_at") if self._events else None
            pending = self._queue.qsize()
        return {"enabled": bool(self._setting("alert_enabled", False)),
                "evaluator_running": self._evaluator is not None and self._evaluator.is_alive(),
                "pending_deliveries": pending, "last_event_at": last,
                "history_limit": self._history_limit(), "storage_error": self.storage_error,
                "persisted": bool(self.path) and self.storage_error is None}

    # -- channels ----------------------------------------------------------

    def channels_masked(self):
        with self._lock:
            channels = json.loads(json.dumps(self._channels))
        webhook_url, hidden = mask_url(channels["webhook"].get("url"))
        email = channels["email"]
        password = email.get("password")
        return {"generated_at": self._clock(), "alert_enabled": bool(self._setting("alert_enabled", False)),
                "channels": {
                    "webhook": {"enabled": bool(channels["webhook"].get("enabled")),
                                "url_masked": webhook_url, "has_secret": hidden,
                                "headers_template": {"X-Service": self._service()}},
                    "bark": {"enabled": bool(channels["bark"].get("enabled")),
                             "server": channels["bark"].get("server") or BARK_DEFAULT_SERVER,
                             "key_masked": self._mask_key(channels["bark"].get("key"))},
                    "email": {"enabled": bool(email.get("enabled")),
                              "smtp_host": email.get("smtp_host"), "smtp_port": email.get("smtp_port"),
                              "username": email.get("username"),
                              "password_masked": "********" if password else None,
                              "from": email.get("from"), "to": list(email.get("to") or []),
                              "use_tls": bool(email.get("use_tls"))}},
                "persisted": bool(self.path) and self.storage_error is None}

    @staticmethod
    def _mask_key(key):
        if not isinstance(key, str) or not key:
            return None
        return key[:4] + "****"

    def update_channels(self, payload):
        """Validate and install a full channel replacement; returns the masked readout."""
        if not isinstance(payload, dict) or not isinstance(payload.get("channels"), dict):
            raise ValueError("请求体缺少 channels 对象")
        validated = _validate_channels(payload["channels"])
        with self._lock:
            self._channels = validated
            saved = self._save_locked()
        readout = self.channels_masked()
        readout["persisted"] = saved
        readout["storage_error"] = self.storage_error
        return readout

    # -- delivery ----------------------------------------------------------

    def _sender_loop(self):
        while True:
            event = self._queue.get()
            if event is None:
                break
            try:
                self._deliver(event)
            except Exception:
                # Delivery faults never kill the sender; the outcome is on the event.
                pass

    def _deliver(self, event):
        with self._lock:
            channels = json.loads(json.dumps(self._channels))
        outcomes = []
        for name in CHANNELS:
            channel = channels.get(name) or {}
            if not channel.get("enabled"):
                continue
            result = self._deliver_to(name, channel, event)
            outcomes.append({"channel": name, "ok": result["ok"], "at": round(self._clock(), 3),
                             "error": result["error"]})
        if outcomes:
            with self._lock:
                for stored in reversed(self._events):
                    if stored.get("id") == event.get("id"):
                        stored["delivered"] = outcomes
                        break
                self._save_locked()

    def _deliver_to(self, name, channel, event):
        retries = self._setting("alert_retry_count", 2)
        try:
            retries = max(0, min(int(retries), 5))
        except (TypeError, ValueError):
            retries = 2
        timeout = self._setting("alert_timeout_seconds", 10)
        timeout = _finite(timeout) or 10.0
        payload = self._payload(event)
        error = None
        attempts = 0
        for attempt in range(retries + 1):
            attempts += 1
            try:
                if name == "webhook":
                    _send_webhook(channel, payload, timeout)
                elif name == "bark":
                    _send_bark(channel, payload, timeout)
                else:
                    _send_email(channel, payload, timeout)
                return {"ok": True, "error": None, "attempts": attempts}
            except Exception as exc:
                error = str(exc)[:200]
                if attempt < retries:
                    time.sleep(_RETRY_BACKOFF[min(attempt, len(_RETRY_BACKOFF) - 1)])
        return {"ok": False, "error": error, "attempts": attempts}

    def _payload(self, event):
        return {"service": self._service(), "version": self._version(),
                "kind": event.get("kind"), "severity": event.get("severity"),
                "title": event.get("title"), "detail": event.get("detail"),
                "account_id": event.get("account_id"),
                "context": event.get("context") or {}, "fired_at": event.get("fired_at")}

    def test_channel(self, name):
        """Deliver one synthetic event through a single channel, bypassing throttling."""
        if name not in CHANNELS:
            raise ValueError("通道名称无效")
        with self._lock:
            channel = json.loads(json.dumps(self._channels.get(name) or {}))
        if not channel.get("enabled"):
            raise ValueError("该通道未启用")
        event = {"id": "evt-" + secrets.token_hex(8), "kind": "channel_test", "severity": "info",
                 "title": "通道测试", "detail": f"{self._service()} 告警通道 {name} 测试通知",
                 "account_id": None, "context": {"channel": name}, "fired_at": round(self._clock(), 3),
                 "delivered": []}
        started = time.monotonic()
        result = self._deliver_to(name, channel, event)
        event["delivered"] = [{"channel": name, "ok": result["ok"], "at": round(self._clock(), 3),
                               "error": result["error"]}]
        with self._lock:
            self._events.append(event)
            self._events = self._events[-self._history_limit():]
            self._save_locked()
        return {"channel": name, "ok": result["ok"], "attempts": result["attempts"],
                "duration_ms": round((time.monotonic() - started) * 1000, 1), "error": result["error"],
                "event_id": event["id"]}

    def attach_evaluator(self, evaluator):
        """Keep the evaluator handle so close() can stop its loop too."""
        self._evaluator = evaluator.thread
        self._evaluator_object = evaluator

    def close(self):
        evaluator = getattr(self, "_evaluator_object", None)
        if evaluator is not None:
            evaluator.stop_now()
        self._stop.set()
        try:
            self._queue.put_nowait(None)
        except queue.Full:
            pass

# -- channel senders -------------------------------------------------------


def _send_webhook(channel, payload, timeout):
    url = channel.get("url")
    if not url:
        raise ValueError("webhook 地址未配置")
    with httpx.Client(timeout=timeout, follow_redirects=False, verify=True) as client:
        response = client.post(url, json=payload, headers={
            "Content-Type": "application/json",
            "X-Service": str(payload.get("service") or "codebuddy2api"),
            "X-Alert-Kind": str(payload.get("kind") or "")})
    if not 200 <= response.status_code < 300:
        raise RuntimeError(f"webhook 返回 HTTP {response.status_code}")


def _send_bark(channel, payload, timeout):
    server = (channel.get("server") or BARK_DEFAULT_SERVER).rstrip("/")
    key = channel.get("key")
    if not key:
        raise ValueError("bark key 未配置")
    body = {"title": f"[{payload.get('severity')}] {payload.get('title')}",
            "body": str(payload.get("detail") or "")}
    if channel.get("sound"):
        body["sound"] = channel["sound"]
    if channel.get("group"):
        body["group"] = channel["group"]
    with httpx.Client(timeout=timeout, follow_redirects=False, verify=True) as client:
        response = client.post(f"{server}/{key}", json=body,
                               headers={"Content-Type": "application/json"})
    if not 200 <= response.status_code < 300:
        raise RuntimeError(f"bark 返回 HTTP {response.status_code}")


def _send_email(channel, payload, timeout):
    host = channel.get("smtp_host")
    port = channel.get("smtp_port") or 465
    if not host:
        raise ValueError("SMTP 主机未配置")
    lines = [str(payload.get("title") or ""), "", str(payload.get("detail") or "")]
    context = payload.get("context") or {}
    if context:
        lines.append("")
        lines.extend(f"{key}: {value}" for key, value in context.items())
    if payload.get("account_id"):
        lines.append(f"账号: {payload['account_id']}")
    lines.append(f"触发时间: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(payload.get('fired_at') or time.time()))}")
    message = MIMEText("\n".join(lines), "plain", "utf-8")
    message["Subject"] = f"[{payload.get('severity')}] {payload.get('title')}"
    message["From"] = channel.get("from") or ""
    message["To"] = ", ".join(channel.get("to") or [])
    connect = smtplib.SMTP_SSL if port == 465 else smtplib.SMTP
    smtp = connect(host, port, timeout=min(max(float(timeout), 1.0), 60.0))
    try:
        if port != 465 and channel.get("use_tls", True):
            smtp.starttls()
        username = channel.get("username")
        password = channel.get("password")
        if username and password:
            smtp.login(username, password)
        smtp.sendmail(channel.get("from"), list(channel.get("to") or []), message.as_string())
    finally:
        try:
            smtp.quit()
        except Exception:
            pass


# -- evaluator --------------------------------------------------------------


def _account_events(row, now, expiry_days):
    """Derive per-account alert conditions from one inventory row."""
    identity = row.get("id") or row.get("account_key")
    if not isinstance(identity, str) or not identity:
        return []
    events = []
    name = str(row.get("name") or identity)
    credits = row.get("credits") if isinstance(row.get("credits"), dict) else {}
    segments = [segment for segment in (credits.get("segments") or [])
                if isinstance(segment, dict)]
    remaining = sum(float(segment.get("remaining") or 0) for segment in segments)
    expiries = [float(segment["expires_at"]) for segment in segments
                if isinstance(segment.get("expires_at"), (int, float))
                and float(segment["expires_at"]) > now and float(segment.get("remaining") or 0) > 0]
    if credits and not credits.get("partial") and credits.get("fetched_at") and remaining <= 0:
        events.append(("balance_exhausted", f"账号余额耗尽：{name}",
                       f"账号 {name} 余额已确认耗尽，请补充积分或暂停该账号。",
                       {"remaining_credits": 0.0, "partial": False}))
    if expiries and remaining > 0:
        soonest = min(expiries)
        days_remaining = (soonest - now) / 86400.0
        if days_remaining < expiry_days:
            events.append(("credits_expiring", f"积分即将到期：{name}",
                           f"账号 {name} 剩余 {round(remaining, 2)} 积分将在 {round(days_remaining, 1)} 天后到期。",
                           {"remaining_credits": round(remaining, 2),
                            "days_remaining": round(days_remaining, 2),
                            "soonest_expiry": soonest}))
    until = float(row.get("fail_until") or 0)
    if until > now:
        events.append(("token_circuit", f"账号认证熔断：{name}",
                       f"账号 {name} 认证熔断中，约 {round((until - now) / 60, 1)} 分钟后自动重试。",
                       {"fail_until": until, "remaining_seconds": round(until - now, 1),
                        "reason": str(row.get("last_error_code") or "")[:120]}))
    if row.get("sync_error"):
        events.append(("catalog_sync_failed", f"同步失败：{name}",
                       f"账号 {name} 余额或目录同步失败：{str(row['sync_error'])[:120]}",
                       {"error": str(row["sync_error"])[:120]}))
    return [(kind, title, detail, context, identity) for kind, title, detail, context in events]


class AlertEvaluator:
    """Probes management state on a timer; the bus throttles what actually fires."""

    def __init__(self, bus, config):
        self.bus = bus
        self.config = config
        self.thread = None
        self.stop = threading.Event()

    def evaluate_once(self):
        """Snapshot current pool, credit and audit state and record what changed."""
        now = self.bus._clock()
        expiry_days = self.bus._setting("alert_credits_expiry_days", 3)
        try:
            expiry_days = max(1, min(int(expiry_days), 90))
        except (TypeError, ValueError):
            expiry_days = 3
        management = self.config.get("management")
        if management is not None:
            try:
                rows = management.admin_credential_inventory()
            except Exception:
                rows = []
            for row in rows:
                if not isinstance(row, dict):
                    continue
                for kind, title, detail, context, identity in _account_events(row, now, expiry_days):
                    self.bus.record(kind, title=title, detail=detail,
                                    account_id=identity, context=context)
        audit = self.config.get("audit_store")
        if audit is not None:
            try:
                storage = audit.storage()
                if storage.get("degraded") or storage.get("available") is False:
                    self.bus.record("audit_degraded", title="审计存储降级",
                                    detail="审计日志存储降级或不可用，统计可能不完整。",
                                    context={"failure_count": storage.get("failure_count"),
                                             "dropped_records": storage.get("dropped_records"),
                                             "last_error": str(storage.get("last_error") or "")[:160]})
            except Exception:
                pass
        from .health_endpoints import pool_counts
        try:
            counts = pool_counts(self.config)
            if counts.get("total") and not counts.get("servable"):
                self.bus.record("pool_exhausted", title="全池无可服务账号",
                                detail="所有账号均不可服务（熔断、停用或登录过期），推理请求将返回 503。",
                                context={"total": counts.get("total"), "healthy": counts.get("healthy"),
                                         "cooling": counts.get("cooling"), "disabled": counts.get("disabled"),
                                         "expired": counts.get("expired"), "error": counts.get("error")})
        except Exception:
            pass

    def _loop(self):
        while not self.stop.is_set():
            interval = self.bus._setting("alert_evaluator_interval_seconds", 60)
            try:
                interval = max(0, min(int(interval), 3600))
            except (TypeError, ValueError):
                interval = 60
            if interval > 0:
                try:
                    self.evaluate_once()
                except Exception:
                    # A probe fault must not stop the loop; the next tick retries.
                    pass
            self.stop.wait(max(int(interval), 1) if interval > 0 else 5)

    def start(self):
        if self.thread is not None and self.thread.is_alive():
            return
        self.stop.clear()
        self.thread = threading.Thread(target=self._loop, name="alert-evaluator", daemon=True)
        self.thread.start()

    def stop_now(self):
        self.stop.set()


def get_bus(config, *, state_path=None, version=""):
    """Return (and lazily create) the shared alert bus for this config."""
    bus = config.get("alert_bus")
    if bus is not None:
        return bus

    def settings(key, default=None):
        # The service version is injected at install time; settings schema has no key for it.
        if key == "service_version":
            return version or _setting(config, key, default)
        return _setting(config, key, default)

    bus = AlertBus(state_path, settings=settings)
    config["alert_bus"] = bus
    return bus


async def _body(request, maximum=65536):
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > maximum:
            raise ValueError("请求体超过大小限制")
    try:
        value = json.loads(data or b"{}")
    except (ValueError, UnicodeError, RecursionError):
        raise ValueError("请求体必须是有效 JSON 对象") from None
    if not isinstance(value, dict):
        raise ValueError("请求体必须是 JSON 对象")
    return value


def ensure_evaluator(bus, config):
    """Start the shared evaluator once, on demand.

    The default deployment runs with alerting disabled, and a probe loop there
    would only add a resident thread for nothing: the evaluator starts either
    when alerting is enabled at install time, or on the first alerting request.
    """
    evaluator = config.get("alert_evaluator")
    if evaluator is None:
        evaluator = AlertEvaluator(bus, config)
        config["alert_evaluator"] = evaluator
    evaluator.start()
    bus.attach_evaluator(evaluator)
    return evaluator


def install(app, config, *, state_path=None, version=""):
    """Register the alert endpoints; the evaluator starts lazily behind management auth."""
    bus = get_bus(config, state_path=state_path, version=version)
    # Only spin the probe loop when alerting is actually on; otherwise the first
    # alerting request raises it (ensure_evaluator in the handlers below).
    if bus._setting("alert_enabled", False):
        ensure_evaluator(bus, config)

    def route(method, path):
        def decorate(function):
            async def guarded(request: Request):
                try:
                    return await function(request)
                except ValueError as error:
                    return error_response(400, str(error) or "请求参数无效")
                except Exception:
                    return error_response(500, "告警操作失败，请检查存储状态后重试")
            guarded.__name__ = function.__name__
            app.add_api_route(path, guarded, methods=[method])
            return function
        return decorate

    @route("GET", "/admin/alerts/events")
    async def alerts_events(request):
        ensure_evaluator(bus, config)

        def build():
            limit = int_param(request, "limit", 50, 1, 200)
            since = float_param(request, "since", None)
            severity = (request.query_params.get("severity") or "").strip() or None
            kinds = request.query_params.get("kind") or ""
            kind_set = {item.strip() for item in kinds.split(",") if item.strip()} or None
            if severity and severity not in ("info", "warning", "critical"):
                raise ValueError("severity 参数无效")
            items = bus.events(limit=limit, kinds=kind_set, severity=severity, since=since)
            return JSONResponse({"generated_at": time.time(),
                                 "enabled": bool(bus._setting("alert_enabled", False)),
                                 "items": items, "has_more": False})
        return await run_in_threadpool(build)

    @route("GET", "/admin/alerts/channels")
    async def alerts_channels_get(request):
        ensure_evaluator(bus, config)
        return await run_in_threadpool(lambda: JSONResponse(bus.channels_masked()))

    @route("PUT", "/admin/alerts/channels")
    async def alerts_channels_put(request):
        ensure_evaluator(bus, config)
        payload = await _body(request, 16384)

        def build():
            readout = bus.update_channels(payload)
            status = 200 if readout.get("persisted") else 503
            return JSONResponse(readout, status_code=status)
        return await run_in_threadpool(build)

    @route("POST", "/admin/alerts/test")
    async def alerts_test(request):
        ensure_evaluator(bus, config)
        channel = (request.query_params.get("channel") or "").strip()
        return await run_in_threadpool(lambda: JSONResponse(bus.test_channel(channel)))

