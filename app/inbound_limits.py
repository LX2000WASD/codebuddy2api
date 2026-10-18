#!/usr/bin/env python3
"""Bound raw inference request bytes before JSON parsing and replay accepted bodies unchanged."""

from __future__ import annotations

import json


_GATED_PATHS = ("/v1/chat/completions", "/v1/responses", "/v1/messages")
_BODY_PATHS = (*_GATED_PATHS, "/v1/messages/count_tokens")


class ConcurrencyLimitMiddleware:
    """Reject excess inference concurrency with HTTP 503 and retain slots through response completion.

    Admission is a plain in-flight counter compared against the live setting, not a
    semaphore. A semaphore ties every permit to the capacity generation that issued
    it, so shrinking the limit while requests are in flight has to either strand
    those permits or rewrite the semaphore's internal count; either way the old
    generation's permits come back on release and restore the capacity the limit
    had *before* it was lowered, so a limit of 1 keeps admitting 4. A counter has no
    capacity to restore: each request is measured against whatever the setting says
    at the moment it arrives, in both directions, at any time.
    """

    def __init__(self, app, config):
        self.app = app
        self.config = config
        self._active = 0          # Gated requests currently inside the application

    def _limit(self) -> int:
        try:
            return max(0, int(self.config.get("max_concurrent") or 0))
        except (TypeError, ValueError):
            return 0

    def _admit(self) -> bool:
        """Reserve one in-flight slot, or report that the limit is already reached.

        There is no await between reading _active, comparing it and incrementing it,
        so the check and the reservation are a single uninterrupted step of the
        event loop: two requests can never both claim the last free slot.
        """
        limit = self._limit()
        if limit > 0 and self._active >= limit:
            return False
        # 0 means unlimited, but the request is still counted, so raising the limit
        # later applies to what is already in flight instead of oversubscribing it.
        self._active += 1
        return True

    async def __call__(self, scope, receive, send):
        if (scope["type"] != "http" or scope.get("method") != "POST"
                or scope.get("path", "") not in _GATED_PATHS):
            return await self.app(scope, receive, send)
        if not self._admit():
            return await self._reject(send, scope["path"])
        try:
            await self.app(scope, receive, send)
        finally:
            self._active -= 1

    @staticmethod
    async def _reject(send, path: str):
        """Answer overload without queueing the request body behind a permit."""
        error = {"message": "inference concurrency limit reached, retry later",
                 "type": "rate_limit_error", "code": "concurrency_limit"}
        payload = {"error": error}
        if path == "/v1/messages":
            error["type"] = "api_error"
            payload["type"] = "error"
        raw = json.dumps(payload).encode()
        await send({"type": "http.response.start", "status": 503,
                    "headers": [(b"content-type", b"application/json"), (b"retry-after", b"3"),
                                (b"content-length", str(len(raw)).encode())]})
        await send({"type": "http.response.body", "body": raw})


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
