#!/usr/bin/env python3
"""Regression: the two bounded ledgers must stay inside MAX_BYTES and stay readable.

Both ledgers advertise a byte bound and their reader refuses any file over it. A writer
without shedding therefore does not merely overflow: it writes a file the reader discards,
so *every* row is lost on the next start — paused accounts return to selection and the cost
judgements behind the credit floor are wiped. These tests hold the writer to the bound its
reader enforces, and to telling the caller when a row had to be given up.
"""

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # Allow direct execution.

from app import credential_cooldowns, credit_floor, state_store
from app.control_store import ControlStore
from app.credit_floor import MAX_ACCOUNTS as COST_ACCOUNTS
from app.credit_floor import MAX_BYTES as COST_BYTES
from app.credit_floor import MAX_MODELS as COST_MODELS
from app.credit_floor import CostLedger
from app.credential_cooldowns import MAX_BYTES as PAUSE_BYTES
from app.credential_cooldowns import AccountPauses, CredentialCooldowns
from app.state_store import StateStore

NOW = 1_800_000_000.0
# A realistic operator-facing reason at the writer's own 128-character cap. Chinese text costs
# 3 bytes per character in UTF-8, so a byte bound sized by "number of rows" alone is exactly
# what overflows in production: 256 rows x (64 hex + 384 B reason) is ~110 KB against 64 KiB.
REASON = ("上游返回 401 凭据失效，已暂停选号等待人工复核，恢复后由运维手工 resume。" * 6)[:128]


def pause_rows(count):
    return {f"{index:064x}": {"at": NOW + index, "reason": REASON}
            for index in range(count)}


def cost_rows(count, models):
    return {f"{index:064x}": {f"model-name-{model:03d}": {"cost_per_1k": 1.5, "samples": 1,
                                                         "last_seen": NOW}
                              for model in range(models)}
            for index in range(count)}


class PauseLedgerBoundTests(unittest.TestCase):
    """AccountPauses: 256 rows must land inside 64 KiB and still read back."""

    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.path = self.root / "account-pauses.json"

    def fill(self, ledger, count):
        with ledger._lock:
            ledger._data = pause_rows(count)

    def test_a_full_table_lands_inside_the_bound_and_still_reads_back(self):
        """The pre-fix writer produced 110,104 B against a 65,536 B reader: 0 rows restored."""
        ledger = AccountPauses(self.path)
        self.fill(ledger, ledger.MAX_ACCOUNTS)
        self.assertFalse(ledger._save_locked())          # Rows had to be shed.
        self.assertLessEqual(self.path.stat().st_size, PAUSE_BYTES)
        self.assertEqual(ledger.last_error, "capacity")
        restored = AccountPauses(self.path)
        self.assertGreater(len(restored.detail()), 0)    # Not the whole table.
        self.assertGreater(ledger.shed_total, 0)

    def test_shedding_keeps_the_most_recent_pauses(self):
        """The oldest pause is the one an operator is most likely to resume next anyway."""
        ledger = AccountPauses(self.path)
        self.fill(ledger, ledger.MAX_ACCOUNTS)
        ledger._save_locked()
        restored = {row["identity"] for row in AccountPauses(self.path).detail()}
        self.assertIn(f"{ledger.MAX_ACCOUNTS - 1:064x}", restored)   # Newest survived.
        self.assertNotIn(f"{0:064x}", restored)                      # Oldest was shed.

    def test_a_pause_that_was_shed_is_not_reported_as_durable(self):
        """A caller told "durable" would never learn the account returns after a restart."""
        ledger = AccountPauses(self.path)
        self.fill(ledger, ledger.MAX_ACCOUNTS)
        outcome = ledger.pause("f" * 64, reason=REASON, now=NOW)
        self.assertTrue(outcome["changed"])
        self.assertFalse(outcome["durable"])
        self.assertEqual(ledger.last_error, "capacity")

    def test_a_table_inside_the_bound_is_unchanged_and_fully_durable(self):
        ledger = AccountPauses(self.path)
        outcome = ledger.pause("a" * 64, reason="short", now=NOW)
        self.assertEqual(outcome, {"changed": True, "durable": True})
        self.assertIsNone(ledger.last_error)
        self.assertEqual(ledger.shed_total, 0)
        self.assertEqual(AccountPauses(self.path).detail(),
                         [{"identity": "a" * 64, "at": NOW, "reason": "short"}])

    def test_storage_reports_the_rows_it_gave_up(self):
        ledger = AccountPauses(self.path)
        self.fill(ledger, ledger.MAX_ACCOUNTS)
        ledger._save_locked()
        view = ledger.storage()
        self.assertTrue(view["degraded"])
        self.assertEqual(view["last_error"], "capacity")
        self.assertGreater(view["shed_rows"], 0)


class CostLedgerBoundTests(unittest.TestCase):
    """CostLedger: 256x64 observations must land inside 256 KiB and still read back."""

    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.path = self.root / "credit-floor.json"

    def fill(self, ledger, accounts, models):
        with ledger._lock:
            ledger._data = cost_rows(accounts, models)

    def test_a_full_ledger_lands_inside_the_bound_and_still_reads_back(self):
        """The pre-fix writer produced 1,328,410 B against a 262,144 B reader: 0 rows."""
        ledger = CostLedger(self.path, ttl=21600)
        self.fill(ledger, COST_ACCOUNTS, COST_MODELS)
        self.assertFalse(ledger._save_locked())
        self.assertLessEqual(self.path.stat().st_size, COST_BYTES)
        self.assertEqual(ledger.last_error, "capacity")
        restored = CostLedger(self.path, ttl=21600)
        self.assertGreater(len(restored.detail(now=NOW)), 0)
        self.assertGreater(ledger.shed_total, 0)

    def test_shedding_keeps_the_freshest_observations(self):
        """Stalest account first: it is the one the TTL would drop on its own."""
        ledger = CostLedger(self.path, ttl=21600)
        with ledger._lock:
            ledger._data = cost_rows(COST_ACCOUNTS, COST_MODELS)
            ledger._data["f" * 64] = {"fresh-model": {"cost_per_1k": 9.0, "samples": 1,
                                                      "last_seen": NOW + 10_000}}
        ledger._save_locked()
        restored = CostLedger(self.path, ttl=21600)
        self.assertIsNotNone(restored.cost_of("f" * 64, "fresh-model", now=NOW + 10_000))
        self.assertIsNone(restored.cost_of(f"{0:064x}", "model-name-000", now=NOW))

    def test_an_observation_that_was_shed_is_not_reported_as_durable(self):
        ledger = CostLedger(self.path, ttl=21600)
        self.fill(ledger, COST_ACCOUNTS, COST_MODELS)
        self.assertFalse(ledger.note("f" * 64, "new-model", 2.0, 1000, now=NOW))
        self.assertEqual(ledger.last_error, "capacity")

    def test_a_ledger_inside_the_bound_is_unchanged_and_fully_durable(self):
        ledger = CostLedger(self.path, ttl=21600)
        self.assertTrue(ledger.note("a" * 64, "m", 2.0, 1000, now=NOW))
        self.assertIsNone(ledger.last_error)
        self.assertEqual(ledger.shed_total, 0)
        self.assertAlmostEqual(CostLedger(self.path, ttl=21600).cost_of("a" * 64, "m", now=NOW),
                               2.0, delta=0.001)

    def test_an_unencodable_table_is_not_written_at_all(self):
        """Better to keep the last good file than to replace it with one the reader rejects."""
        ledger = CostLedger(self.path, ttl=21600)
        ledger.note("a" * 64, "m", 2.0, 1000, now=NOW)
        with ledger._lock:
            ledger._data["b" * 64] = {"m": {"cost_per_1k": float("nan"), "samples": 1,
                                            "last_seen": NOW}}
            self.assertFalse(ledger._save_locked())
        self.assertEqual(ledger.last_error, "serialize")
        self.assertAlmostEqual(CostLedger(self.path, ttl=21600).cost_of("a" * 64, "m", now=NOW),
                               2.0, delta=0.001)


class SharedSheddingHelperTests(unittest.TestCase):
    """The three ledgers must share one implementation, not three copies that drift."""

    def test_all_three_bounded_ledgers_use_the_shared_helper(self):
        for module in (credential_cooldowns, credit_floor, __import__("app.usage_snapshots", fromlist=["x"])):
            self.assertIs(module.serialize_bounded, state_store.serialize_bounded)

    def test_the_helper_counts_shed_rows_and_stays_inside_the_limit(self):
        document = {"version": 1, "accounts": pause_rows(64)}
        content, shed = state_store.serialize_bounded(
            document, 4096, rows_field="accounts",
            urgency=lambda key, row: row["at"])
        self.assertLessEqual(len(content), 4096)
        self.assertGreater(shed, 0)
        self.assertEqual(len(json.loads(content)["accounts"]), 64 - shed)

    def test_the_helper_returns_no_payload_when_it_cannot_fit(self):
        """Writing an over-limit document would only hand the reader something it discards."""
        document = {"version": 1, "accounts": pause_rows(8)}
        content, shed = state_store.serialize_bounded(
            document, 16, rows_field="accounts", urgency=lambda key, row: row["at"])
        self.assertIsNone(content)
        self.assertEqual(shed, 8)

    def test_the_helper_leaves_the_caller_table_untouched(self):
        rows = pause_rows(8)
        state_store.serialize_bounded({"version": 1, "accounts": rows}, 128,
                                      rows_field="accounts", urgency=lambda key, row: row["at"])
        self.assertEqual(len(rows), 8)


class CoalescedWriteTests(unittest.TestCase):
    """C-2: a staged burst must cost one durable commit and lose nothing on failure."""

    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.control = ControlStore(self.root / "control.sqlite3")
        self.addCleanup(self.control.close)
        self.state = StateStore(self.control)
        self.now = time.time()

    def durable_models(self):
        """The model rows actually committed to SQLite, bypassing any staged view."""
        row = self.control._db.execute(
            "SELECT payload FROM runtime_state WHERE name='cooldowns'").fetchone()
        return (json.loads(row[0])["accounts"].get("a" * 64) or {}).get("models", {}) if row else {}

    def document(self, count=4):
        return {"version": 1, "accounts": {
            f"{index:064x}": {"profile": "cn-work", "fail_until": self.now + 300, "reason": "",
                              "failed_at": self.now, "models": {}}
            for index in range(count)}}

    def test_a_staged_document_is_durable_only_after_flush(self):
        self.assertTrue(self.state.stage("cooldowns", self.document()))
        self.assertTrue(self.state.pending())
        self.assertEqual(self.control._db.execute(
            "SELECT count(*) FROM runtime_state").fetchone()[0], 0)
        self.assertTrue(self.state.flush())
        self.assertFalse(self.state.pending())
        self.assertIsNotNone(self.state.get("cooldowns"))

    def test_staged_writes_are_visible_before_they_are_durable(self):
        self.state.stage("cooldowns", self.document())
        self.assertEqual(len(self.state.get("cooldowns")["accounts"]), 4)

    def test_a_burst_of_updates_costs_one_commit(self):
        commits = []
        original = StateStore.transaction

        def counted(store):
            commits.append(1)
            return original(store)

        with patch.object(StateStore, "transaction", counted):
            for _ in range(10):
                self.state.stage("cooldowns", self.document())
            self.assertEqual(commits, [])          # Staging never opens a transaction.
            self.state.flush()
        self.assertEqual(len(commits), 1)          # The whole burst, one durable commit.

    def test_a_failed_flush_keeps_the_staged_write_for_a_retry(self):
        self.state.stage("cooldowns", self.document())
        with patch.object(self.state, "_db") as db:
            db.execute.side_effect = __import__("sqlite3").OperationalError("fixture")
            self.assertFalse(self.state.flush())
        self.assertTrue(self.state.pending())      # Not lost.
        self.assertTrue(self.state.flush())        # The retry lands.
        self.assertIsNotNone(self.state.get("cooldowns"))

    def test_stage_is_o1_and_flush_applies_the_put_rules(self):
        """stage() must not re-encode the document; that O(document) cost is the whole point.

        Validation and the size bound still hold, they just move to the one place that already
        touches the whole document. A document that can never become valid is dropped instead
        of being retried forever, and the failure is reported.
        """
        self.assertTrue(self.state.stage("cooldowns", {"version": 1, "accounts": {"bad": {}}}))
        self.assertFalse(self.state.flush())        # Rejected by the same rules put() applies.
        self.assertFalse(self.state.pending())      # Dropped, not retried forever.
        self.assertIsNone(self.state.get("cooldowns"))
        with self.assertRaises(ValueError):
            self.state.stage("nope", self.document())

    def test_flush_without_a_stage_is_a_no_op(self):
        self.assertTrue(self.state.flush())
        self.assertFalse(self.state.pending())

    def test_a_staged_document_does_not_survive_a_delete(self):
        self.state.stage("cooldowns", self.document())
        self.state.delete("cooldowns")
        self.assertFalse(self.state.pending())
        self.assertIsNone(self.state.get("cooldowns"))

    def test_the_cooldown_table_stages_only_when_asked(self):
        """Default False keeps every existing caller byte-for-byte identical."""
        cooldowns = CredentialCooldowns(store=self.state)
        self.assertTrue(cooldowns.note_credential("a" * 64, "cn-work", self.now + 300))
        self.assertFalse(cooldowns.pending())      # The default path commits immediately.
        self.assertTrue(CredentialCooldowns(store=self.state).credential_until("a" * 64, "cn-work")
                        > self.now)
        self.assertTrue(cooldowns.note_model("a" * 64, "cn-work", "m", self.now + 600, stage=True))
        self.assertTrue(cooldowns.pending())
        # Staged, not durable: the model row is absent from the committed table.
        self.assertNotIn("m", self.durable_models())
        self.assertTrue(cooldowns.flush())
        self.assertIn("m", self.durable_models())
        self.assertFalse(cooldowns.pending())
        self.assertGreater(CredentialCooldowns(store=self.state).model_until("a" * 64, "cn-work", "m"),
                           self.now)

    def test_a_staged_cooldown_is_visible_to_selection_before_it_is_durable(self):
        cooldowns = CredentialCooldowns(store=self.state)
        cooldowns.note_model("a" * 64, "cn-work", "m", self.now + 600, stage=True)
        self.assertGreater(cooldowns.model_until("a" * 64, "cn-work", "m"), self.now)
        # A reader built over the same store sees the staged row too.
        self.assertGreater(CredentialCooldowns(store=self.state).model_until("a" * 64, "cn-work", "m"),
                           self.now)

    def test_a_failed_flush_is_reported_and_the_cooldown_still_holds_in_memory(self):
        cooldowns = CredentialCooldowns(store=self.state)
        cooldowns.note_model("a" * 64, "cn-work", "m", self.now + 600, stage=True)
        with patch.object(self.state, "flush", return_value=False):
            self.assertFalse(cooldowns.flush())
        self.assertEqual(cooldowns.last_error, "store")
        self.assertGreater(cooldowns.model_until("a" * 64, "cn-work", "m"), self.now)


if __name__ == "__main__":
    unittest.main()
