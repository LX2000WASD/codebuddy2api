#!/usr/bin/env python3
"""Test restricted-account probing: one real chat request decides whether upstream lifted 11140."""
import sys
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # Allow direct execution.

import tempfile
import time
import unittest
from unittest.mock import Mock, patch

import converter
from app import restricted_probe
from app.control_store import ControlStore

CATALOG = [{"id": "fast-model", "credits": "x0.00", "supportsToolCall": True},
           {"id": "paid-model", "credits": "x0.5", "supportsToolCall": True}]


class ProbeFixture(unittest.TestCase):
    def setUp(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.store = ControlStore(root / "control.sqlite3")
        self.addCleanup(self.store.close)
        self.audit = Mock()
        self.pool = Mock()
        self.pool.entries.return_value = [{"account_key": "acct", "cm": Mock(), "profile": "intl-work",
                                           "fail_until": 0.0}]
        self.gateway = Mock(CONFIG={
            "control_store": self.store, "audit_store": self.audit, "cred_pool": self.pool,
            "account_catalogs": {"acct": {"profile": "intl-work", "serves": CATALOG}},
            "restricted_probe": True, "restricted_probe_interval_s": 21600,
        })
        self.gateway._usable_models.side_effect = converter._usable_models
        self.gateway._catalog_account_scope.side_effect = lambda account, scope: account["serves"]
        self.gateway._upstream_model.side_effect = lambda model, profile: model
        self.enterContext(patch.object(restricted_probe, "_state", {}))
        self.store.set_restricted("acct", reason="test", evidence="code=11140")

    def restricted(self):
        return self.store.snapshot()["credentials"]["acct"].get("restricted") is True

    def enabled(self):
        return self.store.snapshot()["credentials"]["acct"].get("enabled") is True

    def entry(self):
        return self.pool.entries.return_value[0]


class VerdictTests(ProbeFixture):
    def test_a_200_releases_the_account_and_records_the_event(self):
        with patch.object(restricted_probe, "_one_chat", return_value=(200, None, "")):
            result = restricted_probe.probe(self.gateway, self.entry())
        self.assertTrue(result["released"])
        self.assertFalse(self.restricted())
        self.assertTrue(self.enabled())
        self.assertEqual(restricted_probe.state_of("acct")["fails"], 0)
        self.audit.event.assert_called_once()
        kind, action, details = self.audit.event.call_args.args
        self.assertEqual((kind, action), ("runtime", "credential.restricted_probe"))
        self.assertEqual((details["released"], details["trigger"], details["source"]), (True, "auto", "probe"))

    def test_11140_keeps_the_durable_restriction_and_counts_the_failure(self):
        before = dict(self.entry())
        with patch.object(restricted_probe, "_one_chat", return_value=(403, "11140", "request illegal")):
            result = restricted_probe.probe(self.gateway, self.entry())
        self.assertFalse(result["released"])
        self.assertTrue(self.restricted())
        self.assertFalse(self.enabled())
        self.assertEqual(restricted_probe.state_of("acct")["fails"], 1)
        self.assertEqual(self.entry(), before, "a failed probe must not touch the pool entry")

    def test_other_statuses_leave_every_state_alone(self):
        for status in (401, 429, 500, 502):
            with self.subTest(status=status):
                restricted_probe.reset_state()
                with patch.object(restricted_probe, "_one_chat", return_value=(status, "6004", "quota")):
                    result = restricted_probe.probe(self.gateway, self.entry())
                self.assertFalse(result["released"])
                self.assertTrue(self.restricted())
                self.assertEqual(restricted_probe.state_of("acct")["fails"], 0)
                self.assertEqual(restricted_probe.state_of("acct")["last_status"], status)

    def test_a_transport_failure_is_not_evidence_about_the_restriction(self):
        with patch.object(restricted_probe, "_one_chat", side_effect=RuntimeError("connect")):
            result = restricted_probe.probe(self.gateway, self.entry())
        self.assertFalse(result["released"])
        self.assertTrue(self.restricted())
        self.assertEqual(restricted_probe.state_of("acct")["last_code"], "RuntimeError")

    def test_an_account_without_a_usable_catalog_model_is_skipped(self):
        self.gateway.CONFIG["account_catalogs"] = {}
        with patch.object(restricted_probe, "_one_chat") as chat:
            result = restricted_probe.probe(self.gateway, self.entry())
        chat.assert_not_called()
        self.assertEqual(result["code"], "no_model")
        self.assertTrue(self.restricted())


class ScheduleTests(ProbeFixture):
    def test_the_interval_floors_the_next_probe(self):
        now = time.time()
        restricted_probe._state["acct"] = {"last_at": now, "fails": 0}
        due = restricted_probe.due_at(self.gateway.CONFIG, "acct", restricted_at=now - 1)
        self.assertAlmostEqual(due, now + 21600, delta=1)

    def test_the_first_probe_waits_one_interval_after_the_restriction(self):
        restricted_at = time.time() - 3600
        due = restricted_probe.due_at(self.gateway.CONFIG, "acct", restricted_at=restricted_at)
        self.assertAlmostEqual(due, restricted_at + 21600, delta=1)

    def test_three_consecutive_11140_answers_back_the_account_off_to_a_day(self):
        now = time.time()
        restricted_probe._state["acct"] = {"last_at": now, "fails": restricted_probe.PROBE_FAIL_THRESHOLD}
        self.assertAlmostEqual(restricted_probe.due_at(self.gateway.CONFIG, "acct", restricted_at=now),
                               now + restricted_probe.PROBE_BACKOFF_S, delta=1)

    def test_a_success_clears_the_failure_streak(self):
        restricted_probe._state["acct"] = {"last_at": time.time(), "fails": 2}
        with patch.object(restricted_probe, "_one_chat", return_value=(200, None, "")):
            restricted_probe.probe(self.gateway, self.entry())
        self.assertEqual(restricted_probe.state_of("acct")["fails"], 0)
        self.assertGreater(restricted_probe.state_of("acct")["released_at"], 0)


class LoopTests(ProbeFixture):
    def test_the_switch_off_sends_no_request(self):
        self.gateway.CONFIG["restricted_probe"] = False
        with patch.object(restricted_probe, "_one_chat") as chat:
            self.assertIsNone(restricted_probe.run_once(self.gateway))
        chat.assert_not_called()

    def test_a_probe_that_is_not_due_is_not_sent(self):
        restricted_probe._state["acct"] = {"last_at": time.time(), "fails": 0}
        with patch.object(restricted_probe, "_one_chat") as chat:
            self.assertIsNone(restricted_probe.run_once(self.gateway))
        chat.assert_not_called()

    def test_one_cycle_probes_at_most_one_account(self):
        self.pool.entries.return_value = [
            {"account_key": "acct", "cm": Mock(), "profile": "intl-work"},
            {"account_key": "acct2", "cm": Mock(), "profile": "intl-work"},
        ]
        self.gateway.CONFIG["account_catalogs"]["acct2"] = {"profile": "intl-work", "serves": CATALOG}
        self.store.set_restricted("acct2", reason="test", evidence="code=11140")
        # Both accounts were restricted long enough ago to be due this cycle.
        for key in ("acct", "acct2"):
            restricted_probe._state[key] = {"last_at": time.time() - 40000, "fails": 0}
        with patch.object(restricted_probe, "_one_chat", return_value=(403, "11140", "request illegal")) as chat:
            restricted_probe.run_once(self.gateway)
        chat.assert_called_once()
        probed = [key for key, row in restricted_probe._state.items() if row.get("last_status") is not None]
        self.assertEqual(len(probed), 1, "one cycle must probe exactly one account")

    def test_only_restricted_accounts_are_probed(self):
        self.store.clear_restricted("acct")
        with patch.object(restricted_probe, "_one_chat") as chat:
            self.assertIsNone(restricted_probe.run_once(self.gateway))
        chat.assert_not_called()

    def test_the_manual_probe_ignores_the_switch_and_the_floor(self):
        self.gateway.CONFIG["restricted_probe"] = False
        restricted_probe._state["acct"] = {"last_at": time.time(), "fails": 0}
        with patch.object(restricted_probe, "_one_chat", return_value=(200, None, "")) as chat:
            result = restricted_probe.probe_now(self.gateway, "acct")
        chat.assert_called_once()
        self.assertTrue(result["released"])
        self.assertEqual(restricted_probe.state_of("acct")["trigger"], "manual")

    def test_the_manual_probe_reports_an_unknown_account(self):
        self.assertEqual(restricted_probe.probe_now(self.gateway, "missing")["message"], "账号不存在")


class RequestShapeTests(ProbeFixture):
    def _capture(self, status=200):
        captured = {}

        @contextmanager
        def fake_stream(_client, url, headers, body, *, fallback_url=None):
            captured.update(url=url, headers=headers, body=body)
            response = Mock(status_code=status)
            response.iter_bytes.return_value = []
            raw = b'{"code":11140,"msg":"request illegal"}' if status != 200 else None
            yield response, raw

        self.gateway._dynamic_request_headers.return_value = {"X-Conversation-ID": "placeholder"}
        self.gateway._upstream_diagnostic.side_effect = converter._upstream_diagnostic
        with patch.object(restricted_probe, "open_backend_stream_sync", fake_stream), \
                patch("httpx.Client"):
            self.entry()["cm"].get_headers.return_value = {
                "Authorization": "Bearer t", "X-Domain": "www.workbuddy.cn", "X-User-Id": "acct",
                "X-IDE-Type": "WorkBuddy"}
            status_code, code, _message = restricted_probe._one_chat(self.gateway, self.entry(), "fast-model")
        return status_code, code, captured

    def test_the_probe_is_a_real_chat_turn_with_a_system_first_message(self):
        status, _code, captured = self._capture()
        self.assertEqual(status, 200)
        body = captured["body"]
        self.assertEqual(body["messages"][0]["role"], "system")
        self.assertEqual(body["messages"][1]["role"], "user")
        self.assertLessEqual(body["max_tokens"], 32, "the probe must not spend output tokens")
        self.assertTrue(captured["url"].endswith("/v2/chat/completions"))
        self.assertEqual(captured["headers"]["X-CodeBuddy-Request"], "1")
        self.assertEqual(captured["headers"]["X-Requested-With"], "XMLHttpRequest")
        self.assertTrue(captured["headers"]["X-Conversation-ID"].startswith(
            restricted_probe.PROBE_CONVERSATION_PREFIX))

    def test_a_free_rate_model_is_preferred_over_a_paid_one(self):
        _status, _code, captured = self._capture()
        self.assertEqual(captured["body"]["model"], "fast-model")

    def test_the_refusal_code_comes_from_the_shared_reader(self):
        status, code, _captured = self._capture(status=403)
        self.assertEqual(status, 403)
        self.assertEqual(code, "11140")


class ViewTests(ProbeFixture):
    def test_the_view_reports_the_schedule_and_the_last_outcome(self):
        with patch.object(restricted_probe, "_one_chat", return_value=(403, "11140", "request illegal")):
            restricted_probe.probe(self.gateway, self.entry())
        view = restricted_probe.view(self.gateway.CONFIG)
        self.assertTrue(view["enabled"])
        self.assertEqual((view["interval_s"], view["fail_threshold"], view["backoff_s"]), (21600.0, 3, 86400))
        self.assertEqual(view["accounts"][0]["account_key"], "acct")
        self.assertEqual(view["accounts"][0]["last_code"], "11140")


class ManagementSurfaceTests(unittest.TestCase):
    def test_the_management_surface_exposes_the_probe(self):
        # The manual path is independent of the switch, so it needs its own entry point.
        self.assertTrue(callable(converter.admin_probe_restricted_credential))
        self.assertTrue(callable(converter.admin_restricted_probes))
        source = (Path(__file__).resolve().parents[1] / "app" / "admin_api.py").read_text(encoding="utf-8")
        self.assertIn('@route("POST", "/admin/credentials/{id}/restricted-probe")', source)
        self.assertIn('@route("GET", "/admin/restricted-probes")', source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
