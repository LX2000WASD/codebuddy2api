#!/usr/bin/env python3
"""Bound raw inference request bytes before JSON parsing and replay accepted bodies unchanged."""

from __future__ import annotations

import json


import asyncio


_GATED_PATHS = ("/v1/chat/completions", "/v1/responses", "/v1/messages")
_BODY_PATHS = (*_GATED_PATHS, "/v1/messages/count_tokens")


class _ResizableGate(asyncio.Semaphore):
    """Semaphore whose capacity follows a hot-reloaded setting.

    asyncio.Semaphore has no public resize, and rebuilding it would strand the
    permits held by in-flight requests on the discarded object. The gate never
    queues (callers check locked() before acquiring), so no waiters need waking.
    """

    def resize(self, capacity: int) -> None:
        self._value = max(0, capacity)


class _BypassCharge:
    """Tracks whether one unlimited-era request has been charged against gate capacity."""

    __slots__ = ("charged",)

    def __init__(self):
        self.charged = False


class ConcurrencyLimitMiddleware:
    """Reject excess inference concurrency with HTTP 503 and retain slots through response completion."""

    def __init__(self, app, config):
        self.app = app
        self.config = config
        self._semaphore = None
        self._active = 0          # Gated requests currently inside the application
        self._bypass = set()      # _BypassCharge for each in-flight unlimited-era request
        self._limit_at_gate = None

    def _charge_bypass(self):
        """Charge every still-running unlimited-era request once against the new capacity."""
        for holder in self._bypass:
            holder.charged = True

    def _gate(self):
        limit = self._limit()
        if self._semaphore is None:
            # Requests admitted while the limit was 0 are already in flight; charge
            # them against the new capacity instead of granting a fresh full budget.
            # Semaphore rejects a negative initial value, so clamp like resize() does.
            self._charge_bypass()
            self._semaphore = _ResizableGate(max(0, limit - self._active))
            self._limit_at_gate = limit
        elif self._limit_at_gate != limit:
            # Hot reload: keep the remaining capacity at exactly limit - in-flight so
            # locked() stays equivalent to "in-flight == limit" in both directions.
            self._charge_bypass()
            self._limit_at_gate = limit
            self._semaphore.resize(limit - self._active)
        return self._semaphore

    def _limit(self) -> int:
        try:
            return max(0, int(self.config.get("max_concurrent") or 0))
        except (TypeError, ValueError):
            return 0

    async def __call__(self, scope, receive, send):
        if (scope["type"] != "http" or scope.get("method") != "POST"
                or scope.get("path", "") not in _GATED_PATHS):
            return await self.app(scope, receive, send)
        limit = self._limit()
        if limit <= 0:
            # Unlimited, but still counted: raising the limit later must apply to
            # requests already in flight instead of oversubscribing the new gate.
            # None marks the gate as stale, because these requests consume _active
            # without consuming a permit. Without it, 64 -> 0 -> 64 would compare
            # equal and skip the resize, leaving capacity at limit + (bypassed).
            self._limit_at_gate = None
            holder = _BypassCharge()
            self._bypass.add(holder)
            self._active += 1
            try:
                return await self.app(scope, receive, send)
            finally:
                self._active -= 1
                self._bypass.discard(holder)
                # A resize while this request ran subtracted it from the capacity, so
                # give that permit back; otherwise the loss is permanent.
                if holder.charged and self._semaphore is not None:
                    self._semaphore.release()
        gate = self._gate()
        if gate.locked():  # Reject overload without queueing request bodies.
            error = {"message": "inference concurrency limit reached, retry later",
                     "type": "rate_limit_error", "code": "concurrency_limit"}
            payload = {"error": error}
            if scope["path"] == "/v1/messages":
                error["type"] = "api_error"
                payload["type"] = "error"
            raw = json.dumps(payload).encode()
            await send({"type": "http.response.start", "status": 503,
                        "headers": [(b"content-type", b"application/json"), (b"retry-after", b"3"),
                                    (b"content-length", str(len(raw)).encode())]})
            await send({"type": "http.response.body", "body": raw})
            return
        await gate.acquire()
        self._active += 1
        try:
            await self.app(scope, receive, send)
        finally:
            self._active -= 1
            gate.release()


class InboundBodyLimitMiddleware:
    """Buffer only inference and token-estimation POST bodies."""

    def __init__(self, app, config):
        self.app = app
        self.config = config

    async def __call__(self, scope, receive, send):
        if (scope["type"] != "http" or scope.get("method") != "POST"
                or scope.get("path", "") not in _BODY_PATHS):
            return await self.app(scope, receive, send)
        try:
            limit = int(self.config.get("max_inbound_bytes") or 0)
        except (TypeError, ValueError):
            limit = 0
        if limit <= 0:
            return await self.app(scope, receive, send)

        body = bytearray()
        more = True
        while more:
            message = await receive()
            if message["type"] == "http.request":
                body.extend(message.get("body", b""))
                more = bool(message.get("more_body"))
                if len(body) > limit:
                    return await self._reject(send, scope["path"], limit)
            elif message["type"] == "http.disconnect":
                return

        buffered = bytes(body)
        replayed = False

        async def replay():
            nonlocal replayed
            if replayed:
                return await receive()  # Body completion does not imply client disconnect.
            replayed = True
            return {"type": "http.request", "body": buffered, "more_body": False}

        await self.app(scope, replay, send)

    @staticmethod
    async def _reject(send, path: str, limit: int):
        # Middleware builds protocol-shaped errors before routing.
        if path.startswith("/v1/messages"):
            payload = {"type": "error", "error": {"type": "invalid_request_error",
                                                  "message": f"request body exceeds {limit} bytes",
                                                  "code": "request_too_large"}}
        else:
            payload = {"error": {"message": f"request body exceeds {limit} bytes",
                                 "type": "invalid_request_error", "code": "request_too_large"}}
        raw = json.dumps(payload).encode("utf-8")
        await send({"type": "http.response.start", "status": 413,
                    "headers": [(b"content-type", b"application/json"),
                                (b"content-length", str(len(raw)).encode())]})
        await send({"type": "http.response.body", "body": raw})
