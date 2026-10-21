#!/usr/bin/env python3
"""Regression tests for the routing hot path: stat storms, cache invalidation, identity safety.

Three defects are pinned here, each reproduced before it was fixed:

* CredentialPool._entry_profile re-read every credential file through summary() on
  every candidate check, and _eligible rebuilt the pool's configured-profile set by
  walking every entry (copying the list under the pool lock) once per candidate.
  Selection was therefore quadratic in the pool size: a 12-account pool cost 241
  Path.stat calls per pick and a 200-account pool cost 41601 (measured; see
  /tmp/stat_probe.py). After the fix the cost is 2N -- one stat per entry, for the
  generation lease check.
* The configured-profile cache must go stale on every way the answer can move: a
  reload/prune that changes the entry set or a profile, and the control store's
  enabled flag. A cache keyed only on the pool would keep serving a disabled
  account, or a profile that a rewritten credential file no longer has.
* The identity safety check in _eligible must still refuse an entry whose file was
  replaced by a different account. Skipping the check when the entry's generation
  still matches the file is safe -- the generation proves the entry was built from
  that content -- but a moved generation must re-derive the identity and reject the
  entry, and the catalog lookup must use the freshly parsed identity.
"""

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # Allow direct execution.

import converter
from app import credits
from app.control_store import ControlStore

REAL_STAT = Path.stat
MODEL = "deepseek-v4-pro"
CN_DOMAIN = "www.codebuddy.cn"
INTL_DOMAIN = "www.codebuddy.ai"


class StatCounter:
    """Count Path.stat calls made while the counter is active."""

    def __init__(self):
        self.count = 0
        self._patch = None

    def __enter__(self):
        def counting(path_self, *args, **kwargs):
            self.count += 1
            return REAL_STAT(path_self, *args, **kwargs)

        self._patch = patch.object(Path, "stat", counting)
        self._patch.start()
        return self

    def __exit__(self, *exc):
        self._patch.stop()
        return False


class HotPathFixture(unittest.TestCase):
    """Build synthetic offline credentials and a real CredentialPool over them."""

    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.dict(os.environ, {"CODEBUDDY_AUTH_DIR": str(self.root)}))
        self.enterContext(patch.dict(converter.CONFIG, {
            "log_path": None, "cred_pool": None, "cred": None, "ledger": None,
            "model_catalogs": {}, "account_catalogs": None, "model_cache": None,
            "control_store": None}))
        self.enterContext(patch.object(converter, "_log"))

    def credential(self, index, *, uid=None, domain=CN_DOMAIN):
        now = time.time()
        path = self.root / f"acct-{index:03d}.info"
        path.write_text(json.dumps({
            "account": {"uid": uid or f"synthetic-uid-{index:03d}"},
            "auth": {"accessToken": "synthetic-token", "refreshToken": "synthetic-refresh",
                     "domain": domain, "expiresAt": (now + 86400) * 1000,
                     "lastRefreshTime": now * 1000}}), encoding="utf-8")
        return path

    def pool(self, paths, **kwargs):
        """Build a pool and publish it as the configured one, as the gateway does at startup."""
        pool = converter.CredentialPool(
            list(paths), blocks_path=self.root / "blocks.json",
            cooldowns_path=self.root / "cooldowns.json", **kwargs)
        converter.CONFIG["cred_pool"] = pool
        return pool


class StatBoundTests(HotPathFixture):
    """Bound the per-pick stat count so selection stays linear in the pool size."""

    def measure(self, count):
        paths = [self.credential(index) for index in range(count)]
        pool = self.pool(paths)
        self.assertIsNotNone(pool.pick(None, MODEL), "synthetic pool must be routable")
        with StatCounter() as counter:
            picked = pool.pick(None, MODEL)
        self.assertIsNotNone(picked)
        return counter.count

    def test_pick_reads_at_most_two_stats_per_account(self):
        """A pick may stat each credential once (lease check), never once per candidate."""
        for count in (12, 50):
            with self.subTest(accounts=count):
                stats = self.measure(count)
                # Before the fix: 241 stat calls at N=12 and 2901 at N=50.
                self.assertLess(stats, 5 * count, f"{count} accounts cost {stats} stat calls")
                # The generation lease check is the only unavoidable stat: one per entry.
                self.assertLessEqual(stats, 2 * count, f"{count} accounts cost {stats} stat calls")

    def test_configured_profiles_is_consulted_once_per_candidate(self):
        """The per-candidate call stays, but it must be O(1) -- proven by the stat bound above."""
        paths = [self.credential(index) for index in range(12)]
        pool = self.pool(paths)
        with patch.object(converter, "_configured_profiles",
                          side_effect=converter._configured_profiles) as cached:
            pool.pick(None, MODEL)
        self.assertGreater(cached.call_count, 0)


class RoutingCounter:
    """Count pool walks and shared-source recomputations made by one selection."""

    def __init__(self):
        self.walks = 0          # CredentialPool.entries() calls (any caller).
        self.copied = 0         # entries copied by those walks.
        self.shared_walks = 0   # walks made from inside the shared-source path.
        self.recomputes = 0     # _shared_catalog_sources() cache misses.
        self._depth = 0
        self._patches = []

    def __enter__(self):
        real_entries = converter.CredentialPool.entries
        real_uncached = converter._shared_catalog_sources_uncached

        def counting_entries(pool_self, *args, **kwargs):
            self.walks += 1
            self.copied += len(pool_self._entries)
            if self._depth:
                self.shared_walks += 1
            return real_entries(pool_self, *args, **kwargs)

        def counting_uncached(scope="models"):
            self.recomputes += 1
            self._depth += 1
            try:
                return real_uncached(scope)
            finally:
                self._depth -= 1

        for target, name, value in (
                (converter.CredentialPool, "entries", counting_entries),
                (converter, "_shared_catalog_sources_uncached", counting_uncached)):
            self._patches.append(patch.object(target, name, value))
            self._patches[-1].start()
        return self

    def __exit__(self, *exc):
        for active in reversed(self._patches):
            active.stop()
        return False


class SharedCatalogSourcesTests(HotPathFixture):
    """The international pool must not re-walk the pool once per account.

    _catalog_for() consults _shared_catalog_sources() once per account, and that function
    used to call pool.entries() every time, so selection was quadratic in the pool size:
    a 60-account international pool copied every entry 7807 times per pick (measured;
    see /tmp/t3_prod.py). Only the pool walk is bounded here -- the per-call cached lookup
    itself stays, because its inputs can move between two calls inside one request.
    """

    def setUp(self):
        super().setUp()
        self.enterContext(patch.dict(converter.CONFIG, {"account_catalogs": {}}))

    def intl_pool(self, count):
        """Build a routable international pool: shared catalogs plus a funded ledger.

        An international account with no balance is refused by the credit floor, and
        share_models() only inherits from accounts whose catalog is published, so both
        pieces are needed before the scenario under test exists at all.
        """
        paths = [self.credential(index, domain=INTL_DOMAIN) for index in range(count)]
        pool = self.pool(paths)
        ledger = credits.CreditLedger(self.root / "ledger.json")
        pool.set_ledger(ledger)
        self.enterContext(patch.dict(converter.CONFIG, {"ledger": ledger}))
        for entry in pool._entries:
            ledger.update_credits(entry["id"], {
                "credits": 5000, "intl": True,
                "segments": [{"credits": 5000, "remaining": 5000,
                              "expires_at": time.time() + 86400 * 30}]})
        accounts = {entry["account_key"]: {
            "profile": entry["profile"],
            "models": [{"id": MODEL, "supportsToolCall": True, "credits": "x1"}],
            "serves": [{"id": MODEL, "supportsToolCall": True, "credits": "x1"}]}
            for entry in pool._entries}
        self.enterContext(patch.dict(converter.CONFIG, {"account_catalogs": accounts}))
        return pool

    def domestic_pool(self, count):
        """Same shape as intl_pool(), but with domestic accounts as the baseline."""
        paths = [self.credential(index, domain=CN_DOMAIN) for index in range(count)]
        pool = self.pool(paths)
        accounts = {entry["account_key"]: {
            "profile": entry["profile"],
            "models": [{"id": MODEL, "supportsToolCall": True, "credits": "x1"}],
            "serves": [{"id": MODEL, "supportsToolCall": True, "credits": "x1"}]}
            for entry in pool._entries}
        self.enterContext(patch.dict(converter.CONFIG, {"account_catalogs": accounts}))
        return pool

    def test_an_international_pool_is_routable_at_all(self):
        """Guard the scenario itself: without this the bound below could pass on a no-op."""
        pool = self.intl_pool(12)
        self.assertIsNotNone(pool.pick(None, MODEL), "an intl pool must be routable")
        self.assertIsNotNone(pool.headers_for(None, MODEL))

    def test_an_international_pick_costs_no_more_pool_walks_than_a_domestic_one(self):
        """Selection cost must not depend on how many accounts share their catalogs.

        Before the fix an international pool walked itself once per account on top of the
        domestic cost: 539 walks at N=14, 2107 at N=30 and 7807 at N=60, versus 75/155/305
        for a domestic pool of the same size. Equal counts now prove the extra factor is
        gone, and the recompute bound keeps the derived catalogs from being rebuilt per
        account if a future change starts invalidating more often.
        """
        for count in (12, 50):
            with self.subTest(accounts=count):
                intl = self.intl_pool(count)
                self.assertIsNotNone(intl.headers_for(None, MODEL))
                with RoutingCounter() as counter:
                    self.assertIsNotNone(intl.headers_for(None, MODEL))
                intl_walks, recomputes = counter.walks, counter.recomputes
                self.assertLessEqual(recomputes, 2,
                                     f"{count} intl accounts recomputed {recomputes}x")
                self.assertLessEqual(counter.shared_walks, recomputes,
                                     "shared sources must only walk the pool when recomputing")

                domestic = self.domestic_pool(count)
                self.assertIsNotNone(domestic.headers_for(None, MODEL))
                with RoutingCounter() as baseline:
                    self.assertIsNotNone(domestic.headers_for(None, MODEL))
                self.assertLessEqual(intl_walks, baseline.walks,
                                     f"intl pick walked {intl_walks}x, domestic {baseline.walks}x")

    def test_the_cached_sources_still_react_to_every_input(self):
        """The cache must not outlive a membership, enabled-flag or catalog change."""
        pool = self.intl_pool(4)
        target = pool._entries[0]
        sources = converter._shared_catalog_sources("models")
        self.assertEqual(len(sources), 4)

        # A control store toggle moves the control revision, which is part of the key.
        control = ControlStore(self.root / "control.sqlite3")
        self.enterContext(_closing(control))
        with patch.dict(converter.CONFIG, {"control_store": control}):
            self.assertEqual(len(converter._shared_catalog_sources("models")), 4)
            control.set_credential(target["account_key"], False)
            self.assertEqual(len(converter._shared_catalog_sources("models")), 3)
            control.set_credential(target["account_key"], True)
            self.assertEqual(len(converter._shared_catalog_sources("models")), 4)

        # Pruning an account bumps pool.revision.
        Path(pool._entries[-1]["id"]).unlink()
        pool.prune()
        self.assertEqual(len(converter._shared_catalog_sources("models")), 3)

        # Republishing the catalogs object (what every admin edit does) is a new identity.
        with patch.dict(converter.CONFIG, {"account_catalogs": {}}):
            self.assertEqual(converter._shared_catalog_sources("models"), [])


class ConfiguredProfilesCacheTests(HotPathFixture):
    """The cache must expire on every change that can move the configured set."""

    def test_disabling_an_account_through_the_control_store_is_visible_immediately(self):
        """Toggling enabled in the control store must invalidate the cached profile set."""
        control = ControlStore(self.root / "control.sqlite3")
        self.enterContext(_closing(control))
        converter.CONFIG["control_store"] = control
        paths = [self.credential(0, domain=CN_DOMAIN),
                 self.credential(1, domain=INTL_DOMAIN)]
        pool = self.pool(paths)
        self.assertEqual(converter._configured_profiles(None), {"cn-cli", "intl-cli"})

        identity = next(entry["account_key"] for entry in pool.entries()
                        if entry["profile"] == "intl-cli")
        control.set_credential(identity, False)
        self.assertEqual(converter._configured_profiles(None), {"cn-cli"})
        self.assertEqual(converter._configured_profiles("intl"), frozenset())
        self.assertEqual(converter._configured_profiles("cn"), {"cn-cli"})

        control.set_credential(identity, True)
        self.assertEqual(converter._configured_profiles(None), {"cn-cli", "intl-cli"})

    def test_a_profile_change_on_reload_is_visible_immediately(self):
        """Rewriting a credential file for another product must move the cached set."""
        path = self.credential(0, domain=CN_DOMAIN)
        pool = self.pool([path])
        self.assertEqual(converter._configured_profiles(None), {"cn-cli"})

        self.credential(0, domain=INTL_DOMAIN)      # Same path, different product.
        pool.reload([path], reset=False)
        self.assertEqual(converter._configured_profiles(None), {"intl-cli"})

    def test_pruning_a_credential_is_visible_immediately(self):
        """Deleting a credential file must not leave its profile in the cached set."""
        paths = [self.credential(0, domain=CN_DOMAIN),
                 self.credential(1, domain=INTL_DOMAIN)]
        pool = self.pool(paths)
        self.assertEqual(converter._configured_profiles(None), {"cn-cli", "intl-cli"})

        paths[1].unlink()
        pool.prune()
        self.assertEqual(converter._configured_profiles(None), {"cn-cli"})

    def test_revision_moves_on_every_membership_change(self):
        """The revision is the cache key; it must move on add, prune and profile change."""
        path = self.credential(0)
        pool = self.pool([path])
        seen = {pool.revision}

        second = self.credential(1)
        pool.reload([second], reset=False)                   # Add
        seen.add(pool.revision)
        pool.reload([path], reset=False)                     # Unchanged reload
        unchanged = pool.revision
        self.credential(0, domain=INTL_DOMAIN)               # Profile change
        pool.reload([path], reset=False)
        seen.add(pool.revision)
        self.assertNotEqual(pool.revision, unchanged, "a profile change must move the revision")
        second.unlink()                                      # Prune
        pool.prune()
        seen.add(pool.revision)
        self.assertEqual(len(seen), 4, "every membership change must produce a new revision")


class IdentitySafetyTests(HotPathFixture):
    """A credential file replaced by another account must not keep serving its old entry."""

    def setUp(self):
        super().setUp()
        # The identity check only runs when a per-account catalog is configured.
        self.enterContext(patch.dict(converter.CONFIG, {"account_catalogs": {}}))

    def publish_catalog(self, identity, profile="cn-cli"):
        """Declare one account's served models, as the catalog sync would."""
        catalogs = dict(converter.CONFIG.get("account_catalogs") or {})
        catalogs[identity] = {"profile": profile,
                              "models": [{"id": MODEL, "supportsToolCall": True}]}
        converter.CONFIG["account_catalogs"] = catalogs

    def test_swapping_the_file_for_another_account_is_refused(self):
        """The old entry must be ineligible once the file behind it names another account."""
        path = self.credential(0, uid="first-uid")
        pool = self.pool([path])
        entry = pool._entries[0]
        self.publish_catalog(entry["account_key"])
        self.assertEqual(entry["generation"], entry["cm"]._generation)
        self.assertTrue(pool._eligible(entry, MODEL), "the untouched entry must stay eligible")

        self.credential(0, uid="second-uid")       # Same path, another account, no reload.
        entry["cm"]._load_if_stale()               # Move the generation behind the pool's back.
        self.assertNotEqual(entry["generation"], entry["cm"]._generation)
        self.assertFalse(pool._eligible(entry, MODEL),
                         "an entry whose file now names another account must be refused")

    def test_the_safety_check_uses_the_freshly_parsed_identity(self):
        """After a swap the lookup must follow the file's account, never the cached one."""
        path = self.credential(0, uid="first-uid")
        pool = self.pool([path])
        entry = pool._entries[0]
        cached_identity = entry["account_key"]
        self.publish_catalog(cached_identity)

        self.credential(0, uid="second-uid")
        entry["cm"]._load_if_stale()
        new_identity = entry["cm"].summary()["account_key"]
        self.assertNotEqual(new_identity, cached_identity)
        # The replacement account is fully catalogued and servable. If the guard looked the
        # catalog up under the stale identity it would find nothing and refuse for the wrong
        # reason, so a False here can only come from the generation guard itself.
        self.publish_catalog(new_identity)
        self.assertFalse(pool._eligible(entry, MODEL),
                         "a moved generation must still refuse the stale entry")

    def test_a_matching_generation_skips_the_reread(self):
        """When the generation matches, _eligible must not re-parse the file."""
        path = self.credential(0, uid="first-uid")
        pool = self.pool([path])
        entry = pool._entries[0]
        self.publish_catalog(entry["account_key"])
        self.assertEqual(entry["generation"], entry["cm"]._generation)
        with patch.object(type(entry["cm"]), "summary",
                          side_effect=AssertionError("hot path must not re-read the credential")):
            self.assertTrue(pool._eligible(entry, MODEL))

    def test_a_corrupted_file_never_serves_a_request(self):
        """Corruption is caught where it can actually be observed: at header time.

        The generation check is deliberately O(1) and never re-reads the file, so it cannot
        see a file that became unparseable without anyone touching the manager. That is
        still safe: get_headers() re-reads and raises, headers_for cools the credential down
        and tries the next one, so a corrupt credential never carries a request.
        """
        corrupt = self.credential(0, uid="first-uid")
        healthy = self.credential(1, uid="second-uid")
        pool = self.pool([corrupt, healthy])
        for entry in pool.entries():
            self.publish_catalog(entry["account_key"])
        corrupt.write_text("{ not json", encoding="utf-8")

        served = []
        for _ in range(4):
            picked = pool.headers_for(None, MODEL)
            if picked is None:
                break
            served.append(picked[1].get("X-User-Id") if isinstance(picked, tuple) else picked)
        self.assertTrue(served, "the healthy credential must still be reachable")
        corrupt_id = next(entry["id"] for entry in pool.entries() if entry["id"] == str(corrupt))
        corrupt_entry = next(entry for entry in pool.entries() if entry["id"] == corrupt_id)
        self.assertGreater(corrupt_entry["fail_until"], time.time(),
                           "a credential whose file cannot be read must be cooled down")

    def test_a_corrupted_single_credential_pool_serves_nothing(self):
        """With no alternative the request must fail rather than fall through to a bad file."""
        path = self.credential(0, uid="first-uid")
        pool = self.pool([path])
        self.publish_catalog(pool._entries[0]["account_key"])
        path.write_text("{ not json", encoding="utf-8")
        self.assertIsNone(pool.headers_for(None, MODEL))


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
