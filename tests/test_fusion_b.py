"""Fusion-B observability and alerting regressions (offline).

Covers the latency histogram and percentile math, the TTFB-deducted generation
rate, dimension queries, the alert bus (throttling, channel validation,
masking, persistence and a live loopback webhook), the alert evaluator probes
and the health/diagnostic routes.
"""
import json
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from itertools import count
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.audit_store import (AuditStore, BUCKET_COUNT, LATENCY_EDGES,
                             empty_buckets, latency_bucket_index, latency_percentiles,
                             merge_buckets, stats_view)
from app.health_endpoints import install as install_health, pool_counts
import app.diagnostic as diagnostic
import app.alerting as alerting
from app.alerting import AlertBus, AlertEvaluator, mask_url

from fastapi import FastAPI
from fastapi.testclient import TestClient

_SEQUENCE = count()


def _record(store, identity="acct1", model="m1", profile="cn-cli", started=None,
            duration=1000.0, first_token=None, streaming=False, output=100,
            credit=1.0, outcome="success"):
    """Record one synthetic request with the fields the fusion readouts consume."""
    started = started if started is not None else time.time()
    record = {"id": f"req-{next(_SEQUENCE)}-{identity}-{duration}-{output}-{first_token}",
              **store.ticket(),
              "started_at": started, "public_model": model, "profile": profile,
              "credential": identity, "protocol": "chat", "status_code": 200,
              "outcome": outcome, "duration_ms": duration, "first_token_ms": first_token,
              "streaming": streaming, "output_tokens": output, "credit": credit}
    result = store.record_request(record)
    assert result["ok"] and result.get("recorded", True), result
    return record


class HistogramTests(unittest.TestCase):
    def test_bucket_edges_are_exhaustive_and_ordered(self):
        self.assertEqual(len(LATENCY_EDGES), BUCKET_COUNT - 1)
        self.assertEqual(list(LATENCY_EDGES), sorted(LATENCY_EDGES))
        self.assertEqual(latency_bucket_index(0), 0)
        self.assertEqual(latency_bucket_index(99.9), 0)
        self.assertEqual(latency_bucket_index(100), 1)
        self.assertEqual(latency_bucket_index(51199.9), BUCKET_COUNT - 2)
        self.assertEqual(latency_bucket_index(99999999), BUCKET_COUNT - 1)
        self.assertIsNone(latency_bucket_index(None))
        self.assertIsNone(latency_bucket_index(-5))

    def test_percentile_interpolates_within_bucket(self):
        # Ten samples at exactly 100ms land in bucket 1 [100, 200); uniform spacing.
        buckets = empty_buckets()
        buckets[1] = 10
        percentiles = latency_percentiles(buckets)
        self.assertAlmostEqual(percentiles[0.5], 150.0)
        self.assertAlmostEqual(percentiles[0.95], 195.0)
        self.assertAlmostEqual(percentiles[0.99], 199.0)

    def test_percentile_crosses_buckets_linearly(self):
        buckets = empty_buckets()
        buckets[0] = 5   # [0, 100)
        buckets[1] = 5   # [100, 200)
        percentiles = latency_percentiles(buckets)
        self.assertAlmostEqual(percentiles[0.5], 100.0)
        self.assertAlmostEqual(percentiles[0.95], 190.0)
        self.assertAlmostEqual(percentiles[0.99], 198.0)

    def test_open_tail_reports_lower_edge_and_small_samples_are_none(self):
        buckets = empty_buckets()
        buckets[-1] = 7
        percentiles = latency_percentiles(buckets)
        self.assertEqual(percentiles[0.5], float(LATENCY_EDGES[-1]))
        small = empty_buckets()
        small[0] = 4
        self.assertEqual(latency_percentiles(small), {0.5: None, 0.95: None, 0.99: None})

    def test_merge_buckets_is_elementwise_and_tolerant(self):
        left, right = empty_buckets(), empty_buckets()
        left[0], left[1] = 2, 3
        right[0], right[3] = 5, 1
        merged = merge_buckets(left, right)
        self.assertEqual(merged[0], 7)
        self.assertEqual(merged[1], 3)
        self.assertEqual(merged[3], 1)
        self.assertIsNone(merge_buckets(None, None))


class AggregationTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.store = AuditStore(self.root / "logs.sqlite3")
        self.addCleanup(self.store.close)

    def test_histogram_and_percentiles_aggregated(self):
        base = int(time.time() // 86400) * 86400
        for _ in range(6):
            _record(self.store, started=base, duration=150.0, output=100)
        result = self.store.dimension_query("global", None, 1, "day")
        summary = result["summary"]
        self.assertEqual(sum(summary["latency_buckets"]), 6)
        view = stats_view(summary)
        self.assertEqual(view["latency_known"], 6)
        self.assertAlmostEqual(view["latency_p50_ms"], 150.0)
        self.assertAlmostEqual(view["latency_p95_ms"], 195.0)
        self.assertAlmostEqual(view["latency_p99_ms"], 199.0)
        # Six non-streaming records: effective time equals the durations.
        self.assertAlmostEqual(summary["effective_ms_sum"], 900.0)
        self.assertAlmostEqual(summary["tokens_rate_output_sum"], 600)
        self.assertAlmostEqual(view["tokens_per_s"], round(600.0 / 0.9, 2))
        self.assertEqual(view["tokens_per_s_known"], 6)

    def test_effective_time_deduction_semantics(self):
        base = int(time.time() // 86400) * 86400
        # Streaming + first_token >= 200ms: the TTFB is deducted (800ms of generation).
        _record(self.store, started=base, duration=1200.0, first_token=400.0,
                streaming=True, output=800)
        summary = self.store.dimension_query("global", None, 1, "day")["summary"]
        view = stats_view(summary)
        self.assertAlmostEqual(summary["effective_ms_sum"], 800.0)
        self.assertAlmostEqual(view["tokens_per_s"], 800.0 / 0.8)
        # Streaming + first_token < 200ms: fall back to the end-to-end duration.
        _record(self.store, started=base, duration=1200.0, first_token=50.0,
                streaming=True, output=800)
        summary = self.store.dimension_query("global", None, 1, "day")["summary"]
        view = stats_view(summary)
        self.assertAlmostEqual(summary["effective_ms_sum"], 2000.0)
        self.assertAlmostEqual(view["tokens_per_s"], 1600.0 / 2.0)
        self.assertEqual(view["tokens_per_s_known"], 2)
        # A first-byte wait longer than the request itself is inconsistent: the
        # record drops out of the rate (numerator and denominator together).
        _record(self.store, started=base, duration=100.0, first_token=500.0,
                streaming=True, output=50)
        # Unknown output also stays out of the rate entirely.
        _record(self.store, started=base, duration=1000.0, output=None)
        summary = self.store.dimension_query("global", None, 1, "day")["summary"]
        view = stats_view(summary)
        self.assertAlmostEqual(summary["effective_ms_sum"], 2000.0)
        self.assertEqual(view["tokens_per_s_known"], 2)
        self.assertAlmostEqual(view["tokens_per_s"], 1600.0 / 2.0)

    def test_dimension_series_splits_by_account_and_model(self):
        base = int(time.time() // 86400) * 86400
        _record(self.store, identity="acctA", model="m1", started=base, duration=300.0, output=10)
        _record(self.store, identity="acctA", model="m2", started=base, duration=500.0, output=20)
        _record(self.store, identity="acctB", model="m1", started=base, duration=700.0, output=30)
        account = self.store.dimension_query("credential", "acctA", 1, "day")
        self.assertEqual(account["range"]["dimension"], "credential")
        self.assertEqual(account["range"]["key"], "acctA")
        self.assertEqual(sum(row["requests"] for row in account["series"]), 2)
        self.assertEqual(stats_view(account["summary"])["requests"], 2)
        model = self.store.dimension_query("model", "m1", 1, "day")
        self.assertEqual(sum(row["requests"] for row in model["series"]), 2)
        self.assertEqual(self.store.dimension_query("model", "m2", 1, "day")["summary"]["requests"], 1)
        profile = self.store.dimension_query("profile", "cn-cli", 1, "day")
        self.assertEqual(stats_view(profile["summary"])["requests"], 3)

    def test_dimension_series_hourly_granularity_matches_daily_summary(self):
        base = int(time.time() // 86400) * 86400
        for hour in (2, 9):
            _record(self.store, started=base + hour * 3600, duration=250.0, output=10)
        hourly = self.store.dimension_query("global", None, 1, "hour")
        daily = self.store.dimension_query("global", None, 1, "day")
        self.assertEqual(hourly["range"]["granularity"], "hour")
        expected_hours = int(hourly["range"]["end"] // 3600) - int(hourly["range"]["start"] // 3600) + 1
        self.assertEqual(len(hourly["series"]), expected_hours)
        self.assertEqual(sum(row["requests"] for row in hourly["series"]),
                         daily["summary"]["requests"])
        self.assertEqual([row["bucket"] for row in hourly["series"] if row["requests"]],
                         [base + 2 * 3600, base + 9 * 3600])
        self.assertIn("latency_buckets", hourly["series"][0])

    def test_dimension_keys_ordered_bounded_and_validated(self):
        base = int(time.time() // 86400) * 86400
        for index in range(5):
            for repeat in range(index + 1):
                _record(self.store, identity=f"acct{index}", started=base, output=(index + 1) * 10)
        result = self.store.dimension_keys("credential", 1)
        keys = list(result["keys"].keys())
        self.assertEqual(len(keys), 5)
        self.assertEqual(keys[0], "acct4")  # most requests first
        view = stats_view(result["keys"]["acct4"])
        self.assertEqual(view["requests"], 5)
        self.assertEqual(view["output_tokens"], 250)
        for invalid in (lambda: self.store.dimension_keys("global"),
                        lambda: self.store.dimension_keys("credential", "bad"),
                        lambda: self.store.dimension_query("global", "unexpected-key", 1, "day"),
                        lambda: self.store.dimension_query("credential", "acct0", 91, "hour"),
                        lambda: self.store.dimension_query("credential", "acct0", 0, "day"),
                        lambda: self.store.dimension_query("nope", "x", 1, "day"),
                        lambda: self.store.dimension_query("credential", "acct0", 1, "minute")):
            with self.assertRaises(ValueError):
                invalid()

    def test_details_clear_keeps_percentiles_and_rates(self):
        base = int(time.time() // 86400) * 86400
        for index in range(6):
            _record(self.store, started=base, duration=100.0 + index * 50,
                    output=100, streaming=True, first_token=300.0)
        before = stats_view(self.store.dimension_query("global", None, 1, "day")["summary"])
        self.store.clear("details")
        after = stats_view(self.store.dimension_query("global", None, 1, "day")["summary"])
        self.assertEqual(after["latency_known"], before["latency_known"])
        self.assertEqual(after["tokens_per_s"], before["tokens_per_s"])
        self.assertEqual(after["latency_p50_ms"], before["latency_p50_ms"])

    def test_legacy_payloads_merge_without_histogram(self):
        # Rows written before the fusion keys exist must not corrupt the merge.
        self.store._run(lambda: self.store._db.execute(
            "INSERT OR REPLACE INTO stats_daily VALUES(?,?,?,?)",
            (int(time.time() // 86400) * 86400, "global", "",
             json.dumps({"requests": 3, "duration_ms_sum": 900, "duration_ms_known": 3}))),
            write=True)
        summary = self.store.dimension_query("global", None, 1, "day")["summary"]
        self.assertEqual(summary["requests"], 3)
        self.assertEqual(sum(summary["latency_buckets"]), 0)


class AlertBusTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.path = self.root / "alerts-state.json"
        values = {"alert_enabled": True, "alert_throttle_seconds": 60,
                  "alert_history_limit": 8, "alert_retry_count": 1,
                  "alert_timeout_seconds": 5, "alert_evaluator_interval_seconds": 0,
                  "health_service_name": "codebuddy2api"}
        self.bus = AlertBus(self.path, settings=lambda key, default=None: values.get(key, default))
        self.addCleanup(self.bus.close)

    def test_record_throttles_and_trims_history(self):
        first = self.bus.record("pool_exhausted", title="t", detail="d")
        self.assertTrue(first["recorded"])
        second = self.bus.record("pool_exhausted", title="t", detail="d")
        self.assertFalse(second["recorded"])
        self.assertTrue(second["throttled"])
        self.assertEqual(len(self.bus.events(limit=100)), 1)
        for index in range(10):
            self.bus.record("token_circuit", title="t", detail="d", account_id=f"acc{index}")
        self.assertLessEqual(len(self.bus.events(limit=100)), 8)

    def test_record_rejects_unknown_kind(self):
        with self.assertRaises(ValueError):
            self.bus.record("not_a_kind")

    def test_channels_validation_and_masking(self):
        with self.assertRaises(ValueError):
            self.bus.update_channels({"channels": {"unknown": {}}})
        with self.assertRaises(ValueError):
            self.bus.update_channels({"channels": {"webhook": {"enabled": True, "url": "ftp://x"}}})
        with self.assertRaises(ValueError):
            self.bus.update_channels({"channels": {"webhook": {"enabled": True,
                                                               "url": "https://h.example.com/q",
                                                               "extra": 1}}})
        with self.assertRaises(ValueError):
            self.bus.update_channels({"channels": {"bark": {"enabled": True, "key": ""}}})
        with self.assertRaises(ValueError):
            self.bus.update_channels({"channels": {"email": {"enabled": True, "smtp_host": "smtp.x",
                                                             "from": "a@b.c", "to": ["bad-email"],
                                                             "smtp_port": 465}}})
        with self.assertRaises(ValueError):
            self.bus.update_channels({"channels": {"webhook": {"enabled": True,
                                                               "url": "https://user:pw@h.example.com"}}})
        with self.assertRaises(ValueError):
            self.bus.update_channels({"channels": None})
        readout = self.bus.update_channels({"channels": {
            "webhook": {"enabled": True, "url": "https://hook.example.com/path?token=SECRET"},
            "bark": {"enabled": True, "server": "", "key": "abcdef1234"},
            "email": {"enabled": False, "smtp_host": "smtp.example.com", "smtp_port": 587,
                      "username": "u", "password": "p", "from": "alert@example.com",
                      "to": ["ops@example.com"], "use_tls": True}}})
        channels = readout["channels"]
        self.assertEqual(channels["webhook"]["url_masked"], "https://hook.example.com/path")
        self.assertTrue(channels["webhook"]["has_secret"])
        self.assertEqual(channels["bark"]["key_masked"], "abcd****")
        self.assertEqual(channels["bark"]["server"], "https://api.day.app")
        self.assertEqual(channels["email"]["password_masked"], "********")
        self.assertTrue(readout["persisted"])
        self.assertEqual(mask_url("https://a.example.com")[0], "https://a.example.com")
        # Reload keeps the validated state and hides secrets identically.
        reloaded = AlertBus(self.path, settings=lambda key, default=None: None)
        self.addCleanup(reloaded.close)
        self.assertEqual(reloaded.channels_masked()["channels"]["webhook"]["url_masked"],
                         "https://hook.example.com/path")
        self.assertEqual(len(reloaded.events(limit=100)), 0)

    def test_events_filtering_and_corrupt_state(self):
        self.bus.record("audit_degraded", title="a", detail="d")
        self.bus.record("token_circuit", title="b", detail="d", account_id="acc1")
        items = self.bus.events(limit=10)
        self.assertEqual(len(items), 2)
        self.assertTrue(items[0]["fired_at"] >= items[1]["fired_at"])
        self.assertEqual([item["kind"] for item in self.bus.events(limit=10, kinds={"token_circuit"})],
                         ["token_circuit"])
        self.assertEqual(len(self.bus.events(limit=10, severity="critical")), 1)
        self.assertEqual(len(self.bus.events(limit=10, since=time.time() + 10)), 0)
        # A damaged state file must not break construction.
        self.path.write_text("{invalid json", encoding="utf-8")
        fresh = AlertBus(self.path, settings=lambda key, default=None: None)
        self.addCleanup(fresh.close)
        self.assertEqual(fresh.events(limit=10), [])

    def test_status_reports_runtime_state(self):
        status = self.bus.status()
        self.assertTrue(status["enabled"])  # this class' settings enable alerting
        self.assertFalse(status["evaluator_running"])
        self.assertEqual(status["pending_deliveries"], 0)
        self.assertTrue(status["persisted"])


class WebhookDeliveryTests(unittest.TestCase):
    """Drive the delivery path through a real loopback HTTP server."""

    captured = []

    @classmethod
    def setUpClass(cls):
        cls.captured.clear()

        def _capture(request):
            length = int(request.headers.get("Content-Length") or 0)
            cls.captured.append({
                "path": request.path,
                "headers": {key.lower(): value for key, value in request.headers.items()},
                "body": json.loads(request.rfile.read(length) or b"{}"),
            })
            request.send_response(200)
            request.send_header("Content-Type", "application/json")
            request.send_header("Content-Length", "2")
            request.end_headers()
            request.wfile.write(b"{}")

        handler = type("Capture", (BaseHTTPRequestHandler,), {
            "do_POST": lambda self: _capture(self),
            "log_message": lambda self, *args: None,
            "protocol_version": "HTTP/1.1",
        })
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}/hook"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.path = self.root / "alerts-state.json"
        values = {"alert_enabled": True, "alert_throttle_seconds": 3600,
                  "alert_history_limit": 50, "alert_retry_count": 1,
                  "alert_timeout_seconds": 5, "health_service_name": "codebuddy2api"}
        self.bus = AlertBus(self.path, settings=lambda key, default=None: values.get(key, default))
        self.addCleanup(self.bus.close)
        self.bus.update_channels({"channels": {"webhook": {"enabled": True, "url": self.url}}})
        self.captured.clear()

    def test_test_channel_posts_signed_payload(self):
        result = self.bus.test_channel("webhook")
        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["attempts"], 1)
        self.assertEqual(len(self.captured), 1)
        request = self.captured[0]
        self.assertEqual(request["headers"]["x-service"], "codebuddy2api")
        self.assertEqual(request["headers"]["x-alert-kind"], "channel_test")
        self.assertEqual(request["body"]["service"], "codebuddy2api")
        self.assertEqual(request["body"]["severity"], "info")
        self.assertEqual(request["body"]["kind"], "channel_test")
        self.assertIn("fired_at", request["body"])
        # The synthetic event lands in history with its delivery outcome.
        history = self.bus.events(limit=10, kinds={"channel_test"})
        self.assertEqual(len(history), 1)
        self.assertTrue(history[0]["delivered"][0]["ok"])

    def test_async_delivery_reaches_enabled_channels(self):
        self.bus.record("pool_exhausted", title="触底", detail="无可服务账号")
        deadline = time.time() + 5
        history = []
        while time.time() < deadline:
            history = self.bus.events(limit=5, kinds={"pool_exhausted"})
            if history and history[0]["delivered"]:
                break
            time.sleep(0.05)
        self.assertEqual(len(history), 1)
        self.assertTrue(history[0]["delivered"][0]["ok"], history)
        self.assertEqual(self.captured[0]["body"]["kind"], "pool_exhausted")

    def test_unreachable_webhook_reports_failure_without_raising(self):
        bad = AlertBus(None, settings=lambda key, default=None: {
            "alert_retry_count": 1, "alert_timeout_seconds": 0.5,
            "alert_history_limit": 5}.get(key, default))
        self.addCleanup(bad.close)
        bad.update_channels({"channels": {"webhook": {"enabled": True,
                                                      "url": "http://127.0.0.1:1/unreachable"}}})
        result = bad.test_channel("webhook")
        self.assertFalse(result["ok"])
        self.assertIsNotNone(result["error"])
        # Failure is recorded on the event, never raised to the caller.
        history = bad.events(limit=5, kinds={"channel_test"})
        self.assertFalse(history[0]["delivered"][0]["ok"])


class EvaluatorTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.bus = AlertBus(self.root / "alerts-state.json",
                            settings=lambda key, default=None: None)
        self.addCleanup(self.bus.close)

    def _evaluate(self, rows, audit_storage=None, pool=None):
        class FakeManagement:
            def admin_credential_inventory(self):
                return rows

        class FakeAudit:
            def storage(self):
                return audit_storage or {"degraded": False, "available": True}

        config = {"management": FakeManagement(), "audit_store": FakeAudit()}
        if pool is not None:
            config["cred_pool"] = pool
        evaluator = AlertEvaluator(self.bus, config)
        # evaluate_once imports pool_counts from health_endpoints lazily, so the
        # module attribute patch is what its import resolves at call time.
        with patch("app.health_endpoints.pool_counts",
                   lambda cfg: pool if pool is not None else {"total": 0, "healthy": 0, "servable": False}):
            evaluator.evaluate_once()

    def test_credits_expiring_within_threshold_fires(self):
        now = time.time()
        row = {"id": "acc1", "name": "one.info", "credits": {
            "fetched_at": now, "partial": False,
            "segments": [{"remaining": 120.0, "total": 500.0, "expires_at": now + 2 * 86400}]}}
        self._evaluate([row])
        kinds = [item["kind"] for item in self.bus.events(limit=10)]
        self.assertIn("credits_expiring", kinds)

    def test_credits_expiring_beyond_threshold_is_silent(self):
        now = time.time()
        row = {"id": "acc1", "credits": {"fetched_at": now, "partial": False,
                                         "segments": [{"remaining": 120.0,
                                                       "expires_at": now + 30 * 86400}]}}
        self._evaluate([row])
        self.assertEqual(self.bus.events(limit=10), [])

    def test_balance_circuit_and_sync_events(self):
        now = time.time()
        row = {"id": "acc2", "name": "two.info", "fail_until": now + 300,
               "sync_error": "boom", "credits": {"fetched_at": now, "partial": False,
                                                 "segments": []}}
        self._evaluate([row])
        kinds = {item["kind"] for item in self.bus.events(limit=10)}
        self.assertEqual(kinds, {"balance_exhausted", "token_circuit", "catalog_sync_failed"})

    def test_partial_sync_does_not_fire_balance_alert(self):
        now = time.time()
        row = {"id": "acc3", "credits": {"fetched_at": now, "partial": True, "segments": []}}
        self._evaluate([row])
        self.assertNotIn("balance_exhausted", {item["kind"] for item in self.bus.events(limit=10)})

    def test_audit_degraded_and_pool_exhausted(self):
        self._evaluate([], audit_storage={"degraded": True, "available": True,
                                          "failure_count": 1, "dropped_records": 0})
        kinds = [item["kind"] for item in self.bus.events(limit=10)]
        self.assertIn("audit_degraded", kinds)
        self._evaluate([], pool={"total": 3, "healthy": 0, "servable": False})
        kinds = [item["kind"] for item in self.bus.events(limit=10)]
        self.assertIn("pool_exhausted", kinds)


class PoolCountsTests(unittest.TestCase):
    class FakePool:
        def __init__(self, entries, rows):
            self._lock = threading.RLock()
            self._entries = entries
            self._rows = rows

        def entries(self):
            return self._entries

        def snapshot(self):
            return self._rows

    def test_classification_matches_inventory_states(self):
        now = time.time()
        entries = [{"id": "/auth/ready.info", "profile": "cn-cli", "account_key": "k1"},
                   {"id": "/auth/disabled.info", "profile": "cn-cli", "account_key": "k2"},
                   {"id": "/auth/cooling.info", "profile": "intl-cli", "account_key": "k3"},
                   {"id": "/auth/expired.info", "profile": "intl-cli", "account_key": "k4"},
                   {"id": "/auth/err.info", "profile": "cn-work", "account_key": "k5"}]
        rows = [{"auth_file": "/auth/ready.info"},
                {"auth_file": "/auth/disabled.info"},
                {"auth_file": "/auth/cooling.info", "fail_until": now + 100},
                {"auth_file": "/auth/expired.info", "token_expired": True},
                {"auth_file": "/auth/err.info", "error": "sync failed"}]
        config = {"cred_pool": self.FakePool(entries, rows)}
        with patch("app.health_endpoints.model_policy.credential_enabled",
                   lambda cfg, entry: entry["account_key"] != "k2"):
            counts = pool_counts(config)
        self.assertEqual(counts["total"], 5)
        self.assertEqual(counts["healthy"], 1)
        self.assertTrue(counts["servable"])
        self.assertEqual(counts["disabled"], 1)
        self.assertEqual(counts["cooling"], 1)
        self.assertEqual(counts["expired"], 1)
        self.assertEqual(counts["error"], 1)
        self.assertEqual(counts["by_profile"]["cn-cli"]["healthy"], 1)
        self.assertEqual(counts["by_profile"]["intl-cli"]["total"], 2)
        # No pool means no service; the probe stays 503.
        self.assertIs(pool_counts({})["servable"], False)


class LazyThreadTests(unittest.TestCase):
    """Default deployments must gain no resident alerting threads at startup."""

    def _config(self, alert_enabled):
        return {"alert_enabled": alert_enabled, "alert_throttle_seconds": 3600,
                "alert_history_limit": 20, "alert_timeout_seconds": 5, "alert_retry_count": 0,
                "alert_evaluator_interval_seconds": 0, "health_service_name": "codebuddy2api"}

    def test_install_starts_no_threads_when_alerting_disabled(self):
        app = FastAPI()
        config = self._config(alert_enabled=False)
        created = []
        real_thread = threading.Thread

        class RecordingThread(real_thread):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                created.append(self)

        with patch("app.alerting.threading.Thread", RecordingThread):
            alerting.install(app, config, state_path=None, version="t")
        bus = config["alert_bus"]
        self.addCleanup(bus.close)
        self.assertEqual(created, [])
        self.assertIsNone(config.get("alert_evaluator"))
        self.assertFalse(bus.status()["evaluator_running"])
        # Recording an event with delivery off never raises the sender either.
        bus.record("pool_exhausted", title="t", detail="d")
        self.assertFalse(bus._sender_started)

    def test_install_starts_evaluator_when_alerting_enabled(self):
        app = FastAPI()
        config = self._config(alert_enabled=True)
        alerting.install(app, config, state_path=None, version="t")
        bus = config["alert_bus"]
        self.addCleanup(bus.close)
        evaluator = config["alert_evaluator"]
        self.assertIsNotNone(evaluator)
        self.assertTrue(bus.status()["evaluator_running"])

    def test_alerts_request_raises_evaluator_lazily(self):
        app = FastAPI()
        config = self._config(alert_enabled=False)
        alerting.install(app, config, state_path=None, version="t")
        bus = config["alert_bus"]
        self.addCleanup(bus.close)
        client = TestClient(app)
        self.assertIsNone(config.get("alert_evaluator"))
        response = client.get("/admin/alerts/events")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(config["alert_evaluator"].thread.is_alive())
        self.assertTrue(bus.status()["evaluator_running"])

    def test_sender_starts_only_when_a_delivery_is_queued(self):
        silenced = AlertBus(None, settings=lambda key, default=None: None)
        self.addCleanup(silenced.close)
        silenced.record("pool_exhausted", title="t", detail="d")
        self.assertFalse(silenced._sender_started)
        enabled = AlertBus(None, settings=lambda key, default=None: {
            "alert_enabled": True, "alert_throttle_seconds": 3600,
            "alert_history_limit": 5}.get(key, default))
        self.addCleanup(enabled.close)
        self.assertFalse(enabled._sender_started)
        enabled.record("pool_exhausted", title="t", detail="d")
        self.assertTrue(enabled._sender_started)
        self.assertIsNotNone(enabled._sender)


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.config = {
            "alert_enabled": False, "alert_throttle_seconds": 3600,
            "alert_history_limit": 20, "alert_timeout_seconds": 5, "alert_retry_count": 0,
            "alert_evaluator_interval_seconds": 0, "health_service_name": "codebuddy2api",
        }
        self.app = FastAPI()
        install_health(self.app, self.config, version="1.3.2-local")
        diagnostic.install(self.app, self.config)
        alerting.install(self.app, self.config,
                         state_path=self.root / "alerts-state.json", version="1.3.2-local")
        self.client = TestClient(self.app)
        self.addCleanup(lambda: self.config["alert_bus"].close())

    def test_healthz_carries_service_identity(self):
        # An unconfigured pool is explicitly not servable: 503 with the identity body.
        response = self.client.get("/healthz")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.headers["X-Service"], "codebuddy2api")
        body = response.json()
        self.assertEqual(body["service"], "codebuddy2api")
        self.assertEqual(body["status"], "degraded")
        self.assertFalse(body["servable"])
        # A pool with one ready account flips the probe to 200 with the same shape.
        class ReadyPool:
            _lock = threading.RLock()

            def entries(self):
                return [{"id": "/auth/ready.info", "profile": "cn-cli", "account_key": "k1"}]

            def snapshot(self):
                return [{"auth_file": "/auth/ready.info"}]

        self.config["cred_pool"] = ReadyPool()
        response = self.client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["healthy"], 1)
        self.assertTrue(body["servable"])
        # /healthz stays reachable without any credentials.
        self.assertEqual(self.client.get("/healthz").status_code, 200)

    def test_admin_status_reports_pool_and_alerts(self):
        response = self.client.get("/admin/status")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["service"], "codebuddy2api")
        self.assertEqual(body["version"], "1.3.2-local")
        self.assertEqual(body["pool"]["total"], 0)
        # No audit store configured: the status reports the degraded marker.
        self.assertTrue(body["audit"]["degraded"])
        self.assertFalse(body["alerts"]["enabled"])

    def test_diagnostic_shape_with_management(self):
        now = time.time()

        class FakeManagement:
            def admin_credential_inventory(self):
                return [{"id": "acc1", "name": "one.info", "profile": "cn-cli",
                         "enabled": True, "health": "circuit_open", "fail_until": now + 500,
                         "cooldowns": [{"model": "m1", "until": now + 900}],
                         "last_error_code": "http_401", "catalog_ready": True}]

        class FakeBlocksPool:
            _lock = threading.RLock()
            _model_fail = {("/auth/one.info", "m1"): now + 900}

            def entries(self):
                return [{"id": "/auth/one.info", "profile": "cn-cli", "account_key": "acc1"}]

            def snapshot(self):
                return []

            def model_blocks_detail(self):
                return [{"endpoint": "https://www.codebuddy.ai", "model": "unavailable-model",
                         "until": now + 3600, "hits": 2, "code": "404", "msg": "not found"}]

            def cooldown_storage(self):
                return {"available": True, "degraded": False, "rows": 1, "last_error": None}

        self.config["management"] = FakeManagement()
        self.config["cred_pool"] = FakeBlocksPool()
        response = self.client.get("/admin/diagnostic")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        account = body["accounts"][0]
        self.assertEqual(account["disabled_reason"], "认证熔断")
        self.assertEqual(account["cooldown"]["remaining_seconds"], 500)
        self.assertEqual(len(account["model_cooldowns"]), 1)
        self.assertEqual(account["model_cooldowns"][0]["remaining_seconds"], 900)
        self.assertEqual(len(body["model_locks"]), 2)
        locks = {lock["model"]: lock for lock in body["model_locks"]}
        rate_lock = locks["m1"]
        self.assertEqual(rate_lock["kind"], "rate_limit")
        self.assertEqual(rate_lock["locked_accounts"], 1)
        self.assertEqual(rate_lock["account_ids"], ["acc1"])
        self.assertEqual(rate_lock["all_unlock_in_seconds"], 900)
        block_lock = locks["unavailable-model"]
        self.assertEqual(block_lock["kind"], "model_block")
        self.assertTrue(block_lock["advisory"])

    def test_alerts_endpoints_round_trip(self):
        events = self.client.get("/admin/alerts/events")
        self.assertEqual(events.status_code, 200)
        self.assertEqual(events.json()["items"], [])
        channels = self.client.get("/admin/alerts/channels")
        self.assertEqual(channels.status_code, 200)
        readout = channels.json()["channels"]
        self.assertIsNone(readout["webhook"]["url_masked"])
        self.assertIsNone(readout["bark"]["key_masked"])
        update = self.client.put("/admin/alerts/channels",
                                 json={"channels": {"webhook": {"enabled": False,
                                                                "url": "https://h.example.com/x"}}})
        self.assertEqual(update.status_code, 200)
        self.assertEqual(update.json()["channels"]["webhook"]["url_masked"], "https://h.example.com/x")
        # Invalid channel name and bad payload stay 400.
        self.assertEqual(self.client.post("/admin/alerts/test?channel=nope").status_code, 400)
        self.assertEqual(self.client.put("/admin/alerts/channels", json={"channels": None}).status_code, 400)
        # Disabled channel cannot be tested.
        self.assertEqual(self.client.post("/admin/alerts/test?channel=webhook").status_code, 400)


if __name__ == "__main__":
    unittest.main()
