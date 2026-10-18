"""Pin max_concurrent as a hot, WebUI-editable setting and its live gate semantics."""

import asyncio
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # Allow direct execution.

import converter as gateway
from app import runtime_management
from app.inbound_limits import ConcurrencyLimitMiddleware
from app.settings import SCHEMA, apply_persisted_settings, resolve_settings, validate_settings


ROUTES = ("/v1/chat/completions", "/v1/responses", "/v1/messages")
SCOPE = {"type": "http", "method": "POST", "path": "/v1/chat/completions"}


class GateHarness:
    """Drive one middleware with a first request parked in flight, then flip the limit."""

    def __init__(self, start, *, park_first=True, park=1):
        self.config = {"max_concurrent": start}
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.park_first = park_first
        self.park = park
        self.calls = 0
        self.inside = 0      # Requests currently inside the application.

        async def application(scope, receive, send):
            self.calls += 1
            self.inside += 1
            if self.park_first and self.calls <= self.park:
                self.entered.set()
                await self.release.wait()
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"{}"})
            self.inside -= 1

        self.middleware = ConcurrencyLimitMiddleware(application, self.config)

    async def send(self, path=SCOPE["path"]):
        sent = []

        async def receive():
            return {"type": "http.request", "body": b"{}", "more_body": False}

        async def capture(message):
            sent.append(message)

        await asyncio.wait_for(
            self.middleware({**SCOPE, "path": path}, receive, capture), 2)
        return sent

    @staticmethod
    def headers(sent):
        return dict(sent[0]["headers"])

    async def capacity(self, up_to):
        """Measure the live budget by flooding: park every admitted request, count the 200s.

        This is the observable definition of "how many requests may be in flight
        right now", so the assertions below never have to reach into gate internals.
        """
        self.release.clear()
        self.park = up_to + 1
        self.calls = 0
        self.inside = 0
        tasks = [asyncio.create_task(self.send()) for _ in range(up_to)]
        # Settle without a wall-clock sleep: a request is either parked inside the
        # application (admitted) or already finished (rejected), so the flood is
        # fully resolved once done + parked accounts for every task.
        for _ in range(100_000):
            if sum(task.done() for task in tasks) + self.inside >= up_to:
                break
            await asyncio.sleep(0)
        else:  # pragma: no cover - guards against a hung harness, not a gate bug
            raise AssertionError("harness did not settle")
        admitted = self.calls
        self.release.set()
        await asyncio.wait_for(asyncio.gather(*tasks), 2)
        self.park = 0
        self.calls = 0
        return admitted

    async def in_flight(self, count):
        """Park exactly `count` requests inside the application and return their tasks."""
        self.release.clear()
        self.entered.clear()
        self.park = count
        tasks = [asyncio.create_task(self.send()) for _ in range(count)]
        await asyncio.wait_for(self.entered.wait(), 2)
        return tasks

    async def drain(self, tasks):
        self.release.set()
        await asyncio.wait_for(asyncio.gather(*tasks), 2)
        self.park = 0


class HotReloadTests(unittest.IsolatedAsyncioTestCase):
    """Changing max_concurrent must take effect on the next request, without a restart."""

    async def exercise(self, start, change):
        """Park one request in flight, apply the new limit, then admit or reject a second."""
        harness = GateHarness(start)
        first = asyncio.create_task(harness.send())
        await asyncio.wait_for(harness.entered.wait(), 2)
        try:
            harness.config["max_concurrent"] = change
            return harness, await harness.send()
        finally:
            harness.release.set()
            await asyncio.wait_for(first, 2)

    async def test_raising_the_limit_admits_the_next_request(self):
        _, sent = await self.exercise(1, 4)
        self.assertEqual(sent[0]["status"], 200)

    async def test_raising_the_limit_from_zero_admits_the_next_request(self):
        # A gate built while unlimited must still charge the request already in flight.
        _, sent = await self.exercise(0, 4)
        self.assertEqual(sent[0]["status"], 200)

    async def test_lowering_the_limit_from_the_shipped_default_rejects_the_next_request(self):
        """The user-facing case: a long-running process still has all 64 slots open."""
        harness, sent = await self.exercise(64, 1)
        self.assertEqual(sent[0]["status"], 503)
        self.assertEqual(harness.headers(sent)[b"retry-after"], b"3")

    async def test_lowering_a_primed_gate_rejects_on_every_generation_route(self):
        harness = GateHarness(64)
        first = asyncio.create_task(harness.send())
        await asyncio.wait_for(harness.entered.wait(), 2)
        try:
            harness.config["max_concurrent"] = 1
            for path in ROUTES:
                with self.subTest(path=path):
                    sent = await harness.send(path)
                    self.assertEqual(sent[0]["status"], 503)
                    self.assertEqual(harness.headers(sent)[b"retry-after"], b"3")
                    payload = json.loads(sent[1]["body"])
                    self.assertEqual(payload["error"]["code"], "concurrency_limit")
        finally:
            harness.release.set()
            await asyncio.wait_for(first, 2)

    async def test_zero_disables_the_gate_immediately(self):
        _, sent = await self.exercise(1, 0)
        self.assertEqual(sent[0]["status"], 200)

    async def test_raising_the_limit_after_it_was_disabled_starts_limiting(self):
        harness, sent = await self.exercise(0, 1)
        self.assertEqual(sent[0]["status"], 503)
        self.assertEqual(harness.headers(sent)[b"retry-after"], b"3")

    async def test_lowering_below_the_in_flight_count_never_goes_negative(self):
        """Lowering the limit under the in-flight count must over-admit nothing and never underflow."""
        harness = GateHarness(8)
        parked = await harness.in_flight(3)
        try:
            harness.config["max_concurrent"] = 0
            harness.config["max_concurrent"] = 1
            sent = await harness.send()
            self.assertEqual(sent[0]["status"], 503)
        finally:
            await harness.drain(parked)
        # Once everything drains, a limit of 1 must admit exactly one request, not zero
        # (underflow) and not more (over-admission).
        self.assertEqual(await harness.capacity(4), 1)

    async def test_a_first_limit_below_the_in_flight_count_is_clamped_not_fatal(self):
        """Turning the limit on while more requests are in flight than it allows must not raise."""
        harness = GateHarness(0)
        parked = await harness.in_flight(3)
        try:
            self.assertEqual(harness.middleware._active, 3)
            harness.config["max_concurrent"] = 2
            sent = await harness.send()
            self.assertEqual(sent[0]["status"], 503)
        finally:
            await harness.drain(parked)
        self.assertEqual(await harness.capacity(4), 2)

    async def test_round_trip_through_zero_charges_the_requests_admitted_while_unlimited(self):
        """8 -> 0 (4 in flight) -> 8: the 4 bypassed requests must consume real budget.

        Requests admitted while unlimited still count, so if they were forgotten the
        real concurrency would be 8 + 4. Measured behaviourally: with those 4 parked,
        only 4 further requests may be admitted.
        """
        harness = GateHarness(8)
        parked = await harness.in_flight(3)
        harness.park = 4  # the request admitted while unlimited parks too
        try:
            harness.config["max_concurrent"] = 0
            bypass = asyncio.create_task(harness.send())
            await asyncio.sleep(0)  # let the bypassed request park
            harness.config["max_concurrent"] = 8
            self.assertEqual(harness.middleware._active, 4)
            # 4 already in flight against a limit of 8 leaves exactly 4 more.
            self.assertEqual(await harness.capacity(8), 4)
        finally:
            await asyncio.wait_for(bypass, 2)
            await harness.drain(parked)

    async def test_capacity_returns_to_the_limit_after_bypassed_requests_finish(self):
        """64 -> 0 (3 in flight) -> 64, then drain: the budget must settle back at 64.

        If the requests admitted while unlimited were charged but never released, the
        operator would see "I toggled the limit through 0 and lost 3 slots".
        """
        harness = GateHarness(64)
        parked = await harness.in_flight(3)
        harness.park = 4  # the request admitted while unlimited parks too
        harness.config["max_concurrent"] = 0
        bypass = asyncio.create_task(harness.send())
        await asyncio.sleep(0)
        harness.config["max_concurrent"] = 64
        self.assertEqual(harness.middleware._active, 4)
        harness.release.set()
        await asyncio.wait_for(bypass, 2)
        await harness.drain(parked)
        self.assertEqual(harness.middleware._active, 0)
        self.assertEqual(await harness.capacity(64), 64)

    async def test_repeated_zero_round_trips_never_accumulate_drift(self):
        """Four 64 -> 0 -> 64 cycles with requests in flight must each end at 64.

        Each cycle parks two requests while unlimited, so a one-way charge would leak
        two slots per cycle (64, 62, 60, ...). Drift is what a single-cycle test
        cannot see.
        """
        harness = GateHarness(64)
        for cycle in range(4):
            with self.subTest(cycle=cycle):
                harness.config["max_concurrent"] = 64
                parked = await harness.in_flight(2)
                harness.park = 3  # the request admitted while unlimited parks too
                self.assertEqual(harness.middleware._active, 2)
                harness.config["max_concurrent"] = 0
                bypass = asyncio.create_task(harness.send())
                await asyncio.sleep(0)
                harness.config["max_concurrent"] = 64
                self.assertEqual(harness.middleware._active, 3)
                harness.release.set()
                await asyncio.wait_for(bypass, 2)
                await harness.drain(parked)
                self.assertEqual(harness.middleware._active, 0, f"cycle {cycle}")
                self.assertEqual(await harness.capacity(64), 64, f"cycle {cycle} drifted")

    async def test_round_trip_through_zero_with_nothing_in_flight_restores_full_capacity(self):
        """64 -> 0 -> 64 with nothing in flight must not permanently shrink the budget."""
        harness = GateHarness(64, park_first=False)
        await harness.send()
        self.assertEqual(await harness.capacity(64), 64)
        harness.config["max_concurrent"] = 0
        await harness.send()
        harness.config["max_concurrent"] = 64
        self.assertEqual(harness.middleware._active, 0)
        self.assertEqual(await harness.capacity(64), 64)

    async def test_released_slots_are_restored_after_a_hot_raise(self):
        harness = GateHarness(1)
        first = asyncio.create_task(harness.send())
        await asyncio.wait_for(harness.entered.wait(), 2)
        harness.config["max_concurrent"] = 2
        sent = await harness.send()
        self.assertEqual(sent[0]["status"], 200)
        harness.release.set()
        await asyncio.wait_for(first, 2)
        # The second request's slot must come back on release, leaving the full budget.
        self.assertEqual(harness.middleware._active, 0)
        self.assertEqual(await harness.capacity(2), 2)

    async def test_unlimited_requests_are_counted_so_a_later_limit_applies_to_them(self):
        harness = GateHarness(0)
        first = asyncio.create_task(harness.send())
        await asyncio.wait_for(harness.entered.wait(), 2)
        try:
            self.assertEqual(harness.middleware._active, 1)
            harness.config["max_concurrent"] = 1
            sent = await harness.send()
            self.assertEqual(sent[0]["status"], 503)
        finally:
            harness.release.set()
            await asyncio.wait_for(first, 2)
        self.assertEqual(harness.middleware._active, 0)


class HotShrinkRegressionTests(unittest.IsolatedAsyncioTestCase):
    """P0-1: shrinking the limit must not hand the pre-shrink capacity back on release.

    The old gate sized itself as "limit minus in-flight" at the moment the limit
    changed, so every request already in flight when the limit dropped released a
    permit belonging to the *old* generation. Once those requests drained, the gate
    held the old capacity again and a limit of 1 kept admitting 4. Each case below
    measures admitted concurrency at the middleware boundary, so it fails on the old
    implementation and passes on a counter-based one.
    """

    async def test_shrinking_the_limit_with_requests_in_flight_holds_after_they_drain(self):
        """4 -> 1 with 4 in flight: after drain, a limit of 1 admits exactly 1."""
        harness = GateHarness(4)
        inflight = await harness.in_flight(4)
        try:
            harness.config["max_concurrent"] = 1
            # The first request after the change is what re-sizes the old gate.
            sent = await harness.send()
            self.assertEqual(sent[0]["status"], 503)
        finally:
            await harness.drain(inflight)
        self.assertEqual(harness.middleware._active, 0)
        self.assertEqual(await harness.capacity(8), 1)

    async def test_repeated_shrink_cycles_never_inflate_the_budget(self):
        """64 -> 1 -> 64 -> 0 -> 64, four times: a limit of 1 must stay 1 every round."""
        harness = GateHarness(64)
        for cycle in range(4):
            with self.subTest(cycle=cycle):
                harness.config["max_concurrent"] = 64
                inflight = await harness.in_flight(4)
                try:
                    harness.config["max_concurrent"] = 1
                    sent = await harness.send()
                    self.assertEqual(sent[0]["status"], 503, f"cycle {cycle}")
                finally:
                    await harness.drain(inflight)
                self.assertEqual(await harness.capacity(8), 1, f"cycle {cycle} inflated")
                harness.config["max_concurrent"] = 0
                await harness.send()
                harness.config["max_concurrent"] = 64
                self.assertEqual(await harness.capacity(80), 64, f"cycle {cycle} drifted")

    async def test_shrunk_limit_rejects_with_the_documented_contract(self):
        """While shrunk, every generation route answers 503 + Retry-After: 3 + concurrency_limit."""
        harness = GateHarness(4)
        inflight = await harness.in_flight(4)
        try:
            harness.config["max_concurrent"] = 1
            for path in ROUTES:
                with self.subTest(path=path):
                    sent = await harness.send(path)
                    self.assertEqual(sent[0]["status"], 503)
                    headers = harness.headers(sent)
                    self.assertEqual(headers[b"retry-after"], b"3")
                    self.assertEqual(int(headers[b"content-length"]), len(sent[1]["body"]))
                    payload = json.loads(sent[1]["body"])
                    self.assertEqual(payload["error"]["code"], "concurrency_limit")
                    if path == "/v1/messages":
                        self.assertEqual(payload["type"], "error")
                        self.assertEqual(payload["error"]["type"], "api_error")
                    else:
                        self.assertNotIn("type", payload)
                        self.assertEqual(payload["error"]["type"], "rate_limit_error")
        finally:
            await harness.drain(inflight)

    async def test_raising_the_limit_counts_the_requests_already_in_flight(self):
        """1 -> 4 with 1 in flight: the in-flight request consumes one of the 4 slots."""
        harness = GateHarness(1)
        inflight = await harness.in_flight(1)
        try:
            harness.config["max_concurrent"] = 4
            self.assertEqual(await harness.capacity(8), 3)
        finally:
            await harness.drain(inflight)
        self.assertEqual(await harness.capacity(8), 4)


class OverloadContractTests(unittest.IsolatedAsyncioTestCase):
    """The rejection contract itself: 503 (not 429), Retry-After, protocol-shaped body."""

    async def test_overload_returns_503_with_retry_after_and_never_429(self):
        harness = GateHarness(1)
        first = asyncio.create_task(harness.send())
        await asyncio.wait_for(harness.entered.wait(), 2)
        try:
            for path in ROUTES:
                with self.subTest(path=path):
                    sent = await harness.send(path)
                    self.assertEqual(sent[0]["status"], 503)
                    headers = harness.headers(sent)
                    self.assertEqual(headers[b"retry-after"], b"3")
                    payload = json.loads(sent[1]["body"])
                    self.assertEqual(payload["error"]["code"], "concurrency_limit")
                    self.assertEqual(int(headers[b"content-length"]), len(sent[1]["body"]))
                    if path == "/v1/messages":
                        self.assertEqual(payload["type"], "error")
                        self.assertEqual(payload["error"]["type"], "api_error")
                    else:
                        self.assertNotIn("type", payload)
                        self.assertEqual(payload["error"]["type"], "rate_limit_error")
        finally:
            harness.release.set()
            await asyncio.wait_for(first, 2)

    async def test_zero_means_unlimited_on_every_generation_route(self):
        harness = GateHarness(0)
        harness.park = 0  # capacity() parks what it floods; do not park here
        for path in ROUTES:
            with self.subTest(path=path):
                sent = await harness.send(path)
                self.assertEqual(sent[0]["status"], 200)
        # Unlimited means a burst far above any limit is admitted, not that requests
        # go uncounted: _active must still return to 0 once they finish.
        self.assertEqual(await harness.capacity(40), 40)
        self.assertEqual(harness.middleware._active, 0)


class SettingSurfaceTests(unittest.TestCase):
    """max_concurrent must be an ordinary hot management setting, like its per-account sibling."""

    def test_schema_entry_is_hot_bounded_and_environment_overridable(self):
        spec = SCHEMA["max_concurrent"]
        self.assertEqual(spec["default"], 64)
        self.assertEqual(spec["type"], "integer")
        self.assertEqual(spec["mode"], "hot")
        self.assertEqual(spec["env"], "CODEBUDDY2API_MAX_CONCURRENT")
        self.assertFalse(spec["sensitive"])
        self.assertFalse(spec["hidden"])
        self.assertEqual((spec["min"], spec["max"]), (0, 1024))
        self.assertEqual(spec["mode"], SCHEMA["max_inflight_per_account"]["mode"])

    def test_module_default_matches_the_schema_default(self):
        self.assertEqual(gateway.CONFIG["max_concurrent"], SCHEMA["max_concurrent"]["default"])

    def test_environment_value_is_parsed_and_invalid_values_are_rejected(self):
        for raw, expected in (("0", 0), ("1", 1), ("1024", 1024)):
            with self.subTest(raw=raw):
                config = {"control_store": None, "settings_sources": {}}
                apply_persisted_settings(config, environ={"CODEBUDDY2API_MAX_CONCURRENT": raw})
                self.assertEqual(config["max_concurrent"], expected)
                self.assertEqual(config["settings_sources"]["max_concurrent"], "environment")
        for invalid in ({"max_concurrent": -1}, {"max_concurrent": 1025}, {"max_concurrent": True},
                        {"max_concurrent": "64"}):
            with self.subTest(values=invalid):
                with self.assertRaises(ValueError):
                    validate_settings(invalid)

    def test_resolved_settings_expose_the_key_to_the_management_ui(self):
        config = {"control_store": None, "settings_sources": {}, "max_concurrent": 64}
        items = {item["key"]: item for item in resolve_settings(config)}
        self.assertIn("max_concurrent", items)
        item = items["max_concurrent"]
        self.assertEqual((item["value"], item["mode"], item["locked"]), (64, "hot", False))
        self.assertEqual((item["min"], item["max"]), (0, 1024))

    def test_explicit_cli_value_locks_the_key_against_webui_edits(self):
        config = {"control_store": None, "settings_sources": {}, "max_concurrent": 8}
        apply_persisted_settings(config, explicit=("max_concurrent",), environ={})
        items = {item["key"]: item for item in resolve_settings(config)}
        self.assertEqual(config["max_concurrent"], 8)
        self.assertTrue(items["max_concurrent"]["locked"])

    def test_environment_locking_is_reported_as_external(self):
        config = {"control_store": None, "settings_sources": {}}
        apply_persisted_settings(config, environ={"CODEBUDDY2API_MAX_CONCURRENT": "7"})
        items = {item["key"]: item for item in resolve_settings(config)}
        self.assertEqual(items["max_concurrent"]["source"], "environment")
        self.assertTrue(items["max_concurrent"]["locked"])


class ManagementEndpointTests(unittest.IsolatedAsyncioTestCase):
    """Drive the real /admin/settings PATCH and confirm the live gate follows it."""

    def setUp(self):
        from app.admin_api import install_admin
        from app.control_store import ControlStore
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from types import SimpleNamespace
        from unittest.mock import Mock

        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.store = ControlStore(self.root / "control.sqlite3")
        self.addCleanup(self.store.close)
        self.audit = Mock()
        self.audit.storage.return_value = {"db_bytes": 0}
        self.audit.list_records.return_value = {"items": [], "next_cursor": None, "has_more": False}
        self.audit.dashboard.return_value = {"summary": {}, "series": [], "models": [], "profiles": []}
        self.config = {"api_key": "synthetic-key", "control_store": self.store, "max_images": 16,
                       "session_path": self.root / "admin-sessions.json", "settings_sources": {},
                       "max_concurrent": 64, "audit_store": self.audit}
        self.gateway = SimpleNamespace(
            admin_credential_inventory=Mock(return_value=[]),
            admin_model_inventory=Mock(return_value=[]),
            admin_apply_settings=Mock(side_effect=lambda values: self.config.update(values)),
            admin_delete_guard=Mock(), managed_auth_dir=Mock(return_value=self.root),
            _store_credential=Mock(), _credential_identity=Mock(return_value="fingerprint"),
            _save_oauth_credential=Mock(), _OAUTH=Mock())
        app = FastAPI()
        install_admin(app, self.config, self.gateway)
        self.client = TestClient(app)
        self.headers = {"Authorization": "Bearer synthetic-key"}

    def settings(self):
        return self.client.get("/admin/settings", headers=self.headers).json()

    def patch(self, values):
        revision = self.settings()["revision"]
        return self.client.patch("/admin/settings", headers=self.headers,
                                 json={"revision": revision, "values": values})

    def test_settings_page_lists_the_key_as_an_editable_hot_integer(self):
        item = next(i for i in self.settings()["items"] if i["key"] == "max_concurrent")
        self.assertEqual((item["value"], item["mode"], item["type"]), (64, "hot", "integer"))
        self.assertEqual((item["min"], item["max"]), (0, 1024))
        self.assertFalse(item["locked"], "WebUI 必须能改这一项")
        self.assertEqual(item["source"], "default")

    def test_patch_is_persisted_and_hot_applied(self):
        response = self.patch({"max_concurrent": 1})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.config["max_concurrent"], 1)
        self.assertEqual(self.store.snapshot()["settings"]["max_concurrent"], 1)
        self.gateway.admin_apply_settings.assert_called_once_with({"max_concurrent": 1})
        item = next(i for i in response.json()["items"] if i["key"] == "max_concurrent")
        self.assertEqual((item["value"], item["source"], item["locked"]), (1, "management", False))

    def test_out_of_range_values_are_rejected(self):
        for bad in (-1, 1025):
            with self.subTest(value=bad):
                self.assertEqual(self.patch({"max_concurrent": bad}).status_code, 400)
                self.assertEqual(self.config["max_concurrent"], 64)

    def test_environment_lock_blocks_edits(self):
        self.config["settings_sources"] = {"max_concurrent": "environment"}
        self.assertEqual(self.patch({"max_concurrent": 1}).status_code, 400)
        self.assertEqual(self.config["max_concurrent"], 64)
        item = next(i for i in self.settings()["items"] if i["key"] == "max_concurrent")
        self.assertTrue(item["locked"])

    async def test_the_live_gate_follows_a_webui_edit_without_a_restart(self):
        """The whole point of the task: gate built at 64, UI lowers to 1, next request is rejected."""
        entered = asyncio.Event()
        release = asyncio.Event()
        parked = []

        async def application(scope, receive, send):
            if not parked:
                parked.append(True)
                entered.set()
                await release.wait()
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"{}"})

        middleware = ConcurrencyLimitMiddleware(application, self.config)
        scope = {"type": "http", "method": "POST", "path": "/v1/chat/completions"}
        sent = []

        async def receive():
            return {"type": "http.request", "body": b"{}", "more_body": False}

        async def send(message):
            sent.append(message)

        first = asyncio.create_task(middleware(scope, receive, send))
        await asyncio.wait_for(entered.wait(), 2)
        try:
            response = await asyncio.to_thread(self.patch, {"max_concurrent": 1})
            self.assertEqual(response.status_code, 200, response.text)
            sent.clear()
            await middleware(scope, receive, send)
            self.assertEqual(sent[0]["status"], 503)
            self.assertEqual(dict(sent[0]["headers"])[b"retry-after"], b"3")

            response = await asyncio.to_thread(self.patch, {"max_concurrent": 64})
            self.assertEqual(response.status_code, 200, response.text)
            sent.clear()
            await asyncio.wait_for(middleware(scope, receive, send), 2)
            self.assertEqual(sent[0]["status"], 200)
        finally:
            release.set()
            await asyncio.wait_for(first, 2)


class StartupWiringTests(unittest.TestCase):
    """The real main() path must publish the SCHEMA value, not just the argparse default."""

    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.path = self.root / "account.info"
        self.path.write_text(json.dumps({"account": {"uid": "synthetic-uid"}, "auth": {
            "accessToken": "synthetic-token", "refreshToken": "synthetic-refresh",
            "domain": "www.codebuddy.cn", "expiresAt": 4102444800000, "lastRefreshTime": 0}}),
            encoding="utf-8")

    def run_main(self, argv, environ):
        observed = {}
        base = {"CODEBUDDY_AUTH_DIR": str(self.root), "CODEBUDDY2API_KEY": "synthetic-key"}
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {**base, **environ}, clear=True))
            stack.enter_context(patch.dict(gateway.CONFIG))
            stack.enter_context(patch("sys.argv", argv))
            stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            stack.enter_context(patch.object(gateway.threading, "Thread"))
            stack.enter_context(patch.object(gateway, "credits_mod", None))
            stack.enter_context(patch.object(gateway, "seed_credentials"))
            stack.enter_context(patch.object(gateway, "preflight", return_value=True))
            stack.enter_context(patch.object(runtime_management, "install"))
            stack.enter_context(patch.object(gateway.uvicorn, "run",
                                             side_effect=lambda *a, **k: observed.update(
                                                 max_concurrent=gateway.CONFIG.get("max_concurrent"),
                                                 sources=dict(gateway.CONFIG.get("settings_sources", {})))))
            gateway.main()
        return observed

    def test_default_startup_publishes_the_schema_default(self):
        observed = self.run_main(["converter.py", "--skip-check", "--auth-file", str(self.path)], {})
        self.assertEqual(observed["max_concurrent"], SCHEMA["max_concurrent"]["default"])
        self.assertEqual(observed["sources"]["max_concurrent"], "default")

    def test_environment_override_reaches_the_running_config(self):
        observed = self.run_main(["converter.py", "--skip-check", "--auth-file", str(self.path)],
                                 {"CODEBUDDY2API_MAX_CONCURRENT": "7"})
        self.assertEqual(observed["max_concurrent"], 7)
        self.assertEqual(observed["sources"]["max_concurrent"], "environment")


if __name__ == "__main__":
    unittest.main(verbosity=2)
