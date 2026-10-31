"""Control metadata tests: isolated temporary databases only."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from concurrent.futures import ThreadPoolExecutor
import json
import sqlite3
import tempfile
import unittest

from app.control_store import ConflictError, ControlStore
from app.settings import apply_persisted_settings, resolve_settings, validate_settings


class ControlStoreTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.path = self.root / "control.sqlite3"
        self.store = ControlStore(self.path)
        self.addCleanup(self.store.close)

    def test_reopen_and_schema(self):
        state = self.store.update_settings({"max_images": 3}, 0)
        self.assertEqual(state["revision"], 1)
        with sqlite3.connect(self.path) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], ControlStore.SCHEMA_VERSION)
        other = ControlStore(self.path)
        self.addCleanup(other.close)
        self.assertEqual(other.snapshot()["settings"], {"max_images": 3})

    def test_v2_database_upgrades_api_keys_schema(self):
        self.store.update_settings({"max_images": 3}, 0)
        self.store.close()
        with sqlite3.connect(self.path) as db:
            db.execute("DROP INDEX api_keys_single_admin")
            db.execute("DROP TABLE api_keys")
            db.execute("PRAGMA user_version=2")
        reopened = ControlStore(self.path)
        self.addCleanup(reopened.close)
        self.assertEqual(reopened.snapshot()["settings"], {"max_images": 3})
        with sqlite3.connect(self.path) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 3)
            self.assertIn("api_keys", {row[0] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")})
            self.assertTrue(db.execute(
                "SELECT 1 FROM pragma_index_list('api_keys') WHERE name='api_keys_single_admin' AND \"unique\"=1"
            ).fetchone())

    def test_corrupt_api_keys_schema_is_rejected_without_deleting_rows(self):
        from app.api_keys import KeyStore
        for mode in ("column", "index"):
            with self.subTest(mode=mode):
                path = self.root / f"corrupt-{mode}.sqlite3"
                store = ControlStore(path)
                KeyStore(store).create(name="preserved", kind="standard")
                store.close()
                with sqlite3.connect(path) as db:
                    if mode == "column":
                        db.execute("ALTER TABLE api_keys DROP COLUMN version")
                    else:
                        db.execute("DROP INDEX api_keys_single_admin")
                        db.execute("CREATE INDEX api_keys_single_admin ON api_keys(type)")
                with self.assertRaisesRegex(ValueError, "api_keys (表|索引)结构不匹配"):
                    ControlStore(path)
                with sqlite3.connect(path) as db:
                    self.assertEqual(db.execute("SELECT count(*) FROM api_keys").fetchone()[0], 1)

    def test_snapshot_is_detached(self):
        self.store.update_model("real", {"public_id": "public", "credential_ids": ["fingerprint"]}, 0)
        snapshot = self.store.snapshot()
        snapshot["models"]["real"]["credential_ids"].append("other")
        self.assertEqual(self.store.snapshot()["models"]["real"]["credential_ids"], ["fingerprint"])

    def test_atomic_revision_conflict(self):
        def update(value):
            try:
                self.store.update_settings({"max_images": value}, 0)
                return True
            except ConflictError:
                return False
        with ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(sum(pool.map(update, range(8))), 1)
        self.assertEqual(self.store.snapshot()["revision"], 1)

    def test_cross_connection_conflict(self):
        other = ControlStore(self.path)
        self.addCleanup(other.close)
        self.store.update_settings({"max_images": 2}, 0)
        with self.assertRaises(ConflictError):
            other.update_settings({"max_images": 5}, 0)

    def test_invalid_rules_never_commit(self):
        for rule in ({"region": "cn", "profile": "intl-work"}, {"enabled": 1}, {"credential_ids": "id"},
                     {"public_id": "other"}, {"accessToken": "not-allowed"}):
            with self.subTest(rule=rule), self.assertRaises(ValueError):
                self.store.update_model("real", rule, 0, known_models=["real", "other"])
        self.assertEqual(self.store.snapshot()["revision"], 0)

    def test_alias_collision_and_chains(self):
        self.store.update_model("real", {"public_id": "alias", "enabled": False}, 0)
        for source, rule in (("other", {"public_id": "alias"}), ("alias", {"public_id": "third"})):
            with self.assertRaises(ValueError):
                self.store.update_model(source, rule, 1)
        self.assertEqual(self.store.snapshot()["revision"], 1)

    def test_legacy_combined_scopes_load_without_widening_and_require_explicit_edit(self):
        from app import model_policy
        legacy = {"public_id": "legacy", "enabled": True, "keep_original": False,
                  "region": "cn", "profile": None, "credential_ids": ["cn-account", "intl-account"]}
        self.store._update(0, lambda state: state["models"].update({"real": legacy}))
        reopened = ControlStore(self.path)
        self.addCleanup(reopened.close)
        self.assertEqual(reopened.snapshot()["models"]["real"], legacy)
        config = {"control_store": reopened}
        self.assertTrue(model_policy.route_allowed(config, {"profile": "cn-cli", "account_key": "cn-account"}, "real"))
        self.assertFalse(model_policy.route_allowed(config, {"profile": "intl-cli", "account_key": "intl-account"}, "real"))
        with self.assertRaises(ValueError):
            reopened.update_model("real", legacy, 1)
        self.assertEqual(reopened.snapshot()["revision"], 1)


    def test_unbind_credential_removes_only_the_target_identity(self):
        self.store.update_model("real", {"public_id": "public", "credential_ids": ["fingerprint", "other"]}, 0)
        self.store.update_model("second", {"credential_ids": ["fingerprint"]}, 1)
        self.store.update_model("third", {"credential_ids": ["other"]}, 2)
        affected = self.store.unbind_credential("fingerprint")
        self.assertEqual(affected, {"real": ["fingerprint", "other"], "second": ["fingerprint"]})
        self.assertEqual(self.store.snapshot()["revision"], 4)  # Three setup bumps, then one for the unbind.
        self.assertEqual(self.store.snapshot()["models"]["real"]["credential_ids"], ["other"])
        self.assertEqual(self.store.snapshot()["models"]["second"]["credential_ids"], [])
        self.assertEqual(self.store.snapshot()["models"]["third"]["credential_ids"], ["other"])
        self.assertEqual(self.store.unbind_credential("unknown-identity"), {})  # No-op keeps the revision.
        self.assertEqual(self.store.snapshot()["revision"], 4)
        self.store.restore_bindings("fingerprint", affected)  # Rollback restores both rules in one bump.
        self.assertEqual(self.store.snapshot()["models"]["real"]["credential_ids"], ["fingerprint", "other"])
        self.assertEqual(self.store.snapshot()["models"]["second"]["credential_ids"], ["fingerprint"])
        self.assertEqual(self.store.snapshot()["revision"], 5)
        self.store.restore_bindings("fingerprint", affected)  # An already-restored state bumps nothing.
        self.assertEqual(self.store.snapshot()["revision"], 5)

    def test_rollback_keeps_concurrent_edits_and_deleted_rules(self):
        self.store.update_model("real", {"credential_ids": ["fingerprint", "other"]}, 0)
        self.store.update_model("gone", {"custom": True, "public_id": "gone-public", "credential_ids": ["fingerprint"]}, 1)
        affected = self.store.unbind_credential("fingerprint")
        revision = self.store.snapshot()["revision"]
        # Concurrent edits: one rule rebound elsewhere, another deleted outright.
        self.store.update_model("real", {"credential_ids": ["fresh"]}, revision)
        self.store.delete_model("gone", self.store.snapshot()["revision"])
        self.store.restore_bindings("fingerprint", affected)
        self.assertEqual(self.store.snapshot()["models"]["real"]["credential_ids"], ["fresh"])
        self.assertNotIn("gone", self.store.snapshot()["models"])
        with self.assertRaises(ValueError):
            self.store.unbind_credential("not a fingerprint")


    def test_credential_metadata_and_no_secret_settings(self):
        self.store.set_credential("account-fingerprint", False)
        self.assertEqual(self.store.snapshot()["credentials"], {"account-fingerprint": {"enabled": False}})
        for values in ({"api_key": "secret"}, {"auth_dir": "/private"}, {"accessToken": "secret"}, {"max_images": True}):
            with self.assertRaises(ValueError):
                self.store.update_settings(values, 1)
        with sqlite3.connect(self.path) as db:
            raw = db.execute("SELECT payload FROM control").fetchone()[0]
        self.assertNotIn("secret", raw)
        self.assertEqual(self.store.snapshot()["revision"], 1)

    # -- upstream restriction (403/11140) -------------------------------------

    def test_restriction_disables_the_account_and_never_restacks(self):
        self.assertTrue(self.store.set_restricted("fingerprint", reason="上游判定账号受限",
                                                  evidence="HTTP 403 code=11140", at=1000))
        record = self.store.snapshot()["credentials"]["fingerprint"]
        self.assertEqual(record["enabled"], False)          # 停权与 enabled 同一次写入
        self.assertTrue(record["restricted"])
        self.assertEqual(record["restricted_at"], 1000)
        revision = self.store.snapshot()["revision"]
        # 同一账号的第二个判定是同一份证据：不重复写库，也不覆盖第一条原因。
        self.assertFalse(self.store.set_restricted("fingerprint", reason="again", evidence="again"))
        self.assertEqual(self.store.snapshot()["revision"], revision)
        self.assertEqual(self.store.snapshot()["credentials"]["fingerprint"]["restricted_reason"],
                         "上游判定账号受限")

    def test_restriction_survives_a_reopen_and_releases_on_manual_reset(self):
        self.store.set_restricted("fingerprint", reason="上游判定账号受限", evidence="HTTP 403 code=11140")
        reopened = ControlStore(self.path)
        self.addCleanup(reopened.close)
        self.assertTrue(reopened.snapshot()["credentials"]["fingerprint"]["restricted"])
        self.assertTrue(reopened.clear_restricted("fingerprint"))
        self.assertEqual(reopened.snapshot()["credentials"]["fingerprint"],
                         {"enabled": True, "restricted": False})
        self.assertFalse(reopened.clear_restricted("fingerprint"))   # 幂等：不写库

    def test_enabling_a_restricted_account_releases_it(self):
        self.store.set_restricted("fingerprint", reason="上游判定账号受限", evidence="HTTP 403 code=11140")
        self.store.set_credential("fingerprint", True)
        self.assertEqual(self.store.snapshot()["credentials"]["fingerprint"],
                         {"enabled": True, "restricted": False})
        self.store.set_restricted("fingerprint", reason="上游判定账号受限")
        self.store.set_credential("fingerprint", False)
        self.assertTrue(self.store.snapshot()["credentials"]["fingerprint"]["restricted"])

    def test_malformed_restriction_fields_are_rejected_on_load(self):
        payload = {"settings": {}, "models": {}, "credentials": {
            "fingerprint": {"enabled": True, "restricted": True, "restricted_reason": 5}}}
        with sqlite3.connect(self.path) as db:
            db.execute("UPDATE control SET payload=?", (json.dumps(payload),))
        with self.assertRaises(ValueError):
            ControlStore(self.path)

    def test_legacy_daily_chats_table_gains_the_state_column(self):
        """生产库早于 state 列：升级后必须补列，否则「当日终态」无处记录。"""
        legacy = self.root / "legacy.sqlite3"
        db = sqlite3.connect(legacy)
        db.execute("CREATE TABLE control (id INTEGER PRIMARY KEY CHECK(id=1), "
                   "revision INTEGER NOT NULL, payload TEXT NOT NULL)")
        db.execute("INSERT INTO control VALUES (1,0,?)",
                   (json.dumps({"settings": {}, "models": {}, "credentials": {}}),))
        db.execute("CREATE TABLE daily_chats (account_key TEXT NOT NULL, day TEXT NOT NULL, "
                   "attempt_id TEXT NOT NULL, phase TEXT NOT NULL, conversation_id TEXT, "
                   "sandbox_status TEXT, usage_before REAL, usage_after REAL, acp_usage REAL, "
                   "reserved_at REAL NOT NULL, confirmed_at REAL, updated_at REAL NOT NULL, "
                   "PRIMARY KEY (account_key, day))")
        db.execute("INSERT INTO daily_chats VALUES('fingerprint','2026-10-01','attempt','cancelled',"
                   "NULL,NULL,NULL,NULL,NULL,1,NULL,1)")
        db.execute("PRAGMA user_version=2")
        db.commit()
        db.close()
        store = ControlStore(legacy)
        self.addCleanup(store.close)
        record = store.daily_chat_record("fingerprint", "2026-10-01")
        self.assertEqual(record["phase"], "cancelled")
        self.assertIsNone(record["state"])
        self.assertFalse(store.daily_chat_settled("fingerprint", "2026-10-01"))
        store.daily_chat_checkpoint("fingerprint", "2026-10-01", state="restricted")
        self.assertTrue(store.daily_chat_settled("fingerprint", "2026-10-01"))

    def test_corrupt_and_unknown_database_are_not_reinitialized(self):
        bad = self.root / "bad.sqlite3"
        bad.write_bytes(b"not sqlite")
        with self.assertRaises(sqlite3.DatabaseError):
            ControlStore(bad)
        empty = self.root / "empty.sqlite3"
        empty.touch()
        with self.assertRaises(ValueError):
            ControlStore(empty)
        unknown = self.root / "unknown.sqlite3"
        with sqlite3.connect(unknown) as db:
            db.execute("PRAGMA user_version=999")
        with self.assertRaises(ValueError):
            ControlStore(unknown)
        with sqlite3.connect(unknown) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 999)

    def test_setting_precedence_and_source_redaction(self):
        self.store.update_settings({"max_images": 3, "image_policy": "error", "port": 9000}, 0)
        config = {"control_store": self.store, "max_images": 7, "api_key": "synthetic-secret", "auth_dir": "/private"}
        apply_persisted_settings(config, explicit=["max_images"], environ={"CODEBUDDY2API_IMAGE_POLICY": "truncate"})
        self.assertEqual((config["max_images"], config["image_policy"], config["port"]), (7, "truncate", 9000))
        items = {item["key"]: item for item in resolve_settings(config)}
        self.assertEqual(items["max_images"]["source"], "cli")
        self.assertTrue(items["max_images"]["locked"])
        self.assertEqual(items["image_policy"]["source"], "environment")
        self.assertIsNone(items["api_key"]["value"])
        self.assertIsNone(items["auth_dir"]["value"])
        for invalid in ({"usd_rate": float("nan")}, {"port": 65536},
                        {"audit_diagnostic_bytes": 4 * 1024 * 1024 + 1}):
            with self.assertRaises(ValueError):
                validate_settings(invalid)

    def test_hot_boolean_persistence_precedence_and_locking(self):
        key = "account_pause"
        env_key = "CODEBUDDY2API_ACCOUNT_PAUSE"
        defaults = {"control_store": self.store}
        apply_persisted_settings(defaults, environ={})
        self.assertIs(defaults[key], True)
        initial = next(item for item in resolve_settings(defaults) if item["key"] == key)
        self.assertFalse(initial["locked"])
        self.assertEqual(initial["mode"], "hot")
        self.store.update_settings({key: False}, 0)
        reopened = ControlStore(self.path)
        self.addCleanup(reopened.close)
        for env, explicit, expected, source in (
            ({}, (), False, "management"),
            ({env_key: "true"}, (), True, "environment"),
            ({env_key: "false"}, (key,), True, "cli"),
        ):
            with self.subTest(env=env, explicit=explicit):
                config = {"control_store": reopened, key: True}
                apply_persisted_settings(config, explicit=explicit, environ=env)
                self.assertIs(config[key], expected)
                item = next(item for item in resolve_settings(config) if item["key"] == key)
                self.assertEqual(item["source"], source)
                self.assertEqual(item["locked"], source != "management")
                self.assertIs(item["stored"], False)
        for invalid in ("true", 1, None):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                validate_settings({key: invalid})


if __name__ == "__main__":
    unittest.main()
