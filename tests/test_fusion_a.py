"""Fusion-A offline tests: 账号池调度与冷却体系.

覆盖七项融合改造：模型级软冷却（对齐墙钟+切模型豁免）、冷却中兜底不堆叠、
认证类错误连续 N 次才禁用、账号级 paused（签到/旅行/保号照跑）、保号任务账号间
限速、积分保底 credit_floor（EMA 台账 + 目录倍率双判据，全池触底 503）、
快过期积分加权选号。全部离线：合成凭证 + mock，无上游请求。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # Allow direct execution.

import json
import os
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import httpx
from fastapi import HTTPException

import converter
from app.credit_floor import CostLedger, catalog_paid, floor_admit
from app.credits import CreditLedger


def synthetic_credential(directory: Path, name: str, uid: str, expires_in: float = 86400) -> Path:
    now = time.time()
    path = directory / name
    path.write_text(json.dumps({"account": {"uid": uid}, "auth": {
        "accessToken": "tok-" + uid, "refreshToken": "ref-" + uid,
        "domain": "www.codebuddy.cn", "expiresAt": (now + expires_in) * 1000,
        "lastRefreshTime": (now - 3600) * 1000}}), encoding="utf-8")
    return path


def reset_body(seconds_ahead: float, offset: int = 8) -> bytes:
    """A 429 body in the observed English wording, pointing at a wall clock."""
    target = datetime.now(timezone(timedelta(hours=offset))) + timedelta(seconds=seconds_ahead)
    stamp = target.strftime("%Y-%m-%d %H:%M:%S")
    return f"your usage will reset at {stamp} UTC+{offset}, alternatively upgrade".encode()


class FusionFixture(unittest.TestCase):
    """Shared offline harness: temp credential directory and a clean CONFIG."""

    def setUp(self):
        self.td = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(self.td)
        self.enterContext(patch.dict(os.environ, {"CODEBUDDY_AUTH_DIR": str(self.root)}))
        self.enterContext(patch.dict(converter.CONFIG, {
            "log_path": None, "cred_pool": None, "cred": None,
            "account_catalogs": None, "model_cache": None, "model_catalogs": None,
            "usage_daily_accounts": None, "usage_daily": None, "usage_snapshots": None,
            "control_store": None, "cost_ledger": None,
        }, clear=False))
        self.enterContext(patch.object(converter, "_log"))

    def pool(self, names=("a.info", "b.info"), uids=("uid-a", "uid-b")):
        paths = [synthetic_credential(self.root, n, u) for n, u in zip(names, uids)]
        return converter.CredentialPool(paths), paths

    def identity(self, pool, index: int = 0) -> str:
        return pool.entries()[index]["account_key"]

    def refresh_client(self, calls):
        real_client = httpx.Client

        def handler(request):
            calls.append(request)
            return httpx.Response(200, json={"code": 0, "data": {
                "accessToken": "fresh-token", "expiresIn": 7200}})

        return lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw)

    def clear_breaker(self, pool):
        with pool._lock:
            for entry in pool._entries:
                entry["fail_until"] = 0.0


# --------------------------------------------------------------------------- #
# 1. 模型级软冷却：对齐墙钟 + 切模型豁免 + 配置开关 + 封顶
# --------------------------------------------------------------------------- #
class ModelSoftCooldownTests(FusionFixture):

    def test_429_aligns_to_reset_time_and_exempts_model_switch(self):
        pool, paths = self.pool(("a.info",), ("uid-a",))
        cm = pool.first()
        pool.note_status(cm, 429, model="glm-5.3-flash", raw=reset_body(3600))
        # 维度是 (账号, 模型)，截止对齐到文案墙钟（±5 秒解析误差）。
        deadline = next(u for (cid, m), u in pool._model_fail.items() if m == "glm-5.3-flash")
        self.assertAlmostEqual(deadline, time.time() + 3600, delta=5)
        self.assertIsNone(pool.pick(None, "glm-5.3-flash"))       # 撞限流的模型被挡
        self.assertIs(pool.pick(None, "deepseek-v4-flash"), cm)   # 换模型豁免

    def test_429_without_reset_uses_configured_default(self):
        with patch.dict(converter.CONFIG, {"model_cooldown_s": 900}):
            pool, paths = self.pool(("a.info",), ("uid-a",))
            pool.note_status(pool.first(), 429, model="glm-5.3-flash", raw=b"rate limited")
        deadline = next(u for (cid, m), u in pool._model_fail.items() if m == "glm-5.3-flash")
        self.assertAlmostEqual(deadline, time.time() + 900, delta=30)

    def test_switch_disables_the_soft_cooldown_gate(self):
        pool, paths = self.pool(("a.info",), ("uid-a",))
        cm = pool.first()
        pool.note_status(cm, 429, model="glm-5.3-flash", raw=reset_body(3600))
        self.assertIsNone(pool.pick(None, "glm-5.3-flash"))
        with patch.dict(converter.CONFIG, {"model_soft_cooldown": False}):
            self.assertIs(pool.pick(None, "glm-5.3-flash"), cm)

    def test_retry_after_is_capped_by_max(self):
        pool, paths = self.pool(("a.info",), ("uid-a",))
        pool.note_status(pool.first(), 429, model="glm-5.3-flash", raw=b"", retry_after=7 * 86400)
        deadline = next(u for (cid, m), u in pool._model_fail.items() if m == "glm-5.3-flash")
        self.assertAlmostEqual(deadline, time.time() + 86400, delta=5)   # 封顶 24h


# --------------------------------------------------------------------------- #
# 2. 冷却中兜底不堆叠：重复 429 不延长截止、不推进计数
# --------------------------------------------------------------------------- #
class CooldownNoStackTests(FusionFixture):

    def test_repeat_429_without_later_reset_keeps_deadline(self):
        pool, paths = self.pool(("a.info",), ("uid-a",))
        cm = pool.first()
        pool.note_status(cm, 429, model="glm-5.3-flash", raw=reset_body(3600))
        deadline = next(u for (cid, m), u in pool._model_fail.items() if m == "glm-5.3-flash")
        pool.note_status(cm, 429, model="glm-5.3-flash", raw=b"still limited")   # 兜底探测
        after = next(u for (cid, m), u in pool._model_fail.items() if m == "glm-5.3-flash")
        self.assertAlmostEqual(after, deadline, delta=1)

    def test_later_reset_still_extends(self):
        pool, paths = self.pool(("a.info",), ("uid-a",))
        cm = pool.first()
        pool.note_status(cm, 429, model="glm-5.3-flash", raw=reset_body(1800))
        pool.note_status(cm, 429, model="glm-5.3-flash", raw=reset_body(7200))
        after = next(u for (cid, m), u in pool._model_fail.items() if m == "glm-5.3-flash")
        self.assertAlmostEqual(after, time.time() + 7200, delta=5)

    def test_no_stack_skips_persistence_write(self):
        pool, paths = self.pool(("a.info",), ("uid-a",))
        cm = pool.first()
        pool.note_status(cm, 429, model="glm-5.3-flash", raw=reset_body(3600))
        with patch.object(pool, "_remember_model", return_value=True) as remember:
            pool.note_status(cm, 429, model="glm-5.3-flash", raw=b"probe")   # 兜底探测
            self.assertEqual(remember.call_count, 0)
        with patch.dict(converter.CONFIG, {"model_cooldown_no_stack": False}):
            with patch.object(pool, "_remember_model", return_value=True) as remember:
                pool.note_status(cm, 429, model="glm-5.3-flash", raw=b"probe")
                self.assertEqual(remember.call_count, 1)


# --------------------------------------------------------------------------- #
# 3. 认证类错误连续 N 次才禁用；refresh/chat 成功或手工操作清零
# --------------------------------------------------------------------------- #
class AuthFailThresholdTests(FusionFixture):

    def test_first_two_auth_failures_are_short_breaker_third_disables(self):
        pool, paths = self.pool(("a.info",), ("uid-a",))
        cm = pool.first()
        pool.note_status(cm, 401)
        self.assertAlmostEqual(pool._entries[0]["fail_until"], time.time() + 300, delta=5)
        self.assertEqual(pool.snapshot()[0]["auth_fails"], 1)
        pool.note_status(cm, 403)
        self.assertEqual(pool.snapshot()[0]["auth_fails"], 2)
        # 第三次连续失败触发禁用：长熔断（默认 3600s），计数清零。
        pool.note_status(cm, 401)
        self.assertEqual(pool.snapshot()[0]["auth_fails"], 0)
        self.assertGreater(pool._entries[0]["fail_until"], time.time() + 3500)

    def test_threshold_is_configurable(self):
        with patch.dict(converter.CONFIG, {"auth_fail_threshold": 2, "auth_disable_seconds": 7200}):
            pool, paths = self.pool(("a.info",), ("uid-a",))
            pool.note_status(pool.first(), 401)
            self.assertAlmostEqual(pool._entries[0]["fail_until"], time.time() + 300, delta=5)
            pool.note_status(pool.first(), 401)
            self.assertGreater(pool._entries[0]["fail_until"], time.time() + 7100)

    def test_chat_success_clears_the_counter(self):
        pool, paths = self.pool(("a.info",), ("uid-a",))
        cm = pool.first()
        pool.note_status(cm, 401)
        pool.note_status(cm, 401)
        pool.note_model_ok(cm, "glm-5.3-flash")   # chat 成功是最强恢复证据
        self.assertEqual(pool.snapshot()[0]["auth_fails"], 0)
        pool.note_status(cm, 401)
        self.assertEqual(pool.snapshot()[0]["auth_fails"], 1)
        self.assertAlmostEqual(pool._entries[0]["fail_until"], time.time() + 300, delta=5)

    def test_manual_cooldown_reset_clears_the_counter(self):
        pool, paths = self.pool(("a.info",), ("uid-a",))
        cm = pool.first()
        for _ in range(2):
            pool.note_status(cm, 401)
        self.assertEqual(pool.snapshot()[0]["auth_fails"], 2)
        pool.clear_cooldowns(cm)   # 手工操作清零
        self.assertEqual(pool.snapshot()[0]["auth_fails"], 0)

    def test_refresh_success_clears_the_counter(self):
        calls = []
        expired = synthetic_credential(self.root, "a.info", "uid-a", expires_in=-60)
        pool = converter.CredentialPool([expired])
        for _ in range(2):
            pool.note_status(pool.first(), 401)
        self.assertEqual(pool.snapshot()[0]["auth_fails"], 2)
        self.clear_breaker(pool)   # 短熔断到期后保活刷新照跑
        with patch.object(converter.httpx, "Client", side_effect=self.refresh_client(calls)):
            pool.refresh_due()
        self.assertEqual(len(calls), 1)
        self.assertEqual(pool.snapshot()[0]["auth_fails"], 0)


# --------------------------------------------------------------------------- #
# 4. 账号级 paused：暂停选号，签到/旅行/保号照跑，与停用正交
# --------------------------------------------------------------------------- #
class AccountPauseTests(FusionFixture):

    def test_pause_excludes_from_selection_and_resume_restores(self):
        pool, paths = self.pool()
        first, second = pool.entries()
        pool.pause(first["account_key"])
        for _ in range(4):
            self.assertIs(pool.pick(None), second["cm"])   # 暂停号不被选中
        rows = {row["auth_file"]: row for row in pool.snapshot()}
        self.assertTrue(rows[str(paths[0])]["paused"])
        self.assertFalse(rows[str(paths[1])]["paused"])
        pool.resume(first["account_key"])
        seen = {pool.pick(None) for _ in range(4)}   # 恢复后重新参与轮转
        self.assertEqual(len(seen), 2)

    def test_admin_entry_point_and_validation(self):
        pool, paths = self.pool()
        identity = self.identity(pool)
        converter.CONFIG["cred_pool"] = pool
        result = converter.admin_set_credential_paused(identity, True)
        self.assertEqual(result, {"id": identity, "paused": True})
        other = pool.entries()[1]["cm"]   # 暂停 A 后选号落在 B
        self.assertIs(pool.pick(None, "deepseek-v4-flash"), other)
        self.assertTrue(converter.admin_set_credential_paused(identity, False)["paused"] is False)
        with self.assertRaises(HTTPException) as ctx:
            converter.admin_set_credential_paused("nope", True)
        self.assertEqual(ctx.exception.status_code, 404)
        with self.assertRaises(HTTPException) as ctx:
            converter.admin_set_credential_paused(identity, "yes")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_pause_ledger_rows_are_visible(self):
        pool, paths = self.pool()
        identity = self.identity(pool)
        self.assertEqual(pool.paused_detail(), [])
        pool.pause(identity)
        self.assertEqual([row["identity"] for row in pool.paused_detail()], [identity])
        self.assertFalse(pool.pause_storage()["degraded"])

    def test_pause_leadin_path_and_file_roundtrip(self):
        # 显式 cooldowns_path 时，暂停台账落在其同目录；独立文件原子写、可重读。
        paths = [synthetic_credential(self.root, "a.info", "uid-a")]
        pauses_file = self.root / "account-pauses.json"
        pool = converter.CredentialPool(paths, cooldowns_path=self.root / "cooldowns.json")
        self.assertEqual(pool._pauses.path, str(pauses_file))
        identity = pool.entries()[0]["account_key"]
        pool.pause(identity)
        self.assertTrue(pauses_file.exists())
        fresh = converter.CredentialPool(paths, cooldowns_path=self.root / "cooldowns.json")
        self.assertTrue(fresh.is_paused(identity))
        fresh.resume(identity)
        self.assertFalse(fresh.is_paused(identity))
        # 脏文件不致启动失败：降级为空表（不暂停任何人）
        pauses_file.write_text("{not json", encoding="utf-8")
        self.assertEqual(converter.CredentialPool(
            paths, cooldowns_path=self.root / "cooldowns.json").paused_detail(), [])

    def test_paused_account_still_runs_keepalive(self):
        # 保号任务（保活刷新）不受暂停影响——只退出选号。
        expired = synthetic_credential(self.root, "a.info", "uid-a", expires_in=120)
        pool = converter.CredentialPool([expired])
        pool.pause(self.identity(pool))
        calls = []
        with patch.object(converter.httpx, "Client", side_effect=self.refresh_client(calls)):
            pool.refresh_due()
        self.assertEqual(len(calls), 1)   # 暂停号照常刷新保号

    def test_config_switch_disables_pause_gate(self):
        pool, paths = self.pool()
        first = pool.entries()[0]
        pool.pause(first["account_key"])
        with patch.dict(converter.CONFIG, {"account_pause": False}):
            seen = {pool.pick(None) for _ in range(4)}
            self.assertEqual(len(seen), 2)


# --------------------------------------------------------------------------- #
# 5. 保号任务账号间限速：签到/旅行循环间默认 ~0.8s sleep，0 关闭
# --------------------------------------------------------------------------- #
class MaintenanceGapTests(FusionFixture):

    def maintenance_pool(self):
        pool, paths = self.pool()
        ledger = CreditLedger(self.root / "ledger.json")
        pool.set_ledger(ledger)
        return pool, ledger

    def run_housekeep(self, pool, ledger):
        with patch.object(converter, "_sync_credits", return_value=None), \
                patch.object(converter, "_sync_usage"), \
                patch.object(converter, "_publish_usage_daily"):
            converter._housekeep_once(pool, ledger)

    def test_default_gap_sleeps_between_accounts(self):
        pool, ledger = self.maintenance_pool()
        sleeps = []
        with patch.dict(converter.CONFIG, {"maintenance_account_gap_s": 0.8}), \
                patch.object(converter.time, "sleep", side_effect=lambda s: sleeps.append(s)):
            self.run_housekeep(pool, ledger)
        self.assertEqual(sleeps, [0.8])   # 两个账号之间一次（首个账号前不睡）

    def test_gap_zero_disables_sleep(self):
        pool, ledger = self.maintenance_pool()
        sleeps = []
        with patch.dict(converter.CONFIG, {"maintenance_account_gap_s": 0.0}), \
                patch.object(converter.time, "sleep", side_effect=lambda s: sleeps.append(s)):
            self.run_housekeep(pool, ledger)
        self.assertEqual(sleeps, [])


# --------------------------------------------------------------------------- #
# 6. 积分保底 credit_floor：EMA 台账 + 目录倍率双判据，全池触底 503
# --------------------------------------------------------------------------- #
class CreditFloorTests(FusionFixture):

    def low_balance(self, pool, paths, index: int, credits: float):
        ledger = CreditLedger(self.root / "ledger.json")
        pool.set_ledger(ledger)
        now = time.time()
        for cred_id, amount in [(str(paths[index].resolve()), credits)]:
            ledger.update_credits(cred_id, {
                "credits": amount, "count": 1, "intl": False,
                "segments": [{"remaining": amount, "total": amount, "expires_at": now + 86400,
                              "source": "s", "package_code": "a"}],
                "soonest_expiry": now + 86400})
        return ledger

    def test_ema_ledger_converges_and_expires_with_ttl(self):
        ledger = CostLedger(self.root / "costs.json", alpha=0.3, ttl=21600)
        self.assertTrue(ledger.note("a" * 64, "glm-5.3-flash", 2.0, 1000))
        self.assertAlmostEqual(ledger.cost_of("a" * 64, "glm-5.3-flash"), 2.0, delta=0.001)
        ledger.note("a" * 64, "glm-5.3-flash", 8.0, 1000)   # EMA: 2*0.7 + 8*0.3 = 3.8
        self.assertAlmostEqual(ledger.cost_of("a" * 64, "glm-5.3-flash"), 3.8, delta=0.001)
        self.assertTrue(ledger.paid("a" * 64, "glm-5.3-flash"))
        # 过期观测不复活（防跨时段，例如限免窗口结束）
        self.assertIsNone(ledger.cost_of("a" * 64, "glm-5.3-flash", now=time.time() + 21601))
        self.assertIsNone(ledger.cost_of("a" * 64, "glm-5.3-flash", now=time.time() + 10 ** 9))

    def test_zero_cost_observation_marks_free(self):
        ledger = CostLedger(self.root / "costs.json", ttl=21600)
        ledger.note("a" * 64, "m", 0.0, 500)
        self.assertFalse(ledger.paid("a" * 64, "m"))
        ledger.note("a" * 64, "m", 3.0, 500)
        self.assertTrue(ledger.paid("a" * 64, "m"))   # 限免结束

    def test_ledger_roundtrip_and_rejects_garbage(self):
        ledger = CostLedger(self.root / "costs.json", ttl=21600)
        ledger.note("a" * 64, "m", 2.0, 1000)
        reloaded = CostLedger(self.root / "costs.json", ttl=21600)
        self.assertAlmostEqual(reloaded.cost_of("a" * 64, "m"), 2.0, delta=0.001)
        (self.root / "costs.json").write_text("{not json", encoding="utf-8")
        self.assertEqual(CostLedger(self.root / "costs.json", ttl=21600).detail(), [])

    def test_catalog_paid_and_floor_admit_primitives(self):
        self.assertTrue(catalog_paid([{"id": "m", "credits": "x1.62 credits"}], "m"))
        self.assertFalse(catalog_paid([{"id": "m", "credits": "x0"}], "m"))
        self.assertIsNone(catalog_paid([{"id": "m", "credits": None}], "m"))
        self.assertIsNone(catalog_paid([], "m"))
        # floor_admit：只有「判收费」才拦；免费与未知放行；余额未知不拦
        self.assertFalse(floor_admit(10, None, None))
        self.assertFalse(floor_admit(10, False, True))    # 实测免费优先
        self.assertFalse(floor_admit(10, True, False))
        self.assertFalse(floor_admit(10, None, None))
        self.assertTrue(floor_admit(10, True, None))
        self.assertTrue(floor_admit(10, None, True))

    def test_floor_blocks_paid_model_and_free_passes(self):
        pool, paths = self.pool(("a.info",), ("uid-a",))
        ledger = self.low_balance(pool, paths, 0, 50)
        costs = CostLedger(self.root / "costs.json", ttl=21600)
        pool.set_cost_ledger(costs)
        identity = self.identity(pool)
        with patch.dict(converter.CONFIG, {"credit_floor": 100}):
            entry = pool.entries()[0]
            # 无任何成本观测且无目录 → 未知放行
            self.assertFalse(pool._floor_blocked(entry, "glm-5.3-flash"))
            # 本地 EMA 台账实测收费 → 拦
            costs.note(identity, "glm-5.3-flash", 2.0, 1000)
            self.assertTrue(pool._floor_blocked(entry, "glm-5.3-flash"))
            # 实测免费 → 放行（保底的目的正是留给免费模型用）
            costs.note(identity, "kimi-k3-1", 0.0, 1000)
            self.assertFalse(pool._floor_blocked(entry, "kimi-k3-1"))
        # 余额高于保底 → 一律不拦
        with patch.dict(converter.CONFIG, {"credit_floor": 40}):
            self.assertFalse(pool._floor_blocked(pool.entries()[0], "glm-5.3-flash"))
        # 余额未知（无快照）→ 不拦
        pool2, paths2 = self.pool(("c.info",), ("uid-c",))
        with patch.dict(converter.CONFIG, {"credit_floor": 100}):
            self.assertFalse(pool2._floor_blocked(pool2.entries()[0], "glm-5.3-flash"))

    def test_catalog_multiplier_fallback_blocks(self):
        pool, paths = self.pool(("a.info",), ("uid-a",))
        self.low_balance(pool, paths, 0, 50)
        pool.set_cost_ledger(CostLedger(self.root / "costs.json", ttl=21600))
        identity = self.identity(pool)
        catalog = {identity: {"profile": "cn-cli", "models": [], "serves": [
            {"id": "glm-5.3-flash", "supportsToolCall": True, "credits": "x1.62 credits"}]}}
        with patch.dict(converter.CONFIG, {"credit_floor": 100, "account_catalogs": catalog}):
            # 无本地观测时用上游目录倍率兜底：x1.62 → 判收费 → 拦
            self.assertTrue(pool._floor_blocked(pool.entries()[0], "glm-5.3-flash"))
            # x0 声明免费 → 放行
            catalog[identity]["serves"][0]["credits"] = "x0"
            self.assertFalse(pool._floor_blocked(pool.entries()[0], "glm-5.3-flash"))
            # 目录未覆盖该模型 → 未知放行
            catalog[identity]["serves"][0]["id"] = "other-model"
            self.assertFalse(pool._floor_blocked(pool.entries()[0], "glm-5.3-flash"))

    def test_pool_noting_cost_from_usage(self):
        pool, paths = self.pool(("a.info",), ("uid-a",))
        costs = CostLedger(self.root / "costs.json", ttl=21600)
        pool.set_cost_ledger(costs)
        pool.note_cost(pool.first(), "glm-5.3-flash", {"credit": 2.0, "total_tokens": 1000})
        self.assertTrue(costs.paid(self.identity(pool), "glm-5.3-flash"))
        # 无 credit 字段 → 无计费信号，不落账
        pool.note_cost(pool.first(), "kimi-k3-1", {"prompt_tokens": 100, "completion_tokens": 400})
        self.assertIsNone(costs.cost_of(self.identity(pool), "kimi-k3-1"))

    def test_floor_exhausted_raises_503(self):
        pool, paths = self.pool()
        ledger = CreditLedger(self.root / "ledger.json")
        pool.set_ledger(ledger)
        costs = CostLedger(self.root / "costs.json", ttl=21600)
        pool.set_cost_ledger(costs)
        now = time.time()
        for index, credits in ((0, 50), (1, 30)):
            ledger.update_credits(str(paths[index].resolve()), {
                "credits": credits, "count": 1, "intl": False,
                "segments": [{"remaining": credits, "total": credits, "expires_at": now + 86400,
                              "source": "s", "package_code": "a"}],
                "soonest_expiry": now + 86400})
            costs.note(self.identity(pool, index), "glm-5.3-flash", 2.0, 1000)
        with patch.dict(converter.CONFIG, {"credit_floor": 100}):
            self.assertTrue(pool.floor_exhausted("glm-5.3-flash"))
            self.assertFalse(pool.floor_exhausted("kimi-k3-1"))   # 该模型未触底（未知放行）
            # 候选被 tried 排空时不是保底的职责（保持既有 503/404/429 分类）
            self.assertFalse(pool.floor_exhausted(
                "glm-5.3-flash", tried=[pool.entries()[0]["cm"], pool.entries()[1]["cm"]]))
            converter.CONFIG["cred_pool"] = pool
            with patch.object(pool, "model_cooldown_until", return_value=None), \
                    patch.object(pool, "model_block_until", return_value=None):
                with self.assertRaises(HTTPException) as ctx:
                    converter._cred_for({"messages": []}, "glm-5.3-flash")
                self.assertEqual(ctx.exception.status_code, 503)
                self.assertEqual(ctx.exception.detail["error"]["code"], "credit_floor_exhausted")


# --------------------------------------------------------------------------- #
# 7. 快过期积分加权选号：窗口内批次权重 ×3，软偏好，不破坏粘性与零倍率优先
# --------------------------------------------------------------------------- #
class ExpiringWeightTests(FusionFixture):

    def ledger_pool(self):
        pool, paths = self.pool()
        ledger = CreditLedger(self.root / "ledger.json")
        pool.set_ledger(ledger)
        return pool, ledger, [str(p.resolve()) for p in paths]

    def set_segments(self, ledger, ids, expiry_offsets):
        now = time.time()
        for cred_id, offset in zip(ids, expiry_offsets):
            ledger.update_credits(cred_id, {
                "credits": 100, "count": 1, "intl": False,
                "segments": [{"remaining": 100, "total": 100, "expires_at": now + offset,
                              "source": "s", "package_code": str(offset)}],
                "soonest_expiry": now + offset})

    def test_weighted_distribution_prefers_expiring(self):
        pool, ledger, ids = self.ledger_pool()
        self.set_segments(ledger, ids, [3600, 30 * 86400])   # A 在窗口内，B 不在
        names = [Path(pool.pick(None).path).name for _ in range(8)]
        self.assertEqual(names.count("a.info"), 6)   # 权重 3:1 → A 六次 B 两次
        self.assertEqual(names.count("b.info"), 2)

    def test_sticky_binding_survives_the_weight(self):
        pool, ledger, ids = self.ledger_pool()
        self.set_segments(ledger, ids, [3600, 30 * 86400])
        sticking = pool.entries()[1]   # B（非快过期、权重低）
        pool._sticky["sess"] = (sticking["id"], time.time())
        self.assertIs(pool.pick("sess"), sticking["cm"])
        self.assertIs(pool.pick("sess"), sticking["cm"])

    def test_zero_rate_priority_is_preserved(self):
        pool, ledger, ids = self.ledger_pool()
        self.set_segments(ledger, ids, [30 * 86400, 3600])   # B 快过期，A 不在窗口
        free_identity = pool.entries()[0]["account_key"]
        free_cm = pool.entries()[0]["cm"]
        with patch.object(pool, "_model_free",
                          side_effect=lambda e, m, **kw: e.get("account_key") == free_identity):
            # A 零倍率、B 快过期：零倍率优先，加权不越界。
            for _ in range(4):
                self.assertIs(pool.pick(None, "glm-5.3-flash"), free_cm)

    def test_disabled_weight_returns_to_rank_strict_order(self):
        pool, ledger, ids = self.ledger_pool()
        self.set_segments(ledger, ids, [3600, 30 * 86400])
        entries = pool.entries()
        with patch.object(pool, "_model_free", return_value=False), \
                patch.dict(converter.CONFIG, {"expiring_credit_window_s": 0}):
            for _ in range(4):
                self.assertIs(pool.pick(None, "glm-5.3-flash"), entries[0]["cm"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
