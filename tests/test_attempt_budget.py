#!/usr/bin/env python3
"""Bound the total upstream attempts of one request: connection retries share the failover budget.

The production defect this pins down: `open_backend_stream` always retried a connection
failure once, and the caller's failover loop then replayed the whole call `failover_max`
more times, so one client request could reach the upstream (1+1)*(1+failover_max) times
(6 attempts / 128.8s with the shipped failover_max=2). The budget parameter below makes the
total dial count an explicit, per-request bound.
"""
import sys
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # Allow direct execution.

import unittest
from unittest.mock import patch

import httpx

from app import upstream_io

SSE_OK = b'data: {"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}]}\n\ndata: [DONE]\n\n'


@contextmanager
def mock_upstream(handler):
    """Route every client the module creates through one in-memory transport."""
    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    with patch.object(upstream_io.httpx, "AsyncClient",
                      side_effect=lambda **kw: real_client(transport=transport, **kw)):
        yield


async def read_stream(**kwargs):
    """Open one upstream stream and drain it, returning the response body."""
    async with upstream_io.open_backend_stream("https://synthetic.invalid", {}, {}, **kwargs) as response:
        return response.status_code, await response.aread()


class AttemptBudgetTests(unittest.IsolatedAsyncioTestCase):
    """Each case counts real dials that reached the transport layer."""

    async def test_single_attempt_budget_does_not_retry_connection_failures(self):
        """A budget of one dial means the connection failure is final, not retried once."""
        dials, retries = [], []

        def handler(request):
            dials.append(request)
            raise httpx.ConnectError("synthetic failure before the body was accepted")

        with mock_upstream(handler):
            with self.assertRaises(httpx.ConnectError):
                await read_stream(max_attempts=1, on_retry=retries.append)
        self.assertEqual(len(dials), 1, "预算 1 时必须只拨号一次")
        self.assertEqual(retries, [], "没有第二次尝试就不许报告重试")

    async def test_three_attempt_budget_stops_after_three_dials(self):
        """A budget of three dials allows exactly two connection retries."""
        dials, retries = [], []

        def handler(request):
            dials.append(request)
            raise httpx.ConnectTimeout("synthetic connect timeout")

        with mock_upstream(handler):
            with self.assertRaises(httpx.ConnectTimeout):
                await read_stream(max_attempts=3, on_retry=retries.append)
        self.assertEqual(len(dials), 3, "预算 3 时最多拨号三次")
        self.assertEqual(len(retries), 2, "前两次失败各触发一次重试")

    async def test_three_attempt_budget_succeeds_on_the_last_dial(self):
        """The budget is an upper bound, not a fixed count."""
        dials = []

        def handler(request):
            dials.append(request)
            if len(dials) < 3:
                raise httpx.ConnectError("synthetic failure before the body was accepted")
            return httpx.Response(200, content=SSE_OK)

        with mock_upstream(handler):
            status, body = await read_stream(max_attempts=3)
        self.assertEqual(status, 200)
        self.assertEqual(body, SSE_OK)
        self.assertEqual(len(dials), 3)

    async def test_omitted_budget_preserves_the_legacy_single_retry(self):
        """Backward compatibility: no budget keeps today's two-dial behaviour."""
        dials = []

        def handler(request):
            dials.append(request)
            if len(dials) == 1:
                raise httpx.ConnectError("synthetic failure before the body was accepted")
            return httpx.Response(200, content=SSE_OK)

        with mock_upstream(handler):
            status, body = await read_stream()
        self.assertEqual(status, 200)
        self.assertEqual(body, SSE_OK)
        self.assertEqual(len(dials), 2, "不传预算时必须与既有行为一致：重放一次")

    async def test_write_timeout_replay_still_requires_the_opt_in(self):
        """The retry_write_timeout switch keeps its meaning even with budget to spare."""
        dials = []

        def handler(request):
            dials.append(request)
            raise httpx.WriteTimeout("synthetic write timeout")

        with mock_upstream(handler):
            with self.assertRaises(httpx.WriteTimeout):
                await read_stream(max_attempts=3)
        self.assertEqual(len(dials), 1, "未显式开启时写超时一次都不重放")

    async def test_write_timeout_replay_consumes_the_shared_budget(self):
        """An opted-in write-timeout replay spends budget instead of adding a free dial."""
        dials, retries = [], []

        def handler(request):
            dials.append(request)
            raise httpx.WriteTimeout("synthetic write timeout")

        with mock_upstream(handler):
            with self.assertRaises(httpx.WriteTimeout):
                await read_stream(max_attempts=2, retry_write_timeout=True, on_retry=retries.append)
        self.assertEqual(len(dials), 2, "预算 2：首次写超时重放一次后即停")
        self.assertEqual(len(retries), 1)

    async def test_write_timeout_replay_cannot_exceed_a_single_attempt_budget(self):
        """The opt-in switch must not widen the total budget on its own."""
        dials = []

        def handler(request):
            dials.append(request)
            raise httpx.WriteTimeout("synthetic write timeout")

        with mock_upstream(handler):
            with self.assertRaises(httpx.WriteTimeout):
                await read_stream(max_attempts=1, retry_write_timeout=True)
        self.assertEqual(len(dials), 1, "开关不能突破总预算")

    async def test_on_attempt_reports_every_dial(self):
        """Callers charge a shared counter from the per-dial hook."""
        dials, charged = [], []

        def handler(request):
            dials.append(request)
            raise httpx.ConnectError("synthetic failure before the body was accepted")

        with mock_upstream(handler):
            with self.assertRaises(httpx.ConnectError):
                await read_stream(max_attempts=3, on_attempt=charged.append)
        self.assertEqual(charged, [1, 2, 3])
        self.assertEqual(len(dials), len(charged), "钩子与真实拨号必须一一对应")

    async def test_exhausted_budget_refuses_to_dial(self):
        """A caller that already spent the request budget must not reach the upstream again."""
        dials = []

        def handler(request):
            dials.append(request)
            return httpx.Response(200, content=SSE_OK)

        for budget in (0, -1):
            with self.subTest(max_attempts=budget):
                with mock_upstream(handler):
                    with self.assertRaises(ValueError):
                        await read_stream(max_attempts=budget)
        self.assertEqual(dials, [], "预算耗尽时不得再拨号")

    async def test_shared_budget_across_calls_never_exceeds_the_request_limit(self):
        """The documented integration: failover calls pass the remaining budget down."""
        dials, used = [], {"count": 0}
        total = 3                     # 1 + failover_max, one request-wide budget.

        def handler(request):
            dials.append(request)
            raise httpx.ConnectError("synthetic failure before the body was accepted")

        def charge(_index):
            used["count"] += 1

        with mock_upstream(handler):
            with self.assertRaises(httpx.ConnectError):
                while used["count"] < total:
                    await read_stream(max_attempts=total - used["count"],
                                      on_attempt=charge)
        self.assertEqual(len(dials), total, f"整请求拨号次数必须封顶在 {total}：{len(dials)}")
        self.assertEqual(used["count"], total)


if __name__ == "__main__":
    unittest.main(verbosity=2)
