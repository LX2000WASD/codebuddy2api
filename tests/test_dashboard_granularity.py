"""Dashboard bucket regressions using isolated persistent aggregates."""
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from datetime import datetime, timezone
import tempfile
import unittest
from unittest.mock import patch

from app.audit_store import AuditStore


class GranularityTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.start = datetime(2026, 9, 14, tzinfo=timezone.utc).timestamp()
        self.enterContext(patch("app.audit_store.time.time", return_value=self.start + 12.5 * 3600))
        self.store = AuditStore(self.root / "logs.sqlite3")
        self.addCleanup(self.store.close)
        for hour in (2, 9):
            result = self.store.record_request({"id": f"hour-{hour}", **self.store.ticket(),
                "started_at": self.start + hour * 3600, "public_model": "synthetic-model",
                "profile": "cn-cli", "protocol": "chat", "status_code": 200, "outcome": "success"})
            self.assertTrue(result["ok"])

    def test_one_day_auto_uses_real_hours_without_changing_summary(self):
        hourly = self.store.dashboard(1)
        daily = self.store.dashboard(1, "day")
        self.assertEqual(hourly["range"]["granularity"], "hour")
        self.assertEqual(hourly["range"]["timezone"], "UTC")
        self.assertEqual(len(hourly["series"]), 13)
        self.assertEqual(len(daily["series"]), 1)
        self.assertEqual(hourly["summary"], daily["summary"])
        self.assertEqual([row["bucket"] for row in hourly["series"] if row["requests"]],
                         [self.start + 2 * 3600, self.start + 9 * 3600])
        self.assertEqual(sum(row["requests"] for row in hourly["series"]), 2)
        self.assertIsNone(hourly["series"][0]["credit"])
        self.assertEqual(hourly["series"][0]["requests"], 0)
        self.assertLessEqual(hourly["series"][-1]["bucket"], hourly["range"]["end"])

    def test_granularity_is_explicit_and_bounded(self):
        self.assertEqual(self.store.dashboard(7)["range"]["granularity"], "day")
        self.assertEqual(self.store.dashboard(7, "hour")["range"]["granularity"], "hour")
        self.assertLessEqual(len(self.store.dashboard(90, "hour")["series"]), 90 * 24)
        for grain in ("minute", "stats_hourly; DROP TABLE requests", None):
            with self.subTest(grain=grain), self.assertRaises(ValueError):
                self.store.dashboard(1, grain)
        with self.assertRaises(ValueError):
            self.store.dashboard(91, "hour")

    def test_detail_clear_and_restart_retain_hourly_stats(self):
        before = self.store.dashboard(1)
        self.store.clear("details")
        reopened = AuditStore(self.root / "logs.sqlite3")
        self.addCleanup(reopened.close)
        self.assertEqual(reopened.dashboard(1)["series"], before["series"])
        self.assertEqual(reopened.list_records()["items"], [])
        reopened.clear("all")
        self.assertEqual(sum(row["requests"] for row in reopened.dashboard(1)["series"]), 0)

    def test_missing_hourly_history_is_marked_incomplete_not_split_from_daily(self):
        self.store._db.execute("DELETE FROM stats_hourly")
        result = self.store.dashboard(1, "hour")
        self.assertTrue(result["range"]["partial"])
        self.assertEqual(result["series"], [])
        self.assertEqual(result["summary"]["requests"], 2)
        self.assertFalse(self.store.dashboard(1, "day")["range"]["partial"])


class UnidentifiedModelTests(unittest.TestCase):
    """Unidentified models must not surface as an anonymous bucket in the ranking."""

    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.start = datetime(2026, 9, 14, tzinfo=timezone.utc).timestamp()
        self.enterContext(patch("app.audit_store.time.time", return_value=self.start + 12.5 * 3600))
        self.store = AuditStore(self.root / "logs.sqlite3")
        self.addCleanup(self.store.close)

    def _record(self, **overrides):
        result = self.store.record_request({"id": "r1", **self.store.ticket(),
            "started_at": self.start, "profile": "cn-cli", "protocol": "chat",
            "status_code": 200, "outcome": "success", **overrides})
        self.assertTrue(result["ok"])

    def test_new_records_without_model_write_no_empty_bucket(self):
        self._record()  # No public_model at all.
        dash = self.store.dashboard(1)
        self.assertEqual(dash["summary"]["requests"], 1)  # The global row still counts it.
        self.assertEqual(dash["models"], [])

    def test_legacy_empty_dimension_key_is_skipped(self):
        self._record(public_model="synthetic-model")
        stats = self.store._empty_stats()
        stats["requests"] = 7
        bucket = int(self.start // 86400) * 86400
        self.store._db.execute("INSERT OR REPLACE INTO stats_daily VALUES(?,?,?,?)",
                               (bucket, "model", "", json.dumps(stats)))
        models = self.store.dashboard(1)["models"]
        self.assertEqual([m["model"] for m in models], ["synthetic-model"])
        self.assertEqual(models[0]["requests"], 1)  # The anonymous 7 are not merged anywhere.


class CrossSeriesConsistencyTests(unittest.TestCase):
    """The dashboard and the fusion series must agree on window and resolution.

    Both read the same stats_hourly/stats_daily aggregates, so the numbers match by
    construction; what used to diverge was the meaning of granularity="auto"
    (dashboard said hour for a one-day window, the dimension query always said day).
    """

    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.start = datetime(2026, 9, 14, tzinfo=timezone.utc).timestamp()
        self.enterContext(patch("app.audit_store.time.time", return_value=self.start + 12.5 * 3600))
        self.store = AuditStore(self.root / "logs.sqlite3")
        self.addCleanup(self.store.close)
        for hour in (2, 9):
            self.assertTrue(self.store.record_request({
                "id": f"hour-{hour}", **self.store.ticket(), "started_at": self.start + hour * 3600,
                "public_model": "synthetic-model", "profile": "cn-cli", "protocol": "chat",
                "status_code": 200, "outcome": "success"})["ok"])

    def test_auto_granularity_matches_between_dashboard_and_series(self):
        """auto on a one-day window resolves to hour on both surfaces (docs §4.2)."""
        for days in (1, 7, 30, 90):
            with self.subTest(days=days):
                dash = self.store.dashboard(days, "auto")
                series = self.store.dimension_query("global", None, days, "auto")
                self.assertEqual(dash["range"]["granularity"], series["range"]["granularity"])
                self.assertEqual(dash["range"]["start"], series["range"]["start"])
                self.assertEqual(dash["range"]["partial"], series["range"]["partial"])
                self.assertEqual(dash["series"], series["series"])
        self.assertEqual(self.store.dimension_query("global", None, 1, "auto")["range"]["granularity"], "hour")
        self.assertEqual(self.store.dimension_query("global", None, 7, "auto")["range"]["granularity"], "day")

    def test_one_day_auto_buckets_and_last_bucket_match(self):
        """Same days=1/auto: identical bucket count and identical final bucket."""
        dash = self.store.dashboard(1, "auto")
        series = self.store.dimension_query("global", None, 1, "auto")
        self.assertEqual(len(dash["series"]), len(series["series"]))
        self.assertEqual(len(dash["series"]), 13)  # 00:00 through 12:00 UTC
        self.assertEqual(dash["series"][-1]["bucket"], series["series"][-1]["bucket"])
        self.assertEqual(dash["series"][-1]["requests"], series["series"][-1]["requests"])
        self.assertEqual([r["requests"] for r in dash["series"]],
                         [r["requests"] for r in series["series"]])

    def test_explicit_granularity_is_unchanged_by_the_shared_resolver(self):
        """The resolver only interprets auto; explicit hour/day pass straight through."""
        for grain in ("hour", "day"):
            with self.subTest(granularity=grain):
                dash = self.store.dashboard(1, grain)
                series = self.store.dimension_query("global", None, 1, grain)
                self.assertEqual(dash["range"]["granularity"], grain)
                self.assertEqual(series["range"]["granularity"], grain)
                self.assertEqual(dash["series"], series["series"])

    def test_legacy_empty_key_is_skipped_by_dimension_keys(self):
        """dimension_keys drops anonymous keys exactly like dashboard() does."""
        self.assertTrue(self.store.record_request({
            "id": "named", **self.store.ticket(), "started_at": self.start,
            "public_model": "synthetic-model", "profile": "cn-cli", "protocol": "chat",
            "status_code": 200, "outcome": "success"})["ok"])
        stats = self.store._empty_stats()
        stats["requests"] = 7
        bucket = int(self.start // 86400) * 86400
        self.store._db.execute("INSERT OR REPLACE INTO stats_daily VALUES(?,?,?,?)",
                               (bucket, "model", "", json.dumps(stats)))
        keys = self.store.dimension_keys("model", 1)["keys"]
        self.assertEqual(list(keys), ["synthetic-model"])
        self.assertNotIn("", keys)
        # dashboard() already skipped it: both surfaces now report the same key set.
        self.assertEqual([m["model"] for m in self.store.dashboard(1)["models"]],
                         list(keys))


if __name__ == "__main__":
    unittest.main()
