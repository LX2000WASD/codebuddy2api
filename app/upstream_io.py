"""Bound upstream retries and prohibit replay after a response has opened."""

import asyncio
from contextlib import asynccontextmanager
from datetime import timezone
from email.utils import parsedate_to_datetime
import math
import time

import json
import httpx

from app.content_filter import ContentFilterDetector


class UpstreamResponseError(Exception):
    """Preserve upstream HTTP status and error bytes for protocol-specific mapping."""

    def __init__(self, status, raw):
        self.status = status
        self.raw = raw
        super().__init__(f"upstream HTTP {status}")


class UpstreamProtocolError(httpx.RemoteProtocolError):
    """Upstream SSE content is malformed or incomplete; replaying it cannot help."""


class UpstreamTimeout(httpx.ReadTimeout):
    """Upstream sent nothing within the TTFB window or the stream went idle.

    Subclasses httpx.ReadTimeout so existing ``except httpx.HTTPError`` handlers
    keep working; callers opt into failover by matching this type explicitly.
    """


class UpstreamHTTPError(UpstreamResponseError):
    """Distinguish actual upstream HTTP errors from failures synthesized while collecting a response."""

    def __init__(self, status, raw, *, retry_after=None):
        super().__init__(status, raw)
        self.retry_after = retry_after
        self.headers = {"Retry-After": str(retry_after)} if retry_after is not None else {}


MAX_RETRY_AFTER = 86400
MAX_TOOL_CALLS = 256


class StreamOutputBudget:
    """Bound retained output and deferred protocol events across validators and adapters."""

    def __init__(self, max_bytes: int = 0):
        self.max_bytes = max(0, int(max_bytes or 0))
        self.used_bytes = 0

    def charge(self, size: int) -> None:
        if not self.max_bytes:
            return
        used = self.used_bytes + max(0, int(size))
        if used > self.max_bytes:
            raise UpstreamResponseError(502, json.dumps({"error": {
                "message": f"upstream response exceeds the {self.max_bytes}-byte collection budget",
                "type": "upstream_error", "code": "response_too_large"}}).encode())
        self.used_bytes = used

    def charge_text(self, value: str) -> None:
        self.charge(len(value.encode("utf-8")))


def new_tool_state() -> dict:
    """Return the state shared by the accumulator and protocol adapters."""
    return {
        "id": None,
        "name": None,
        "arguments": "",
        "identity_complete": False,
        "identity_emitted": False,
        "_argument_phase": False,
    }


def _tool_identity_ready(state: dict, declared_names=None, *, terminal: bool = False) -> bool:
    """Use the argument phase or terminal marker as the metadata boundary, not string shapes."""
    identity = (state.get("id"), state.get("name"))
    if not all(isinstance(value, str) and value for value in identity):
        return False
    if not terminal and not state.get("_argument_phase"):
        return False
    names = {value for value in (declared_names or ()) if isinstance(value, str) and value}
    return not names or identity[1] in names


def tool_identity_complete(state: dict, declared_names=None, *, terminal: bool = False) -> bool:
    """Refresh and return whether a tool identity is safe to expose."""
    ready = _tool_identity_ready(state, declared_names, terminal=terminal)
    state["identity_complete"] = ready
    return ready


def seal_tool_identity(state: dict, declared_names=None) -> bool:
    """Seal all currently retained identity fields at a terminal boundary."""
    state["_terminal"] = True
    return tool_identity_complete(state, declared_names, terminal=True)


def merge_tool_call_delta(state: dict, tool: dict, *, declared_names=None, charge=None) -> dict:
    """Append Chat metadata fragments without deduplication; keep emitted identities stable."""
    if not isinstance(state, dict):
        raise ValueError("tool state")
    if not isinstance(tool, dict):
        raise ValueError("tool")
    state.setdefault("id", None)
    state.setdefault("name", None)
    state.setdefault("arguments", "")
    state.setdefault("identity_complete", False)
    state.setdefault("identity_emitted", False)
    state.setdefault("_argument_phase", False)
    function = tool.get("function", {})
    if not isinstance(function, dict):
        raise ValueError("function")

    def merge_field(key: str, piece) -> None:
        if piece is None:
            return
        if not isinstance(piece, str):
            raise ValueError(key)
        if not piece:
            return
        current = state.get(key) or ""
        if state.get("identity_emitted"):
            if piece == current:
                return
            raise ValueError("conflicting tool identity")
        # A repeated prefix can be a real delta ("tes" + "t"), not a retransmission.
        if charge is not None:
            charge(piece)
        state[key] = current + piece

    merge_field("id", tool.get("id"))
    merge_field("name", function.get("name"))
    piece = function.get("arguments") or ""
    if not isinstance(piece, str):
        raise ValueError("arguments")
    if piece:
        if charge is not None:
            charge(piece)
        state["arguments"] = (state.get("arguments") or "") + piece
        state["_argument_phase"] = True
    tool_identity_complete(state, declared_names, terminal=bool(state.get("_terminal")))
    return state


def seal_tool_identities(states, declared_names=None) -> None:
    """Seal every state in a tracker at the upstream terminal boundary."""
    for state in (states or {}).values():
        if isinstance(state, dict):
            seal_tool_identity(state, declared_names)


def parse_retry_after(value, *, now=None) -> int | None:
    """Normalize bounded Retry-After seconds or HTTP dates; ignore invalid or expired values."""
    if not isinstance(value, str) or len(value) > 128 or not value.isascii() or not value.isprintable():
        return None
    value = value.strip()
    if not value:
        return None
    try:
        if value.isdecimal():
            delay = int(value)
        else:
            deadline = parsedate_to_datetime(value)
            if deadline.tzinfo is None:
                deadline = deadline.replace(tzinfo=timezone.utc)  # Obsolete HTTP asctime uses GMT.
            delay = deadline.timestamp() - (time.time() if now is None else now)
        return math.ceil(delay) if 0 <= delay <= MAX_RETRY_AFTER else None
    except (TypeError, ValueError, OverflowError):
        return None


class ChatSSEAccumulator:
    """Collect Chat SSE and reject error events, empty output and incomplete streams."""

    def __init__(self, *, collect=True, max_collect_bytes: int = 0, retain_tools=None,
                 budget: StreamOutputBudget | None = None, declared_names=None):
        self.collect = collect
        self.retain_tools = collect if retain_tools is None else bool(retain_tools)
        self.budget = budget if budget is not None else StreamOutputBudget(max_collect_bytes)
        self.max_collect_bytes = self.budget.max_bytes
        self.declared_names = frozenset(
            value for value in (declared_names or ()) if isinstance(value, str) and value)
        self.collected_bytes = 0
        self.content = []
        self.reasoning = []
        self.refusal = []
        self.tools = {}
        self.model = self.finish_reason = self.usage = None
        self.done = self.saw_choice = self.saw_output = False
        self.filter_detector = ContentFilterDetector()

    def feed_line(self, line):
        line = line.strip()
        if not line or not line.startswith("data:"):
            return
        data = line[5:].strip()
        if data == "[DONE]":
            self.done = True
            return
        if self.done:
            # Preserve the historical tolerance for ignored malformed trailers,
            # while rejecting a valid non-empty output frame after [DONE].
            try:
                trailing = json.loads(data)
            except ValueError:
                return
            if (isinstance(trailing, dict) and "choices" not in trailing
                    and trailing.get("error") is None
                    and not any(trailing.get(key) for key in ("content", "reasoning_content", "refusal",
                                                              "tool_calls", "function_call"))):
                return
            raise httpx.RemoteProtocolError("output after [DONE]")
        try:
            chunk = json.loads(data)
        except ValueError:
            raise UpstreamProtocolError("Invalid JSON in upstream SSE") from None
        if not isinstance(chunk, dict):
            raise UpstreamProtocolError("Invalid upstream SSE object")
        if chunk.get("error") is not None:
            raise UpstreamResponseError(502, json.dumps(chunk).encode("utf-8"))
        try:
            self._consume_chunk(chunk)
        except (AttributeError, TypeError, ValueError):
            raise UpstreamProtocolError("Invalid upstream SSE fields") from None

    def _consume_chunk(self, chunk):
        usage = chunk.get("usage")
        if usage is not None:
            if not isinstance(usage, dict):
                raise ValueError("usage")
            for key in ("prompt_tokens", "completion_tokens", "total_tokens", "input_tokens",
                        "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
                if key in usage and (type(usage[key]) is not int or usage[key] < 0):
                    raise ValueError(key)
            for key in ("prompt_tokens_details", "completion_tokens_details"):
                details = usage.get(key)
                if details is not None:
                    if not isinstance(details, dict):
                        raise ValueError(key)
                    for count in details.values():
                        if count is not None and (type(count) is not int or count < 0):
                            raise ValueError(key)
        if chunk.get("model") is not None and not isinstance(chunk["model"], str):
            raise ValueError("model")
        if "choices" in chunk and not isinstance(chunk["choices"], list):
            raise ValueError("choices")
        self.model = chunk.get("model") or self.model
        self.usage = chunk.get("usage") or self.usage
        for choice in chunk.get("choices") or []:
            if not isinstance(choice, dict):
                raise ValueError("choice")
            if choice.get("finish_reason") is not None and not isinstance(choice["finish_reason"], str):
                raise ValueError("finish_reason")
            self.saw_choice = True
            finish_reason = choice.get("finish_reason") or None
            delta = choice.get("delta", {})
            if not isinstance(delta, dict):
                raise ValueError("delta")
            for key in ("content", "reasoning_content", "refusal"):
                if delta.get(key) is not None and not isinstance(delta[key], str):
                    raise ValueError(key)
                if delta.get(key):
                    self.saw_output = True
            if "tool_calls" in delta and not isinstance(delta["tool_calls"], list):
                raise ValueError("tool_calls")
            if self.finish_reason is not None:
                has_output = (any(delta.get(key) for key in ("content", "reasoning_content", "refusal"))
                              or bool(delta.get("tool_calls")) or bool(delta.get("function_call")))
                if has_output:
                    raise ValueError("output after finish_reason")
                if finish_reason is not None and finish_reason != self.finish_reason:
                    raise ValueError("changed finish_reason")
            if finish_reason is not None:
                self.finish_reason = finish_reason
            if self.collect:
                for key in ("content", "reasoning_content", "refusal"):
                    if delta.get(key):
                        self._charge(len(delta[key].encode("utf-8")))
                        getattr(self, key if key != "reasoning_content" else "reasoning").append(delta[key])
            for tool in delta.get("tool_calls") or []:
                if not isinstance(tool, dict):
                    raise ValueError("tool")
                idx = tool.get("index", 0)
                if isinstance(idx, bool) or not isinstance(idx, int) or idx < 0:
                    raise ValueError("tool index")
                if (self.retain_tools and not self.collect
                        and tool.get("type") is not None and tool.get("type") != "function"):
                    raise ValueError("tool type")
                if tool.get("id") is not None and not isinstance(tool["id"], str):
                    raise ValueError("tool id")
                if idx not in self.tools:
                    if self.retain_tools and not self.collect and len(self.tools) >= MAX_TOOL_CALLS:
                        raise ValueError("too many tool calls")
                    self.tools[idx] = new_tool_state()
                slot = self.tools[idx]
                function = tool.get("function", {})
                if not isinstance(function, dict):
                    raise ValueError("function")
                for key in ("name", "arguments"):
                    if function.get(key) is not None and not isinstance(function[key], str):
                        raise ValueError(key)
                if tool.get("id") or function.get("name") or function.get("arguments"):
                    self.saw_output = True
                if self.retain_tools and not self.collect:
                    merge_tool_call_delta(
                        slot, tool, declared_names=self.declared_names, charge=self._charge_text)
                else:
                    if tool.get("id"):
                        slot["id"] = tool["id"]
                    if function.get("name"):
                        slot["name"] = function["name"]
                    piece = function.get("arguments") or ""
                    if piece and self.collect:
                        self._charge(len(piece.encode("utf-8")))
                        slot["arguments"] += piece
                slot["identity_complete"] = tool_identity_complete(
                    slot, self.declared_names, terminal=bool(slot.get("_terminal")))
            self.filter_detector.feed(delta, choice.get("finish_reason"))
            if finish_reason is not None:
                seal_tool_identities(self.tools, self.declared_names)

    def _charge_text(self, value: str) -> None:
        self._charge(len(value.encode("utf-8")))

    def _charge(self, size: int):
        """Fail when retained output metadata exceeds the configured shared memory budget."""
        if not self.max_collect_bytes or (not self.collect and not self.retain_tools):
            return
        self.budget.charge(size)
        self.collected_bytes = self.budget.used_bytes

    def validated_tool_calls(self):
        return [{"id": value["id"], "type": "function",
                 "function": {"name": value["name"], "arguments": value["arguments"]}}
                for _, value in sorted(self.tools.items())]

    def result(self, *, allow_empty_filter=False):
        if not self.saw_choice or not (self.done or self.finish_reason is not None):
            raise httpx.RemoteProtocolError("Upstream SSE ended without a completion marker")
        seal_tool_identities(self.tools, self.declared_names)
        filter_terminal = self.finish_reason in ("content_filter", "content-filter", "refusal")
        if not self.saw_output and not (allow_empty_filter and filter_terminal):
            if filter_terminal:
                raw = {"error": {"type": "upstream_error", "code": self.finish_reason,
                                 "message": "Upstream rejected the response without output"}}
                raise UpstreamResponseError(502, json.dumps(raw).encode("utf-8"))
            raw = {"error": {"type": "upstream_error", "code": "empty_response",
                             "message": "Upstream SSE ended without output"}}
            raise UpstreamResponseError(502, json.dumps(raw).encode("utf-8"))
        tools = self.validated_tool_calls() or None
        return {"content": "".join(self.content), "reasoning_content": "".join(self.reasoning) or None,
                "refusal": "".join(self.refusal) or None,
                "tool_calls": tools, "finish_reason": self.finish_reason,
                "usage": self.usage, "model": self.model}


ERROR_BODY_LIMIT = 4 * 1024 * 1024  # Bound error-body memory usage.


async def read_bounded_error(response, limit: int = ERROR_BODY_LIMIT) -> bytes:
    """Read and truncate upstream error bytes within a fixed budget."""
    if limit <= 0:
        return b""
    buf = bytearray()
    async for chunk in response.aiter_bytes():
        buf.extend(chunk[:limit - len(buf)])
        if len(buf) >= limit:
            break
    return bytes(buf)


# Connection failures occur before any request body is sent.
BODY_NOT_ACCEPTED = (httpx.ConnectError, httpx.ConnectTimeout)
# Write-timeout replay is opt-in because partial requests may already have been processed.
WRITE_TIMEOUT = (httpx.WriteTimeout,)


_PENDING = object()
_EOF = object()


class BoundedStream:
    """Timed view over one upstream response: TTFB for the first line, idle for the rest.

    The upstream speaks SSE, so "first data line" is the TTFB boundary: before it
    only ``ttfb_timeout`` applies, after it each subsequent read is bounded by
    ``idle_timeout``. A stalled upstream fails fast instead of parking on the
    transport read timeout, and the raised :class:`UpstreamTimeout` lets callers
    fail over to another credential while the client has seen no bytes.
    Passing ``None`` disables either bound (restoring unbounded behaviour).
    """

    def __init__(self, response, *, ttfb_timeout=None, started=None, idle_timeout=None, clock=time.monotonic):
        self._response = response
        self._ttfb_timeout = ttfb_timeout
        self._idle_timeout = idle_timeout
        self._clock = clock
        deadline = None
        if ttfb_timeout is not None:
            deadline = (time.monotonic() if started is None else started) + ttfb_timeout
        self._ttfb_deadline = deadline
        self._lines = None
        self._bytes = None
        self._first = _PENDING
        self._content = None

    def __getattr__(self, name):
        # status_code / headers / url and friends pass through to the real response.
        response = self.__dict__.get("_response")
        if response is None:  # Avoid recursion during interrupted construction.
            raise AttributeError(name)
        return getattr(response, name)

    @property
    def response(self):
        return self._response

    @property
    def ttfb_timeout(self):
        return self._ttfb_timeout

    def _line_iterator(self):
        if self._lines is None:
            self._lines = self._response.aiter_lines()
        return self._lines

    async def _next_line(self, timeout, label):
        """Read the next SSE line; _EOF marks stream end, timeouts raise UpstreamTimeout."""
        iterator = self._line_iterator()
        try:
            if timeout is None:
                return await iterator.__anext__()
            return await asyncio.wait_for(iterator.__anext__(), max(0.0, timeout))
        except StopAsyncIteration:
            return _EOF
        except (asyncio.TimeoutError, TimeoutError):
            raise UpstreamTimeout(label()) from None

    async def read_first_line(self):
        """Read the first SSE line under the TTFB bound; None for an empty stream."""
        if self._first is _PENDING:
            budget = None
            if self._ttfb_deadline is not None:
                budget = self._ttfb_deadline - self._clock()
                if budget <= 0:
                    raise UpstreamTimeout(f"上游 {self._ttfb_timeout:g}s 内未返回任何数据")
            line = await self._next_line(budget, lambda: f"上游 {self._ttfb_timeout:g}s 内未返回任何数据")
            self._first = None if line is _EOF else line
        return self._first

    async def aiter_lines(self):
        """Yield lines: the TTFB-read first line first, then idle-bounded reads."""
        first = await self.read_first_line()
        if first is not None:
            yield first
        while True:
            line = await self._next_line(self._idle_timeout, lambda: f"上游流空闲超过 {self._idle_timeout:g}s")
            if line is _EOF:
                return
            yield line

    async def _next_bytes(self, timeout, label):
        iterator = self._bytes
        if iterator is None:
            iterator = self._bytes = self._response.aiter_bytes()
        try:
            if timeout is None:
                return await iterator.__anext__()
            return await asyncio.wait_for(iterator.__anext__(), max(0.0, timeout))
        except StopAsyncIteration:
            return _EOF
        except (asyncio.TimeoutError, TimeoutError):
            raise UpstreamTimeout(label()) from None

    async def aiter_bytes(self):
        """Idle-bounded byte iteration for bounded error-body reads."""
        while True:
            chunk = await self._next_bytes(self._idle_timeout, lambda: f"上游响应体读取超过 {self._idle_timeout:g}s")
            if chunk is _EOF:
                return
            yield chunk

    async def aread(self):
        """Read the whole body (non-200 error bodies) under the idle bound."""
        if self._content is None:
            try:
                if self._idle_timeout is None:
                    self._content = await self._response.aread()
                else:
                    self._content = await asyncio.wait_for(self._response.aread(), self._idle_timeout)
            except (asyncio.TimeoutError, TimeoutError):
                raise UpstreamTimeout(f"上游响应体读取超过 {self._idle_timeout:g}s") from None
        return self._content


@asynccontextmanager
async def _attempt_client(url, timeout, clients):
    client = clients.get(url) if clients is not None else None
    if client is not None:
        yield client
    else:
        async with httpx.AsyncClient(timeout=timeout) as client:
            yield client


@asynccontextmanager
async def open_backend_stream(url, headers, body, *, read_timeout=300, on_retry=None,
                              retry_write_timeout=False, clients=None, headers_for_attempt=None,
                              ttfb_timeout=None, idle_timeout=None):
    """Retry connection failures once on a fresh client; write timeouts require explicit opt-in.
    Never replay after the upstream response opens. When either timeout bound is set the
    yielded response is a :class:`BoundedStream` that fails fast on TTFB or idle stalls.
    """
    retryable = BODY_NOT_ACCEPTED + (WRITE_TIMEOUT if retry_write_timeout else ())
    timeout = httpx.Timeout(read_timeout, connect=15, write=60, pool=15)
    bounded = ttfb_timeout is not None or idle_timeout is not None
    for attempt in range(2):
        opened = False
        try:
            async with _attempt_client(url, timeout, clients if attempt == 0 else None) as client:
                attempt_headers = headers_for_attempt() if headers_for_attempt is not None else headers
                started = time.monotonic()
                async with client.stream("POST", url, headers=attempt_headers, json=body, timeout=timeout) as response:
                    opened = True
                    if bounded:
                        response = BoundedStream(response, ttfb_timeout=ttfb_timeout, started=started,
                                                 idle_timeout=idle_timeout)
                    yield response
                    return
        except retryable as error:
            if opened or attempt == 1:
                raise
            if on_retry is not None:
                on_retry(error)
            await asyncio.sleep(0.25)
