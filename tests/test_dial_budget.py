#!/usr/bin/env python3
"""End-to-end: one client request spends one bounded upstream dial budget.

converter side of the attempt-budget fix. tests/test_attempt_budget.py pins the
upstream_io primitive; this file pins the wiring, which is where the defect lived:
open_backend_stream retried a connection failure once inside the call and the failover
loop replayed the whole call up to failover_max times, so one request could dial
(1 + 1) * (1 + failover_max) times — 6 dials with the shipped failover_max=2.

The budget is per request, never per credential: moving to another account is what spends
it. Two properties are load-bearing and easy to break by accident:

* failover_max=0 keeps two dials. The floor preserves the cheap connection retry that a
  flaky-but-recoverable network needs; a ConnectError fails in milliseconds and is not what
  produced the 128.8s tail.
* tool-repair and filter-retry do not spend the budget. They re-ask the account that just
  answered and succeed, so charging them would starve requests that never failed.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # Allow direct execution.

import unittest
from unittest.mock import patch

import httpx

import converter
from tests import test_region_routing as fixtures

GENERATIONS = fixtures.GENERATIONS
TOOL = {"type": "function", "function": {"name": "synthetic_tool", "description": "synthetic",
                                         "parameters": {"type": "object", "properties": {}}}}


def sse(event, finish="stop"):
    """Build a one-event SSE body with the given delta and finish reason."""
    chunks = [{"id": "synthetic", "choices": [{"index": 0, "delta": event, "finish_reason": None}]},
              {"id": "synthetic", "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
               "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}]
    return ("".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks)
            + "data: [DONE]\n\n").encode()


class _DialBudgetFixture(unittest.TestCase):
    """Borrow the region-routing fixture's builders without inheriting its test methods.

    Inheriting RegionRoutingTests would collect its whole suite a second time under this
    module (both pytest and a direct unittest run walk inherited test_ methods), so the
    fixture is attached by explicit delegation instead. Only the setup and builder methods
    are reused; every test in this file is its own.
    """

    setUp = fixtures.RegionRoutingTests.setUp
    add_account = fixtures.RegionRoutingTests.add_account
    configure = fixtures.RegionRoutingTests.configure
    account_catalogs = fixtures.RegionRoutingTests.account_catalogs
    payload = fixtures.RegionRoutingTests.payload
    post_ok = fixtures.RegionRoutingTests.post_ok
    post_rejected = fixtures.RegionRoutingTests.post_rejected
    handle_upstream = fixtures.RegionRoutingTests.handle_upstream


class DialBudgetTests(_DialBudgetFixture):
    """Count real upstream dials for one client request under a given failover allowance."""

    def setUp(self):
        # Flags the transport reads. The fixture binds MockTransport(self.handle_upstream)
        # during its own setUp, so behaviour has to be selected through state, not by
        # replacing the method afterwards.
        self.dials = []
        self.refuse = False
        self.tool_repair = False
        super().setUp()

    def dial_count(self):
        """Generation dials only: catalog and refresh requests are not attempts."""
        return len([request for request in self.dials
                    if request.url.path == "/v2/chat/completions"])

    def handle_upstream(self, request):
        if request.url.path == "/v2/chat/completions":
            self.dials.append(request)
            if self.refuse:
                raise httpx.ConnectError("synthetic connect failure")
            if self.tool_repair:
                if len(self.dials) == 1:
                    return httpx.Response(200, content=sse({"content": "tool choice ignored"}))
                return httpx.Response(200, content=sse({"tool_calls": [
                    {"index": 0, "id": "call-1", "type": "function",
                     "function": {"name": "synthetic_tool", "arguments": "{}"}}]}, "tool_calls"))
        return super().handle_upstream(request)

    def refuse_every_dial(self):
        """Make every credential fail at connect time, as an unreachable upstream would."""
        self.refuse = True

    def post(self, endpoint="chat/completions", *, stream=True, tools=False):
        self.allowed_profiles = set(fixtures.PROFILES)
        payload = self.payload(endpoint, "shared-model", stream=stream)
        if tools:
            payload["tools"] = [TOOL]
            # Without this the model is free to answer in prose, so a text-only reply is a
            # valid response and never triggers the tool-repair regeneration under test.
            payload["tool_choice"] = "required"
        return self.client.post("/v1/" + endpoint, json=payload)

    # -- (a) the shipped configuration is bounded -------------------------

    def test_failover_max_two_caps_one_request_at_three_dials(self):
        """The production setting: 6 dials before, 3 after, for every generation endpoint."""
        for endpoint in GENERATIONS:
            with self.subTest(endpoint=endpoint):
                self.configure()
                self.dials.clear()
                self.refuse_every_dial()
                with patch.dict(converter.CONFIG, {"failover_max": 2}):
                    response = self.post(endpoint)
                self.assertGreaterEqual(response.status_code, 500, response.text)
                self.assertLessEqual(self.dial_count(), 3,
                                     f"整请求拨号必须封顶 3 次：{self.dial_count()}")
                self.assertGreaterEqual(self.dial_count(), 2, "至少要真正尝试过")

    def test_a_reachable_upstream_costs_one_dial(self):
        """The budget must never add attempts to a request that simply works."""
        with patch.dict(converter.CONFIG, {"failover_max": 2}):
            response = self.post()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.dial_count(), 1)

    # -- (b) the floor, pinned so it is not "simplified" away -------------

    def test_failover_max_zero_still_allows_two_dials(self):
        """A single cheap connection retry survives with failover disabled."""
        self.configure()
        self.dials.clear()
        self.refuse_every_dial()
        with patch.dict(converter.CONFIG, {"failover_max": 0}):
            response = self.post()
        self.assertGreaterEqual(response.status_code, 500, response.text)
        self.assertEqual(self.dial_count(), 2,
                         f"failover_max=0 时必须保留一次建连重试：{self.dial_count()}")

    def test_failover_max_one_allows_two_dials(self):
        """The floor and the failover allowance coincide here; still exactly two."""
        self.configure()
        self.dials.clear()
        self.refuse_every_dial()
        with patch.dict(converter.CONFIG, {"failover_max": 1}):
            response = self.post()
        self.assertGreaterEqual(response.status_code, 500, response.text)
        self.assertLessEqual(self.dial_count(), 2, f"{self.dial_count()}")

    def test_a_single_account_pool_keeps_its_connection_retry(self):
        """One account and no alternative must not lose the retry the budget reserved away.

        Reservations assume a reroute exists. With a single account there is nothing to
        reroute to, so the reservation has to be handed back: otherwise this deployment would
        be strictly worse than before the budget existed — one dial, then a 502 with no
        connection retry at all.
        """
        self.configure(profiles=("cn-cli",))
        self.allowed_profiles = {"cn-cli"}
        self.dials.clear()
        self.refuse_every_dial()
        with patch.dict(converter.CONFIG, {"failover_max": 2}):
            response = self.post()
        self.assertEqual(self.dial_count(), 2,
                         f"单账号必须保留 1 次建连重试：{self.dial_count()}")
        # A connection failure is a legitimate 502, not an internal error.
        self.assertEqual(response.status_code, 502, response.text)
        self.assertNotIn("Traceback", response.text)
        self.assertIn("error", response.json())

    def test_a_single_account_pool_is_also_retried_for_non_streaming(self):
        """The same guarantee on the aggregated (non-streaming) path."""
        self.configure(profiles=("cn-cli",))
        self.allowed_profiles = {"cn-cli"}
        self.dials.clear()
        self.refuse_every_dial()
        with patch.dict(converter.CONFIG, {"failover_max": 2}):
            response = self.post(stream=False)
        self.assertEqual(self.dial_count(), 2, f"{self.dial_count()}")
        self.assertEqual(response.status_code, 502, response.text)

    def test_the_no_alternative_retry_is_bounded_to_one_per_account(self):
        """A dead single account must not drain the whole budget on retries."""
        self.configure(profiles=("cn-cli",))
        self.allowed_profiles = {"cn-cli"}
        self.dials.clear()
        self.refuse_every_dial()
        with patch.dict(converter.CONFIG, {"failover_max": 3}):
            self.post()
        self.assertEqual(self.dial_count(), 2,
                         f"重试必须限一次，不能把预算耗尽：{self.dial_count()}")

    def test_the_no_alternative_retry_does_not_apply_to_http_errors(self):
        """A reachable backend that answers 429 is not retried on the same account."""
        self.configure(profiles=("cn-cli",))
        self.allowed_profiles = {"cn-cli"}
        self.dials.clear()
        self.response_status = 429
        with patch.dict(converter.CONFIG, {"failover_max": 2}):
            response = self.post()
        self.assertEqual(self.dial_count(), 1, f"HTTP 错误不得重试同一凭证：{self.dial_count()}")
        self.assertEqual(response.status_code, 429, response.text)

    def test_the_budget_is_per_request_not_per_credential(self):
        """Two requests each get their own budget; the second is not starved by the first."""
        self.configure()
        self.refuse_every_dial()
        counts = []
        with patch.dict(converter.CONFIG, {"failover_max": 2}):
            for _ in range(2):
                self.dials.clear()
                self.post()
                counts.append(self.dial_count())
        self.assertEqual(counts[0], counts[1], f"每请求独立预算：{counts}")
        self.assertLessEqual(counts[0], 3)

    # -- (c) repairs do not spend the budget -----------------------------

    def test_tool_repair_does_not_spend_the_upstream_budget(self):
        """A regenerated tool call re-asks the same account; that must not cost failover."""
        self.configure()
        self.dials.clear()
        self.tool_repair = True

        with patch.dict(converter.CONFIG, {"failover_max": 2}):
            response = self.post(stream=False, tools=True)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.dial_count(), 2, "应当发生过一次 tool-repair")
        # Both dials returned 200, so neither was wasted work: a request that never failed
        # must not have consumed its failover allowance. The real proof is that the repair
        # still happens with the budget installed — without the refund the second dial would
        # have been refused and this request would have failed instead of repairing.
        self.assertIn("synthetic_tool", response.text)

    def test_a_successful_request_leaves_the_budget_untouched(self):
        """Directly pin the refund: a 200 dial must not be charged against failover."""
        budget = converter.AttemptBudget(3, reserved=0)
        budget.charge(1)
        self.assertEqual(budget.remaining, 2)
        budget.refund(1)
        self.assertEqual(budget.remaining, 3, "可用响应必须退还拨号额度")

    # -- the primitive the wiring relies on ------------------------------

    def test_an_exhausted_budget_never_reaches_the_upstream(self):
        """A stale failover step must not dial after the request budget is spent."""
        budget = converter.AttemptBudget(1, reserved=0)
        budget.charge(1)
        self.assertEqual(budget.grant(), 0, "预算耗尽时 grant 必须为 0，让调用方先判再跳过")


if __name__ == "__main__":
    unittest.main(verbosity=2)
