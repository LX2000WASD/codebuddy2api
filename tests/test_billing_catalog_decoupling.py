#!/usr/bin/env python3
"""A billing failure must not stop the account's model catalog from syncing.

The defect this pins down (upstream PR #69, f9aa58b "Decouple billing failures from catalog
sync"): _sync_credits fetched the balance last and let its exception escape to the outer
handler, which returned None. The caller only puts an account into `refs` when the result is
not None, and _sync_model_catalogs refreshes only what is in `refs`. So one flapping billing
endpoint — or an enterprise tenant whose id cannot be resolved — silently stopped the catalog
from ever refreshing: newly published models could never be routed, and /admin/status showed
a credits failure with no hint that the catalog had stalled too.

Three properties are load-bearing:

* a non-auth billing error keeps the account in the sync set (catalog still refreshes) and
  is recorded in `failed` so it is retried;
* an expired login still propagates — that is an account-level verdict, not a hiccup, and
  swallowing it would keep syncing a credential that cannot authenticate;
* a successful lookup behaves exactly as before (balance updated, log written).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # Allow direct execution.

import time
import unittest
from unittest.mock import patch

import converter
from app.credits import AuthExpiredError
from tests import test_region_routing as fixtures

BALANCE = {"credits": 42.5, "intl": False, "segments": [], "soonest_expiry": None}


class BillingCatalogDecouplingTests(unittest.TestCase):
    """Drive _sync_credits directly and assert what the housekeeper would do with its result."""

    add_account = fixtures.RegionRoutingTests.add_account
    configure = fixtures.RegionRoutingTests.configure
    handle_upstream = fixtures.RegionRoutingTests.handle_upstream
    payload = fixtures.RegionRoutingTests.payload
    post_ok = fixtures.RegionRoutingTests.post_ok
    post_rejected = fixtures.RegionRoutingTests.post_rejected

    def entry(self):
        return self.entries["cn-cli"]

    def sync(self, **kwargs):
        """Run one credit sync and return (result, failed-set)."""
        failed = set()
        result = converter._sync_credits(self.pool, self.ledger, self.entry(),
                                         checkin=False, failed=failed, **kwargs)
        return result, failed

    def setUp(self):
        fixtures.RegionRoutingTests.setUp(self)
        self.enterContext(patch.object(converter, "_log"))

    # -- (a) a billing failure must not skip the catalog --------------------

    def test_a_billing_failure_still_returns_the_lease_for_catalog_sync(self):
        """The account must stay in refs, or _sync_model_catalogs never touches it."""
        with patch.object(converter.credits_mod, "fetch_credits",
                          side_effect=ValueError("synthetic billing outage")):
            result, failed = self.sync()
        self.assertIsNotNone(result, "积分失败不得让目录同步被跳过")
        entry, generation, headers, profile = result
        self.assertIs(entry, self.entry())
        self.assertEqual(profile, "cn-cli")
        self.assertTrue(headers, "必须返回可用 headers 供目录请求使用")
        self.assertIn(self.entry()["id"], failed, "失败必须记录以便重试")

    def test_a_billing_failure_keeps_the_previous_balance(self):
        """A failed lookup must not blank or overwrite the last known balance."""
        before = self.ledger.entry(self.entry()["id"])["credits"]
        with patch.object(converter.credits_mod, "fetch_credits",
                          side_effect=ValueError("synthetic billing outage")):
            self.sync()
        self.assertEqual(self.ledger.entry(self.entry()["id"])["credits"], before)

    def test_a_billing_failure_records_a_credits_sync_error(self):
        """The failure stays visible in diagnostics as a credits error."""
        with patch.object(converter.credits_mod, "fetch_credits",
                          side_effect=ValueError("synthetic billing outage")):
            self.sync()
        error = (self.ledger.entry(self.entry()["id"]).get("error") or "")
        self.assertIn("credits", error, f"必须记录 credits 阶段失败：{error!r}")

    def test_the_housekeeper_reaches_the_catalog_step_after_a_billing_failure(self):
        """End to end: a billing outage must not stop _sync_model_catalogs for that account."""
        self.configure(profiles=("cn-cli",))
        self.entry = self.entries["cn-cli"]
        self.entry_id = self.entry["id"]
        self.pool._sync_pending.add(self.entry_id)
        with patch.object(converter.credits_mod, "fetch_credits",
                          side_effect=ValueError("synthetic billing outage")), \
             patch.object(converter, "_sync_model_catalogs") as catalogs:
            converter._housekeep_once(self.pool, self.ledger, pending_only=True)
        self.assertEqual(catalogs.call_count, 1, "目录同步必须仍被调用")
        refs = catalogs.call_args.args[2]
        self.assertIn(self.entry_id, refs, "积分失败的账号仍必须进入 refs")

    # -- (b) an expired login still propagates ------------------------------

    def test_an_expired_login_still_skips_the_catalog(self):
        """Authentication expiry is an account-level verdict, not a billing hiccup.

        It must stay on the old path: the account leaves the sync set entirely (no catalog
        refresh on a credential that cannot authenticate), which is the behaviour the
        pre-fix code had for *every* credits error. The decoupling above must not accidentally
        promote an expired login into the "keep syncing" bucket.
        """
        with patch.object(converter.credits_mod, "fetch_credits",
                          side_effect=AuthExpiredError("synthetic expiry")):
            result, failed = self.sync()
        self.assertIsNone(result, "登录过期必须仍走跳过路径，不得进入目录同步")
        self.assertIn(self.entry()["id"], failed)

    def test_an_expired_login_still_marks_the_account_failed(self):
        """The outer handler records it, so the retry/backoff path is unchanged."""
        failed = set()
        with patch.object(converter.credits_mod, "fetch_credits",
                          side_effect=AuthExpiredError("synthetic expiry")):
            try:
                converter._sync_credits(self.pool, self.ledger, self.entry(),
                                        checkin=False, failed=failed)
            except AuthExpiredError:
                pass
        self.assertIn(self.entry()["id"], failed)

    # -- (c) success is unchanged ------------------------------------------

    def test_a_successful_lookup_still_updates_the_balance(self):
        with patch.object(converter.credits_mod, "fetch_credits", return_value=dict(BALANCE)), \
             patch.object(converter, "_log") as log:
            result, failed = self.sync()
        self.assertIsNotNone(result)
        self.assertNotIn(self.entry()["id"], failed)
        self.assertEqual(self.ledger.entry(self.entry()["id"])["credits"]["credits"], 42.5)
        self.assertTrue(any("[credits]" in str(call.args[0]) for call in log.call_args_list
                            if call.args), "成功路径必须照旧打日志")

    def test_a_billing_failure_does_not_rewrite_the_balance(self):
        """Decoupling must not turn "balance unknown" into "balance is free".

        Keeping the account in the sync set is about the catalog, not about eligibility. The
        ledger row is what _eligible reads, so a failed lookup must leave it byte-for-byte
        unchanged: if it blanked the row, a paid account could change routing class purely
        because a billing endpoint hiccuped.
        """
        before = dict(self.ledger.entry(self.entry()["id"])["credits"])
        with patch.object(converter.credits_mod, "fetch_credits",
                          side_effect=RuntimeError("synthetic billing outage")):
            result, _failed = self.sync()
        self.assertIsNotNone(result)
        after = dict(self.ledger.entry(self.entry()["id"])["credits"])
        self.assertEqual(after.get("credits"), before.get("credits"),
                         "积分失败不得改写余额，否则会改变派发资格")
        self.assertEqual(after.get("intl"), before.get("intl"))

    def test_a_zero_balance_account_stays_blocked_after_a_billing_failure(self):
        """An account already known to be empty must not be re-admitted by a failed lookup."""
        self.ledger.update_credits(self.entry()["id"],
                                   {"credits": 0, "intl": False, "segments": []})
        with patch.object(converter.credits_mod, "fetch_credits",
                          side_effect=RuntimeError("synthetic billing outage")):
            result, _failed = self.sync()
        self.assertIsNotNone(result, "目录同步仍必须进行")
        self.assertEqual(self.ledger.entry(self.entry()["id"])["credits"]["credits"], 0)
        self.assertFalse(self.pool._eligible(self.entry(), "shared-model"),
                         "零余额账号不得因积分查询失败而被放行")

    def test_a_successful_lookup_returns_the_same_shape(self):
        """The caller's contract: (entry, generation, headers, profile)."""
        with patch.object(converter.credits_mod, "fetch_credits", return_value=dict(BALANCE)):
            result, _failed = self.sync()
        entry, generation, headers, profile = result
        self.assertIs(entry, self.entry())
        self.assertIsInstance(generation, int)
        self.assertIsInstance(headers, dict)
        self.assertEqual(profile, "cn-cli")

    def test_a_site_mismatch_is_treated_as_a_billing_failure(self):
        """A response from the wrong site is a bad answer, not a reason to skip the catalog."""
        wrong_site = dict(BALANCE, intl=True)      # cn-cli account, international payload.
        with patch.object(converter.credits_mod, "fetch_credits", return_value=wrong_site):
            result, failed = self.sync()
        self.assertIsNotNone(result, "站点不一致不得跳过目录同步")
        self.assertIn(self.entry()["id"], failed)


if __name__ == "__main__":
    unittest.main(verbosity=2)
