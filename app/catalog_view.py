#!/usr/bin/env python3
"""Pure request/response and model-catalog view helpers extracted from converter.py.

These were the parts of converter.py that touch neither the mutable CONFIG global,
the FastAPI app object, nor module-level caches, so they can live outside the
5000-line gateway module without changing behaviour.

Functions that read CONFIG (the catalog-resolution chain) or hold a process-global
cache deliberately stayed behind: moving them would have meant threading CONFIG
through every call site, which is an architecture change rather than a split.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import HTTPException

from .model_rates import is_free_multiplier
from .request_context import SessionIdentifierError, current_context
from .site_routing import profile_region

_REQUEST_POLICY_KEY = object()  # Process-local object key; never serializable or client injectable.


def auth_dirs() -> list[Path]:
    """Locate desktop credentials used only as seed files."""
    home = Path.home()
    plat = sys.platform
    if plat == "darwin":
        return [home / "Library" / "Application Support" / "CodeBuddyExtension" / "Data" / "Public" / "auth"]
    if plat == "win32":
        local = Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local"))
        return [local / "CodeBuddyExtension" / "Data" / "Public" / "auth"]
    xdg = Path(os.environ.get("XDG_DATA_HOME", home / ".local" / "share"))
    return [xdg / "CodeBuddyExtension" / "Data" / "Public" / "auth"]


def _credential_account(data: dict) -> dict:
    """Return the account block, preferring a populated ``account`` object.

    An empty ``account`` object must not shadow a populated ``accounts[0]``: some
    exports carry both, and treating ``{}`` as authoritative makes the credential
    look like it has no uid at all.
    """
    account = data.get("account")
    if isinstance(account, dict) and account:
        return account
    accounts = data.get("accounts")
    candidate = accounts[0] if isinstance(accounts, list) and accounts and isinstance(accounts[0], dict) else None
    if candidate:
        return candidate
    return account if isinstance(account, dict) else {}


def _msg_text(m: dict) -> str:
    c = m.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(p.get("text", "") for p in c if isinstance(p, dict))
    return ""


_RESET_DATETIME_RE = re.compile(
    r"(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2}:\d{2})\s*(?:UTC\s*([+-]?\d{1,2}))?",
    re.IGNORECASE,
)


_RESET_DATE_TIME_JOIN_RE = re.compile(r"(\d{4}-\d{2}-\d{2})(\d{1,2}:\d{2}:\d{2})")


_RESET_DEFAULT_UTC_OFFSET = 8


_RESET_MIN_AHEAD_SECONDS = -60


_RESET_MAX_AHEAD_SECONDS = 30 * 86400


def _parse_reset_time(raw: bytes) -> float | None:
    """Parse a quota reset timestamp from a 429 body and return epoch seconds.

    Handles both observed upstream wordings: the English form ("... will reset at
    2026-09-13 17:11:34 UTC+8 ...") and the Chinese form (可在2026-09-1322:05:37重置 —
    full-width colons, no space between date and time, no timezone marker). Returns
    None when nothing parses so callers fall back to the model cooldown default.
    """
    try:
        text = raw.decode("utf-8", "replace")
    except Exception:
        return None
    # Normalize: full-width colons/minus -> half-width; restore missing date-time space.
    text = text.replace("：", ":").replace("－", "-")
    text = _RESET_DATE_TIME_JOIN_RE.sub(r"\1 \2", text)
    m = _RESET_DATETIME_RE.search(text)
    if not m:
        return None
    try:
        hour, minute, second = (int(part) for part in m.group(2).split(":"))
        dt = datetime.strptime(
            f"{m.group(1)} {hour:02d}:{minute:02d}:{second:02d}", "%Y-%m-%d %H:%M:%S"
        )
        offset = int(m.group(3)) if m.group(3) else _RESET_DEFAULT_UTC_OFFSET
        stamp = dt.replace(tzinfo=timezone(timedelta(hours=offset))).timestamp()
    except (ValueError, OverflowError):
        return None
    delta = stamp - time.time()
    if delta < _RESET_MIN_AHEAD_SECONDS or delta > _RESET_MAX_AHEAD_SECONDS:
        return None
    return stamp


def _block_model(model: str | None) -> str | None:
    """Track blocked models by public ID, normalizing the international auto alias."""
    return "auto" if model == "default-model" else model


def _bearer_token(headers: dict) -> str:
    return (headers.get("Authorization") or "").removeprefix("Bearer ").strip()


def _truncate(s: str, n: int = 80) -> str:
    s = str(s).replace("\n", " ").strip()
    return s[:n] + ("…" if len(s) > n else "")


def _in_region(profile: str, region: str | None) -> bool:
    return region is None or profile_region(profile) == region


def _usable_models(models):
    return [model for model in models or [] if model.get("id") and model.get("supportsToolCall")
            and not model.get("disabled")]


def _account_scope(account: dict, scope: str = "models") -> list[dict] | None:
    """Merge root candidates into selector models while retaining selector metadata."""
    picker = account.get("models")
    if scope == "models" or picker is None:
        return picker
    seen = {item.get("id") for item in picker}
    # Root entries supply missing names without replacing selector metadata.
    return picker + [item for item in account.get("serves") or [] if item.get("id") not in seen]


def _free_multiplier(credits) -> bool:
    """Check whether the account's catalog explicitly declares a zero credit rate."""
    return is_free_multiplier(credits)


def _client_wants_stream(payload: dict) -> bool:
    """Default stream to false and reject non-Boolean values."""
    value = payload.get("stream", False)
    if not isinstance(value, bool):
        raise HTTPException(status_code=400, detail={"error": {
            "message": "stream must be a boolean", "type": "invalid_request_error", "param": "stream"}})
    return value


def _normalize_tool_choice(body):
    """Map named tool choice to a single required tool for string-only upstream selection."""
    choice = body.get("tool_choice")
    if not isinstance(choice, dict):
        return
    function = choice.get("function", choice)
    name = function.get("name") if isinstance(function, dict) else None
    tools = body.get("tools")
    matches = [tool for tool in tools if isinstance(tool, dict) and tool.get("type") == "function"
               and isinstance(tool.get("function"), dict) and tool["function"].get("name") == name] if isinstance(tools, list) else []
    if choice.get("type") != "function" or not isinstance(name, str) or not name.strip() or len(matches) != 1:
        raise HTTPException(status_code=400, detail={"error": {"message": "tool_choice must name exactly one declared function",
                            "type": "invalid_request_error", "param": "tool_choice"}})
    body["tools"], body["tool_choice"] = matches, "required"


def _bind_request_session(payload, body):
    context = current_context()
    if context is not None and context.scoped:
        try:
            context.bind_session(payload, body.get("messages"))
        except SessionIdentifierError as error:
            raise HTTPException(status_code=400, detail={"error": {"message": str(error),
                                "type": "invalid_request_error", "param": "session_id"}}) from None
        except (ValueError, TypeError, UnicodeError, RecursionError):
            raise HTTPException(status_code=400, detail={"error": {"message": "invalid session input",
                                "type": "invalid_request_error"}}) from None


def _request_id():
    context = current_context()
    return context.request_id if context is not None else uuid.uuid4().hex


def _reasoning_requested(body: dict) -> bool:
    """客户端是否显式要求推理输出：reasoning_effort 存在且不为 off。"""
    effort = body.get("reasoning_effort")
    return isinstance(effort, str) and effort.strip().lower() not in ("", "off", "none", "disabled")


def _upstream_chat_body(body: dict) -> dict:
    """Exclude process-local metadata from both wire JSON and its byte budget."""
    return {key: value for key, value in body.items()
            if key is not _REQUEST_POLICY_KEY and not (isinstance(key, str) and key.startswith("_"))}


def _last_user_text(messages: list) -> str:
    """Extract the latest user text for bounded log previews."""
    for m in reversed(messages):
        if m.get("role") != "user":
            continue
        content = m.get("content", "")
        if isinstance(content, list):
            for blk in content:
                if isinstance(blk, dict) and blk.get("type") == "text":
                    return str(blk.get("text", ""))
            return ""
        return str(content)
    return ""


def _chat_completion(merged: dict) -> dict:
    message = {"role": "assistant", "content": merged["content"] or None}
    for key in ("reasoning_content", "refusal", "tool_calls"):
        if merged.get(key):
            message[key] = merged[key]
    return {
        "id": "chatcmpl-" + os.urandom(12).hex(), "object": "chat.completion",
        "created": int(time.time()), "model": merged.get("model") or "unknown",
        "choices": [{"index": 0, "message": message,
                     "finish_reason": merged.get("finish_reason") or ("tool_calls" if merged.get("tool_calls") else "stop")}],
        "usage": merged.get("usage") or {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


def _completion_to_merged(result: dict) -> dict:
    choice = result["choices"][0]
    return {**choice["message"], "finish_reason": choice["finish_reason"],
            "model": result.get("model"), "usage": result.get("usage")}


def _declared_tool_names(body: dict) -> frozenset[str]:
    """Extract declared function names for conservative realtime identity boundaries."""
    names = set()
    for tool in body.get("tools") or []:
        if not isinstance(tool, dict):
            continue
        function = tool.get("function")
        if isinstance(function, dict) and isinstance(function.get("name"), str):
            names.add(function["name"])
        elif isinstance(tool.get("name"), str):
            names.add(tool["name"])
    return frozenset(name for name in names if name)


def _strip_zwsp(text: str) -> str:
    """响应侧剥离 U+200B：聊天输出里零宽字符没有语义，只会是提示词零宽的回声泄漏。"""
    return text.replace("\u200b", "") if "\u200b" in text else text


def _chunk_bytes(chunk, charset: str = "utf-8"):
    return chunk if isinstance(chunk, (bytes, memoryview)) else chunk.encode(charset)


def _estimate_input_tokens(payload: dict) -> int:
    """Estimate tokens from character counts and message overhead, not upstream billing."""

    def measure(value) -> int:
        if isinstance(value, str):
            ascii_chars = sum(1 for ch in value if ord(ch) < 128)
            return (ascii_chars + 3) // 4 + (len(value) - ascii_chars)
        if isinstance(value, list):
            return sum(measure(item) for item in value)
        if isinstance(value, dict):
            return sum(measure(item) for item in value.values())
        return 0

    total = measure(payload.get("system")) + measure(payload.get("tools"))
    messages = payload.get("messages")
    if isinstance(messages, list):
        for message in messages:
            if isinstance(message, dict):
                total += measure(message.get("content")) + 4  # Message structure overhead.
    return total


def _nonnegative_int(value):
    number = int(value)
    if number < 0:
        raise argparse.ArgumentTypeError("必须为非负整数")
    return number


def _nonnegative_number(value):
    number = float(value)
    if not number >= 0 or number != number:
        raise argparse.ArgumentTypeError("必须为非负数")
    return number


def _origins_arg(value):
    from app.settings import normalize_allowed_origins
    try:
        return normalize_allowed_origins(value)
    except ValueError:
        raise argparse.ArgumentTypeError("必须为逗号分隔的 http/https 来源或域名") from None


def _boolean_arg(value):
    if isinstance(value, bool):
        return value
    normalized = str(value).strip().lower()
    if normalized in ("true", "1", "yes", "on"):
        return True
    if normalized in ("false", "0", "no", "off"):
        return False
    raise argparse.ArgumentTypeError("必须为 true 或 false")
