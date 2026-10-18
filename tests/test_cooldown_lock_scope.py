#!/usr/bin/env python3
"""Regression tests for moving cooldown persistence out of the pool lock (P1-1).

Two defects are pinned here, each reproduced before it was fixed:

* A 429 cooldown recorded its deadline with a durable SQLite commit (BEGIN IMMEDIATE +
  synchronous=FULL) while still holding CredentialPool._lock, and the surrounding _log()
  added an audit row under the same lock. During a 429 storm every selection therefore
  serialized behind 1-2ms of storage work. The in-memory verdict must still apply inside
  the lock -- selection reads it there -- but the commit has to happen after the lock is
  released.
* The write must not be lost or silently dropped on the way out. A failed commit keeps the
  staged document for the next flush and leaves the in-memory cooldown in force, so a
  storage outage costs durability, never routing. A burst of cooldowns must not lose any
  of its writes to coalescing either.
"""

import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # Allow direct execution.

import converter
from app.control_store import ControlStore
from app.state_store import StateStore

MODEL = "deepseek-v4-pro"
OTHER_MODEL = "glm-5.3-flash"


class LockScopeFixture(unittest.TestCase):
    """A pool backed by the real SQLite state store, with the lock guarded by a spy."""

    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.dict(os.environ, {"CODEBUDDY_AUTH_DIR": str(self.root)}))
        self.enterContext(patch.dict(converter.CONFIG, {
            "log_path": None, "cred_pool": None, "cred": None, "ledger": None,
            "model_catalogs": {}, "account_catalogs": None, "model_cache": None,
            "control_store": None}))
        self.control = self.enterContext(_closing(ControlStore(self.root / "control.sqlite3")))
        self.state = StateStore(self.control)
        self.logs = []
        self.enterContext(patch.object(converter, "_log", side_effect=self.logs.append))
        self.pool = self.build()

    def build(self, count=2):
        now = time.time()
        paths = []
        for index in range(count):
            path = self.root / f"acct-{index:03d}.info"
            path.write_text(json.dumps({
                "account": {"uid": f"synthetic-uid-{index:03d}"},
                "auth": {"accessToken": "synthetic-token", "refreshToken": "synthetic-refresh",
                         "domain": "www.codebuddy.cn", "expiresAt": (now + 86400) * 1000,
                         "lastRefreshTime": now * 1000}}), encoding="utf-8")
            paths.append(path)
        pool = converter.CredentialPool(paths, blocks_path=self.root / "blocks.json",
                                        cooldowns_path=self.root / "cooldowns.json",
                                        state_store=self.state)
        converter.CONFIG["cred_pool"] = pool
        return pool

    def held(self):
        """Whether the calling thread currently holds the pool lock."""
        # RLock has no public holder accessor; ownership of the private fields is stable
        # across the CPython versions this project supports, and the test only needs a
        # best-effort observation, never a lock-ordering decision.
        lock = self.pool._lock
        owner = getattr(lock, "_owner", None)
        return owner is not None and owner == threading.get_ident()


class LockScopeTests(LockScopeFixture):
    """Storage work must happen outside the pool lock; the memory update stays inside."""

    def test_a_model_cooldown_commits_outside_the_pool_lock(self):
        """The SQLite commit must not run while pool._lock is held."""
        observations = []
        original = self.state.flush

        def observing_flush():
            observations.append(self.held())
            return original()

        cm = self.pool._entries[0]["cm"]
        with patch.object(self.state, "flush", side_effect=observing_flush):
            self.pool.note_status(cm, 429, model=MODEL, raw=b"rate limited")
        self.assertEqual(observations, [False],
                         "the cooldown commit must happen after the pool lock is released")

    def test_an_auth_cooldown_commits_outside_the_pool_lock(self):
        """The circuit-breaker path must not hold the lock across its commit either."""
        observations = []
        original = self.state.flush

        def observing_flush():
            observations.append(self.held())
            return original()

        cm = self.pool._entries[0]["cm"]
        with patch.object(self.state, "flush", side_effect=observing_flush):
            self.pool.cooldown(cm, reason="backend HTTP 401")
        self.assertEqual(observations, [False])

    def test_the_cooldown_is_visible_to_selection_before_the_commit(self):
        """Selection reads memory, so the verdict must be in force the moment the lock drops."""
        cm = self.pool._entries[0]["cm"]
        entry = next(e for e in self.pool.entries() if e["cm"] is cm)
        seen = {}
        original = self.state.flush

        def observing_flush():
            # A request arriving between the memory update and the commit must already see
            # the cooldown; otherwise it would be routed back to the cooling account.
            seen["model_healthy"] = self.pool._model_healthy(entry, MODEL)
            seen["memory_deadline"] = self.pool._model_fail.get((entry["id"], MODEL), 0.0)
            return original()

        with patch.object(self.state, "flush", side_effect=observing_flush):
            self.pool.note_status(cm, 429, model=MODEL, raw=b"rate limited")
        self.assertFalse(seen["model_healthy"], "冷却必须在提交前就已生效")
        self.assertGreater(seen["memory_deadline"], time.time() - 1)

    def test_a_burst_of_cooldowns_still_lands_on_disk(self):
        """Coalescing must not drop writes: every recorded cooldown survives a reopen."""
        pool = self.build(count=3)
        for index, entry in enumerate(pool.entries()):
            pool.note_status(entry["cm"], 429, model=f"{MODEL}-{index}", raw=b"rate limited")
        reopened = converter.CredentialPool(
            [Path(entry["id"]) for entry in pool.entries()],
            blocks_path=self.root / "blocks.json",
            cooldowns_path=self.root / "cooldowns.json", state_store=self.state)
        for index, entry in enumerate(reopened.entries()):
            self.assertFalse(reopened._model_healthy(entry, f"{MODEL}-{index}"),
                             f"第 {index} 条模型冷却必须已落盘")

    def test_a_failed_commit_keeps_the_cooldown_in_memory(self):
        """A storage outage degrades durability, never routing."""
        cm = self.pool._entries[0]["cm"]
        entry = next(e for e in self.pool.entries() if e["cm"] is cm)
        with patch.object(self.state, "flush", return_value=False):
            self.pool.note_status(cm, 429, model=MODEL, raw=b"rate limited")
        self.assertFalse(self.pool._model_healthy(entry, MODEL),
                         "落盘失败时冷却仍必须生效于内存态")

    def test_a_failed_commit_is_reported_and_retried(self):
        """A refused write is warned about, and the next flush makes it durable."""
        cm = self.pool._entries[0]["cm"]
        entry = next(e for e in self.pool.entries() if e["cm"] is cm)
        with patch.object(self.state, "flush", return_value=False):
            self.pool.note_status(cm, 429, model=MODEL, raw=b"rate limited")
        self.assertTrue(any("持久化失败" in line for line in self.logs),
                        f"落盘失败必须报警: {self.logs}")
        # The staged document survived, so a later flush persists it without a new event.
        self.assertTrue(self.pool._cooldowns.flush())
        reopened = converter.CredentialPool(
            [Path(entry["id"])], blocks_path=self.root / "blocks.json",
            cooldowns_path=self.root / "cooldowns.json", state_store=self.state)
        self.assertFalse(reopened._model_healthy(reopened._entries[0], MODEL),
                         "重试的 flush 必须补上此前失败的写入")

    def test_a_failed_commit_on_the_breaker_path_is_also_retried(self):
        cm = self.pool._entries[0]["cm"]
        entry = next(e for e in self.pool._entries if e["cm"] is cm)   # The live dict, not a copy.
        with patch.object(self.state, "flush", return_value=False):
            self.pool.cooldown(cm, reason="backend HTTP 401")
        self.assertGreater(entry["fail_until"], time.time(), "熔断必须在内存态生效")
        self.assertTrue(self.pool._cooldowns.flush())
        reopened = converter.CredentialPool(
            [Path(entry["id"])], blocks_path=self.root / "blocks.json",
            cooldowns_path=self.root / "cooldowns.json", state_store=self.state)
        self.assertGreater(reopened._entries[0]["fail_until"], time.time(),
                           "重试的 flush 必须补上熔断的落盘")

    def test_concurrent_cooldowns_do_not_lose_writes(self):
        """Two threads recording different models must both be durable afterwards."""
        pool = self.build(count=1)
        entry = pool.entries()[0]
        errors = []

        def record(model):
            try:
                for _ in range(5):
                    pool.note_status(entry["cm"], 429, model=model, raw=b"rate limited")
            except Exception as error:      # noqa: BLE001 - surface any thread failure
                errors.append(error)

        threads = [threading.Thread(target=record, args=(model,))
                   for model in (f"{MODEL}-a", f"{MODEL}-b", f"{MODEL}-c")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        self.assertTrue(pool._cooldowns.flush())
        reopened = converter.CredentialPool(
            [Path(entry["id"])], blocks_path=self.root / "blocks.json",
            cooldowns_path=self.root / "cooldowns.json", state_store=self.state)
        for model in (f"{MODEL}-a", f"{MODEL}-b", f"{MODEL}-c"):
            self.assertFalse(reopened._model_healthy(reopened._entries[0], model),
                             f"{model} 的并发写入丢失了")

    def test_an_unkeyed_identity_does_not_trigger_a_flush(self):
        """An account without a complete identity owns no row, so there is nothing to commit."""
        entry = self.pool._entries[0]
        entry["uid"] = None            # Make _durable_identity() false.
        calls = []
        with patch.object(self.pool, "_flush_cooldowns",
                          side_effect=lambda: calls.append(1) or True):
            self.pool.note_status(entry["cm"], 429, model=MODEL, raw=b"rate limited")
        self.assertEqual(calls, [], "无持久身份的账号不应产生落盘动作")
        self.assertFalse(self.pool._model_healthy(entry, MODEL), "内存态冷却仍然生效")


class FileBackedStoreTests(LockScopeFixture):
    """Without a state store the table writes a file per event; that path must keep working."""

    def test_a_file_backed_cooldown_is_still_durable_immediately(self):
        pool = converter.CredentialPool(
            [Path(entry["id"]) for entry in self.pool.entries()],
            blocks_path=self.root / "file-blocks.json",
            cooldowns_path=self.root / "file-cooldowns.json")
        entry = pool._entries[0]
        pool.note_status(entry["cm"], 429, model=MODEL, raw=b"rate limited")
        document = json.loads((self.root / "file-cooldowns.json").read_text(encoding="utf-8"))
        self.assertTrue(document["accounts"], "文件后端必须在事件内直接落盘")


def _closing(store):
    """Close a control store when its test scope ends."""
    class _Scope:
        def __enter__(self):
            return store

        def __exit__(self, *exc):
            store.close()
            return False
    return _Scope()


if __name__ == "__main__":
    unittest.main(verbosity=2)
