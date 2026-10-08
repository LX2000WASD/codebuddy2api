"""Regression tests for the locally ported gateway features.

Covers: CN/EN 429 reset-time parsing, thinking passthrough+pin injection, Responses
interleaved output_index allocation, BoundedStream TTFB/idle timeouts feeding the
pre-response credential failover, opt-in cooldown persistence, and stream_tools.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import asyncio
import json
import time
import unittest
from unittest.mock import patch

import httpx

import converter as gateway
from app import upstream_io
from app.adapters.responses_adapter import ResponsesStreamConverter
import test_region_routing as fixtures
from test_api_flow import GatewayFixture
from test_model_capabilities import model as shared_model
from test_region_routing import success_sse

REAL_ASYNC_CLIENT = httpx.AsyncClient


def parse_events(raw: str) -> list[dict]:
    events = []
    for block in raw.strip().split("\n\n"):
        for line in block.strip().split("\n"):
            if line.startswith("data: ") and line[6:] != "[DONE]":
                events.append(json.loads(line[6:]))
    return events


class ResetTimeParsingTests(unittest.TestCase):
    """429 reset timestamps must parse in both observed upstream wordings."""

    def test_english_utc_form_still_parses(self):
        ahead = time.time() + 3600
        stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(ahead))
        raw = f"your usage will reset at {stamp} UTC+0, alternatively upgrade".encode()
        parsed = gateway._parse_reset_time(raw)
        self.assertIsNotNone(parsed)
        self.assertAlmostEqual(parsed, ahead, delta=5)

    def test_chinese_form_full_width_no_space_no_timezone(self):
        # 契约:无时区中文文案固定按东八区解释——输入与期望都用 UTC+8 墙钟构造,
        # 与运行机器的本地时区无关(否则该用例只在 UTC+8 机器上成立)。
        from datetime import datetime, timedelta, timezone

        cn_tz = timezone(timedelta(hours=8))
        target = datetime.now(cn_tz) + timedelta(hours=1)
        ahead = target.strftime("%Y-%m-%d %H:%M:%S")
        ahead_cn = ahead.replace(":", "：")
        raw = f"当前模型额度不足，可在{ahead_cn.replace(' ', '')}重置可用。您可以切换其他模型".encode("utf-8")
        parsed = gateway._parse_reset_time(raw)
        self.assertIsNotNone(parsed)
        self.assertAlmostEqual(parsed, target.replace(microsecond=0).timestamp(), delta=5)

    def test_implausible_timestamps_are_rejected(self):
        past = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(time.time() - 86400))
        far = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(time.time() + 90 * 86400))
        for text in (f"reset at {past} UTC+0", f"reset at {far} UTC+0", "no timestamp here"):
            with self.subTest(text=text):
                self.assertIsNone(gateway._parse_reset_time(text.encode()))


class ThinkingPinTests(GatewayFixture, unittest.TestCase):
    """reasoning_effort must become an explicit thinking switch for matching models."""

    def _body(self, model, **extra):
        body = {"model": model, "messages": [{"role": "user", "content": "hi"}]}
        body.update(extra)
        return gateway._prepare_chat_body(dict(body))

    def test_injection_rules(self):
        with patch.dict(gateway.CONFIG, {"thinking_pin_models": "deepseek", "model_guard": False}):
            self.assertEqual(self._body("deepseek-v4.1-flash", reasoning_effort="max").get("thinking"),
                             {"type": "enabled"})
            # Explicit client thinking always wins, including disabled.
            self.assertEqual(self._body("deepseek-v4.1-flash", reasoning_effort="max",
                                        thinking={"type": "disabled"}).get("thinking"),
                             {"type": "disabled"})
            # Unmatched models and off/missing effort are left untouched.
            self.assertIsNone(self._body("glm-5.3", reasoning_effort="max").get("thinking"))
            self.assertIsNone(self._body("deepseek-v4.1-flash", reasoning_effort="off").get("thinking"))
            self.assertIsNone(self._body("deepseek-v4.1-flash").get("thinking"))

    def test_injection_reaches_upstream_on_chat_and_responses(self):
        self.fx.configure(guard=False)
        with patch.dict(gateway.CONFIG, {"thinking_pin_models": "shared", "model_guard": False}):
            cases = [
                ("/v1/chat/completions", {"model": "shared-model", "reasoning_effort": "max",
                                          "messages": [{"role": "user", "content": "hi"}]}),
                ("/v1/responses", {"model": "shared-model", "reasoning": {"effort": "max"},
                                   "input": "hi"}),
            ]
            for route, payload in cases:
                with self.subTest(route=route):
                    self.fx.requests.clear()
                    payload["stream"] = False
                    response = self.fx.client.post(route, json=payload)
                    self.assertEqual(response.status_code, 200, response.text)
                    upstream = json.loads(self.fx.requests[-1].content)
                    self.assertEqual(upstream.get("thinking"), {"type": "enabled"})
                    self.assertEqual(upstream.get("reasoning_effort"), "max")


class ResponsesInterleavedIndexTests(unittest.TestCase):
    """Content arriving before reasoning must not collide on output_index."""

    SSE = (
        'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"first"},"finish_reason":null}]}\n'
        'data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"late thinking"},"finish_reason":null}]}\n'
        'data: {"id":"c1","choices":[{"index":0,"delta":{"content":" second"},"finish_reason":null}]}\n'
        'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1",'
        '"function":{"name":"f","arguments":"{}"}}]},"finish_reason":null}]}\n'
        'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n'
        'data: [DONE]\n'
    )

    def test_indexes_are_unique_and_consistent(self):
        conv = ResponsesStreamConverter(model="m")
        raw = "".join(conv.feed_line(line) for line in self.SSE.splitlines())
        raw += conv.finish()
        events = parse_events(raw)

        added = [e for e in events if e["type"] == "response.output_item.added"]
        indexes = [e["output_index"] for e in added]
        self.assertEqual(len(indexes), len(set(indexes)), f"output_index collision: {indexes}")
        by_type = {e["item"]["type"]: e["output_index"] for e in added}
        self.assertEqual(by_type.get("message"), 0)
        self.assertEqual(by_type.get("reasoning"), 1)
        self.assertEqual(by_type.get("function_call"), 2)

        for event in events:
            if event["type"] == "response.output_text.delta":
                self.assertEqual(event["output_index"], by_type["message"])
            if event["type"] == "response.reasoning_summary_text.delta":
                self.assertEqual(event["output_index"], by_type["reasoning"])

        completed = [e for e in events if e["type"] == "response.completed"][0]["response"]
        self.assertEqual([item["type"] for item in completed["output"]],
                         ["message", "reasoning", "function_call"])


class _HangingStream:
    """Async byte stream that stalls before its first chunk, then completes."""

    def __init__(self, delay, payload):
        self._delay = delay
        self._payload = payload
        self._started = False

    async def read_first(self):
        await asyncio.sleep(self._delay)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._started:
            raise StopAsyncIteration
        self._started = True
        await asyncio.sleep(self._delay)
        return self._payload


class BoundedStreamTimeoutTests(unittest.TestCase):
    """BoundedStream must raise UpstreamTimeout on TTFB and idle stalls."""

    class _FakeResponse:
        def __init__(self, lines):
            self._lines = lines

        async def aiter_lines(self):
            for item in self._lines:
                if isinstance(item, float):
                    await asyncio.sleep(item)
                else:
                    yield item

    def test_ttfb_timeout(self):
        stream = upstream_io.BoundedStream(self._FakeResponse([5.0, "data: {}\n\n"]),
                                           ttfb_timeout=0.05)
        with self.assertRaises(upstream_io.UpstreamTimeout):
            asyncio.run(stream.read_first_line())

    def test_idle_timeout(self):
        stream = upstream_io.BoundedStream(self._FakeResponse(["data: 1\n\n", 5.0, "data: 2\n\n"]),
                                           ttfb_timeout=1.0, idle_timeout=0.05)
        async def consume():
            async for _ in stream.aiter_lines():
                pass
        with self.assertRaises(upstream_io.UpstreamTimeout):
            asyncio.run(consume())

    def test_upstream_timeout_is_replayable_transport(self):
        self.assertTrue(issubclass(upstream_io.UpstreamTimeout, httpx.ReadTimeout))
        self.assertIsInstance(upstream_io.UpstreamTimeout("stall"),
                              tuple(gateway.REPLAYABLE_TRANSPORT))


class TtfbFailoverTests(GatewayFixture, unittest.TestCase):
    """A stalled first upstream must fail over to another credential before any client byte."""

    def test_hanging_upstream_fails_over_within_ttfb(self):
        self.fx.configure(profiles=("intl-work", "cn-cli"))
        self.fx.account_catalogs({"intl-work": [shared_model()], "cn-cli": [shared_model()]})
        attempts = []

        def reply(request):
            attempts.append(request.headers.get("x-user-id"))
            if len(attempts) == 1:
                async def stall():
                    await asyncio.sleep(5)
                    yield b"data: {}\n\n"
                return httpx.Response(200, content=stall(),
                                      headers={"Content-Type": "text/event-stream"})
            return httpx.Response(200, content=success_sse(),
                                  headers={"Content-Type": "text/event-stream"})

        payload = self.fx.payload()
        with patch.dict(gateway.CONFIG, {"failover_max": 1, "ttfb_timeout": 0.2,
                                         "stream_idle_timeout": 5.0}), self.responder(reply):
            response = self.fx.client.post("/v1/chat/completions", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(attempts), 2)


class StreamToolsTests(GatewayFixture, unittest.TestCase):
    """stream_tools streams tool-bearing requests without the aggregate retry."""

    def test_malformed_tool_calls_pass_through(self):
        broken = {"tool_calls": [{"index": 0, "id": "broken-call", "function": {
            "name": "synthetic_tool", "arguments": "{"}}]}

        def sse(delta=None, finish="stop"):
            return ("data: " + json.dumps({"model": "shared-model", "choices": [
                {"index": 0, "delta": delta or {}, "finish_reason": None}]}) + "\n\n"
                    "data: " + json.dumps({"model": "shared-model", "choices": [
                        {"index": 0, "delta": {}, "finish_reason": finish}]}) + "\n\n"
                    "data: [DONE]\n\n").encode()

        self.fx.configure(guard=False)
        payload = self.fx.payload(stream=True)
        payload["tools"] = [{"type": "function", "function": {
            "name": "synthetic_tool", "parameters": {"type": "object"}}}]
        attempts = []
        def reply(request):
            attempts.append(request)
            return httpx.Response(200, content=sse(broken),
                                  headers={"Content-Type": "text/event-stream"})
        with patch.dict(gateway.CONFIG, {"stream_tools": True}), self.responder(reply):
            response = self.fx.client.post("/v1/chat/completions", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(attempts), 1)           # 无聚合重试
        self.assertIn("broken-call", response.text)  # 损坏调用逐字节到达客户端


class ProjectionOffTests(GatewayFixture, unittest.TestCase):
    """responses_projection_mode=passthrough must pass the full conversation through untouched."""

    def test_disabling_projection_preserves_history(self):
        self.fx.configure(guard=False)
        big_output = "x" * 5000
        payload = {
            "model": "shared-model", "stream": False,
            "instructions": "You are an AI agent powered by DeepSeek Harness.",
            "input": [
                {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "<system-reminder>ctx</system-reminder>\nfirst"}]},
                {"type": "message", "role": "assistant", "content": [
                    {"type": "output_text", "text": big_output}]},
                {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "second"}]},
            ],
        }
        with patch.dict(gateway.CONFIG, {"responses_projection_mode": "passthrough"}):
            response = self.fx.client.post("/v1/responses", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        upstream = json.loads(self.fx.requests[-1].content)
        contents = [str(m.get("content")) for m in upstream["messages"]]
        self.assertTrue(any(len(c) >= 5000 for c in contents), "完整 assistant 输出被截断")


class DeltaNormalizationTests(GatewayFixture, unittest.TestCase):
    """归一化与 reasoning 合并共用同一次解析：空装饰字段剥掉，思考合并成单块发出。"""

    def test_empty_decorations_are_stripped_and_reasoning_coalesced(self):
        def chunk(delta, finish=None):
            return "data: " + json.dumps({"model": "shared-model", "choices": [
                {"index": 0, "delta": delta, "finish_reason": finish}]})

        noisy = "\n\n".join([
            chunk({"role": "assistant", "content": "", "reasoning_content": "",
                   "tool_calls": [], "function_call": None, "refusal": ""}),
            chunk({"content": "", "reasoning_content": "The", "function_call": None,
                   "refusal": "", "tool_calls": []}),
            chunk({"content": "", "reasoning_content": " user", "tool_calls": []}),
            chunk({"content": "hello"}),
            chunk({}, "stop"),
            "data: [DONE]",
        ]) + "\n\n"

        self.fx.configure(guard=False)
        attempts = []
        def reply(request):
            attempts.append(request)
            return httpx.Response(200, content=noisy.encode(),
                                  headers={"Content-Type": "text/event-stream"})
        payload = self.fx.payload(stream=True)
        payload["tools"] = [{"type": "function", "function": {
            "name": "synthetic_tool", "parameters": {"type": "object"}}}]
        with patch.dict(gateway.CONFIG, {"stream_tools": True}), self.responder(reply):
            response = self.fx.client.post("/v1/chat/completions", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn('"content": ""', response.text)
        self.assertNotIn('"tool_calls": []', response.text)
        self.assertNotIn('"function_call": null', response.text)
        deltas = [json.loads(l[5:].strip())["choices"][0]["delta"]
                  for l in response.text.splitlines()
                  if l.startswith("data:") and '"delta"' in l and l[5:].strip() != "[DONE]"]
        # 首帧只剩 role；连续 reasoning 被合并成单块后发出，随后是可见 content。
        self.assertEqual(deltas[0], {"role": "assistant"})
        self.assertEqual(deltas[1], {"reasoning_content": "The user"})
        self.assertEqual(deltas[2], {"content": "hello"})

    def test_coalescer_normalizes_with_single_parse(self):
        """归一化落在合并器内部：每条 SSE 只解析一次，输出既无空装饰字段也不逐词切碎。"""
        async def source():
            for raw in (
                'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":""},"finish_reason":null}]}',
                'data: {"choices":[{"index":0,"delta":{"content":"","reasoning_content":"The "},"finish_reason":null}]}',
                'data: {"choices":[{"index":0,"delta":{"content":"ans","refusal":""},"finish_reason":null}]}',
                "data: [DONE]",
            ):
                yield raw

        async def collect():
            return [line async for line in gateway._coalesce_reasoning_sse(source(), max_bytes=0)]

        out = asyncio.run(collect())
        deltas = [json.loads(line[5:].strip())["choices"][0]["delta"]
                  for line in out
                  if line.startswith("data:") and line[5:].strip() != "[DONE]"]
        self.assertEqual(deltas, [{"role": "assistant"},
                                  {"reasoning_content": "The "},
                                  {"content": "ans"}])

    def test_live_mode_streams_reasoning_per_frame(self):
        """coalesce_reasoning=False：思考增量逐帧下发，归一化与单次解析保持不变。"""
        async def source():
            for raw in (
                'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":""},"finish_reason":null}]}',
                'data: {"choices":[{"index":0,"delta":{"content":"","reasoning_content":"The"},"finish_reason":null}]}',
                'data: {"choices":[{"index":0,"delta":{"content":"","reasoning_content":" user"},"finish_reason":null}]}',
                'data: {"choices":[{"index":0,"delta":{"content":"ans","refusal":""},"finish_reason":null}]}',
                "data: [DONE]",
            ):
                yield raw

        async def collect():
            return [line async for line in gateway._coalesce_reasoning_sse(
                source(), max_bytes=0, live=True)]

        out = asyncio.run(collect())
        deltas = [json.loads(line[5:].strip())["choices"][0]["delta"]
                  for line in out
                  if line.startswith("data:") and line[5:].strip() != "[DONE]"]
        # 合并关闭：思考逐帧到达且无空装饰字段；正文帧照常
        self.assertEqual(deltas, [{"role": "assistant"},
                                  {"reasoning_content": "The"},
                                  {"reasoning_content": " user"},
                                  {"content": "ans"}])

    def test_unit_normalization_variants(self):
        chunk = {"choices": [{"index": 0, "delta": {"content": "", "reasoning_content": "x",
                                                    "tool_calls": [], "function_call": None, "refusal": ""},
                              "finish_reason": None}]}
        self.assertTrue(gateway._normalize_chat_event(chunk))
        self.assertEqual(chunk["choices"][0]["delta"], {"reasoning_content": "x"})
        clean = {"choices": [{"index": 0, "delta": {"content": "ok"}, "finish_reason": None}]}
        self.assertFalse(gateway._normalize_chat_event(clean))
        self.assertEqual(clean["choices"][0]["delta"], {"content": "ok"})
        zwsp = {"choices": [{"index": 0, "delta": {"content": "a\u200bb"},
                              "finish_reason": None}]}
        self.assertTrue(gateway._normalize_chat_event(zwsp))
        self.assertEqual(zwsp["choices"][0]["delta"], {"content": "ab"})
        tool = {"choices": [{"index": 0, "delta": {"tool_calls": [
            {"index": 0, "id": "c1", "function": {"name": "f", "arguments": "a\u200bb"}}]}}]}
        self.assertTrue(gateway._normalize_chat_event(tool))
        self.assertEqual(tool["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"], "ab")
        # 非字典/空 choices 负载不得抛异常
        self.assertFalse(gateway._normalize_chat_event({"choices": [{"index": 0, "delta": None}]}))
        self.assertFalse(gateway._normalize_chat_event({"choices": []}))


class AuditDegradationHealTests(unittest.TestCase):
    """一次成功的记录写入应清除 sticky 降级标记(统计实际完整时不永久置灰)。"""

    def test_successful_ingest_heals_transient_fault(self):
        import tempfile
        from contextlib import closing
        import sqlite3
        from app.audit_store import AuditStore
        with tempfile.TemporaryDirectory() as root:
            path = str(Path(root) / "logs.sqlite3")
            store = AuditStore(path, max_bytes=1024 ** 2, retention_days=1, preview_limit=128)
            try:
                record = {"id": "r1", "started_at": 1, "model": "m", "route": "chat",
                          "status_code": 200, "stream": True,
                          "input_tokens": 1, "output_tokens": 1, "total_tokens": 2}
                store.record_request(record)   # 成功写入
                with closing(sqlite3.connect(path)) as other:
                    other.execute("BEGIN IMMEDIATE")
                    store.record_request(dict(record, id="r2"))  # 制造一次锁超时故障
                self.assertTrue(store.storage()["degraded"])     # 故障可见
                ok = store.record_request(dict(record, id="r3"))  # 再次成功写入
                self.assertTrue(ok["ok"])
                self.assertFalse(store.storage()["degraded"])    # 自愈
                self.assertEqual(store.storage()["dropped_records"], 1)  # 累计丢失仍如实保留
            finally:
                store.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
