#!/usr/bin/env python3
"""上游 6021 queue.full 是渠道容量信号，不得当作账号级 429 冷却（P4/B1）。

覆盖四件事：
1. 单账号撞 6021 → 不写 _model_fail、账号 fail_until 不变；
2. 6 个账号各撞一次 → model_cooldown_until 仍为 None（修复前这里是 600s）；
3. 客户端拿到 503 + Retry-After: 5（不是 429 + 600），且仍会换号；
4. 真正的账号级 429 仍照旧冷却 600s（防改过头）。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # Allow direct execution.

import json
import os
import tempfile
import time
import unittest
from unittest.mock import patch

import httpx

import converter
from app.credits import CreditLedger
from tests import test_region_routing as fixtures

# 默认目录（DEFAULT_MODELS）里的真实模型名，池测试不依赖夹具目录。
MODEL = "deepseek-v4-pro"
QUEUE_FULL_BODY = b'{"code":6021,"msg":"queue.full.title"}'
# 真·账号级限流：6004 带重置墙钟，必须继续走模型软冷却。
QUOTA_BODY = b'{"code":6004,"msg":"quota exceeded for this account"}'


def credential(directory: Path, name: str, uid: str) -> Path:
    now = time.time()
    path = directory / name
    path.write_text(json.dumps({"account": {"uid": uid}, "auth": {
        "accessToken": "tok-" + uid, "refreshToken": "ref-" + uid,
        "domain": "www.codebuddy.cn", "expiresAt": (now + 86400) * 1000,
        "lastRefreshTime": now * 1000}}), encoding="utf-8")
    return path


class RecognitionTests(unittest.TestCase):
    """识别规则本身：结构化 code、文案关键词、大小写、长度上限、防御式解析。"""

    def test_structured_code_and_wording_are_recognized(self):
        cases = (QUEUE_FULL_BODY,
                 b'{"code":"6021"}',
                 b'{"errCode":6021,"msg":"busy"}',
                 b'{"error":{"error_code":"6021"}}',
                 b'{"msg":"queue.full.title"}',
                 b'{"message":"QUEUE.FULL"}',
                 b'{"message":"Queue Full"}',
                 b'{"message":"queue_full"}',
                 b'{"message":"queue full"}')
        for raw in cases:
            with self.subTest(raw=raw):
                self.assertIsNotNone(converter._parse_queue_full(raw, 429))

    def test_ordinary_rate_limit_bodies_are_not_queue_full(self):
        cases = (b"", b"rate limited", QUOTA_BODY, b'{"code":4290,"msg":"quota"}',
                 b'{"error":{"message":"slow down"}}',
                 b'{"message":"queue"}',          # 只有 queue 没有 full
                 b'{"message":"full"}')
        for raw in cases:
            with self.subTest(raw=raw):
                self.assertIsNone(converter._parse_queue_full(raw, 429))

    def test_only_queue_full_statuses_are_inspected(self):
        for status in (400, 401, 404, 500, 502):
            with self.subTest(status=status):
                self.assertIsNone(converter._parse_queue_full(QUEUE_FULL_BODY, status))
        for status in (429, 503):
            with self.subTest(status=status):
                self.assertIsNotNone(converter._parse_queue_full(QUEUE_FULL_BODY, status))

    def test_recognition_is_bounded_to_the_response_head(self):
        """Marker beyond QUEUE_FULL_HEAD must not be scanned; parsing stays bounded."""
        self.assertEqual(converter.QUEUE_FULL_HEAD, 512)
        padding = b'{"msg":"' + b"x" * converter.QUEUE_FULL_HEAD + b'queue.full"}'
        self.assertIsNone(converter._parse_queue_full(padding, 429))
        inside = b'{"msg":"' + b"x" * 32 + b'queue.full"}'
        self.assertIsNotNone(converter._parse_queue_full(inside, 429))

    def test_malformed_bodies_never_raise(self):
        for raw in (b"{", b"\xff\xfe", b"[" * 5000, b'{"code":{"deep":[1,2,3]}}', b"null"):
            with self.subTest(raw=raw[:16]):
                converter._parse_queue_full(raw, 429)      # Must not raise.

    def test_failed_recognition_is_the_only_reason_a_test_could_pass(self):
        """Pin the helper's contract: it is the switch the regressions below rely on."""
        self.assertIsNotNone(converter._parse_queue_full(QUEUE_FULL_BODY, 429))


class QueueFullPoolTests(unittest.TestCase):
    """池层：6021 不产生任何账号级或模型级冷却。"""

    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.dict(os.environ, {"CODEBUDDY_AUTH_DIR": str(self.root)}))
        self.enterContext(patch.dict(converter.CONFIG, {
            "cred_pool": None, "cred": None, "ledger": None, "log_path": None,
            "account_catalogs": None, "model_cache": None, "model_catalogs": None,
        }, clear=False))
        self.enterContext(patch.object(converter, "_log"))

    def pool(self, count):
        paths = [credential(self.root, f"acct{index}.info", f"uid-{index}")
                 for index in range(count)]
        pool = converter.CredentialPool(paths)
        pool.set_ledger(CreditLedger(self.root / "ledger.json"))
        return pool

    def test_single_account_queue_full_leaves_no_trace(self):
        pool = self.pool(1)
        entry = pool.entries()[0]
        before_fail_until = entry["fail_until"]
        pool.note_status(entry["cm"], 429, model=MODEL, raw=QUEUE_FULL_BODY)
        self.assertEqual(pool._model_fail, {}, "6021 不得写入模型软冷却")
        self.assertEqual(entry["fail_until"], before_fail_until, "6021 不得熔断账号")
        self.assertIsNone(entry.get("last_error"))
        self.assertTrue(pool._model_healthy(entry, MODEL))
        self.assertTrue(pool._healthy(entry))

    def test_six_accounts_hitting_queue_full_never_cool_the_pool(self):
        """修复前：6 个账号各撞一次 → 全池该模型 429 + Retry-After 600。"""
        pool = self.pool(6)
        self.assertEqual(len(pool.entries()), 6)
        for entry in pool.entries():
            pool.note_status(entry["cm"], 429, model=MODEL, raw=QUEUE_FULL_BODY)
        self.assertEqual(pool._model_fail, {})
        self.assertIsNone(pool.model_cooldown_until(MODEL), "全池不得进入模型冷却")
        self.assertIsNotNone(pool.pick(None, MODEL), "6021 之后仍然可以选到账号")

    def test_queue_full_on_503_transport_is_also_ignored(self):
        pool = self.pool(2)
        for entry in pool.entries():
            pool.note_status(entry["cm"], 503, model=MODEL, raw=QUEUE_FULL_BODY)
        self.assertEqual(pool._model_fail, {})
        self.assertIsNone(pool.model_cooldown_until(MODEL))

    def test_real_account_rate_limit_still_cools_for_six_hundred_seconds(self):
        """防改过头：真·账号级 429 必须继续走 600s 模型软冷却。"""
        pool = self.pool(1)
        entry = pool.entries()[0]
        before = time.time()
        pool.note_status(entry["cm"], 429, model=MODEL, raw=QUOTA_BODY)
        deadline = pool._model_fail[(entry["id"], MODEL)]
        self.assertAlmostEqual(deadline - before, converter.MODEL_COOLDOWN, delta=5)
        self.assertFalse(pool._model_healthy(entry, MODEL))
        self.assertIsNone(pool.pick(None, MODEL))

    def test_real_rate_limit_still_cools_every_account_after_six_rejections(self):
        pool = self.pool(6)
        for entry in pool.entries():
            pool.note_status(entry["cm"], 429, model=MODEL, raw=QUOTA_BODY)
        self.assertEqual(len(pool._model_fail), 6)
        self.assertIsNotNone(pool.model_cooldown_until(MODEL))


class QueueFullClientTests(fixtures.RegionRoutingTests):
    """端到端：客户端拿 503 + Retry-After: 5，并且仍会换号。

    复用夹具的上游桩（保留 host / 身份头 / allowed_profiles 断言），只把生成请求的
    响应体换成 6021，避免另起一套 transport 让断言绕过真实调用链。
    """

    queue_full_budget = 0     # 前 N 个生成请求返回 6021，其余正常。

    def handle_upstream(self, request):
        if self.queue_full_budget and request.url.path == "/v2/chat/completions":
            uid = request.headers.get("x-user-id")
            self.assertIn(uid, self.allowed_profiles, "unexpected selected UID")
            self.requests.append(request)
            self.queue_full_budget -= 1
            return httpx.Response(429, content=QUEUE_FULL_BODY,
                                  headers={"content-type": "application/json"})
        return super().handle_upstream(request)

    def generation_uids(self):
        return [request.headers.get("x-user-id") for request in self.requests
                if request.url.path == "/v2/chat/completions"]

    def test_client_gets_503_with_short_retry_after(self):
        self.configure(profiles=("cn-cli",))
        self.allowed_profiles = {"cn-cli"}
        self.queue_full_budget = 1
        response = self.client.post("/v1/chat/completions", json=self.payload(stream=True))
        self.assertEqual(response.status_code, 503, response.text)
        self.assertEqual(response.headers.get("Retry-After"), "5")
        entry = self.entries["cn-cli"]
        self.assertEqual(entry["fail_until"], 0, "6021 不得熔断账号")
        self.assertEqual(self.pool._model_fail, {}, "6021 不得写模型软冷却")

    def test_queue_full_still_rotates_to_another_account(self):
        """方案 A：不罚号，但保留换号收益（FAILOVER_CODES 含 503）。"""
        self.configure()
        self.allowed_profiles = set(fixtures.PROFILES)
        self.queue_full_budget = 1
        with patch.dict(converter.CONFIG, {"failover_max": 1}):
            response = self.client.post("/v1/chat/completions", json=self.payload(stream=True))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("ok", response.text)
        uids = self.generation_uids()
        self.assertEqual(len(uids), 2, "应当恰好换号重放一次")
        self.assertEqual(len(set(uids)), 2, "重放必须换凭证")
        self.assertEqual(self.pool._model_fail, {}, "换号路径也不得留下模型冷却")

    def test_queue_full_exhausts_the_failover_budget_as_503(self):
        """全池都排队满时，最终对外仍是 503 + 5，而不是 429 + 600。"""
        self.configure()
        self.allowed_profiles = set(fixtures.PROFILES)
        self.queue_full_budget = 99
        with patch.dict(converter.CONFIG, {"failover_max": 2}):
            response = self.client.post("/v1/chat/completions", json=self.payload(stream=True))
        self.assertEqual(response.status_code, 503, response.text)
        self.assertEqual(response.headers.get("Retry-After"), "5")
        self.assertEqual(len(self.pool._model_fail), 0)
        self.assertIsNone(self.pool.model_cooldown_until("shared-model"))

    def test_real_account_429_still_reaches_the_client_as_429(self):
        """防改过头：真·账号级 429 仍要按 429 冷却。"""
        self.configure(profiles=("cn-cli",))
        self.allowed_profiles = {"cn-cli"}
        self.response_status = 429
        response = self.client.post("/v1/chat/completions", json=self.payload(stream=True))
        self.assertEqual(response.status_code, 429, response.text)
        self.assertEqual(len(self.pool._model_fail), 1)


if __name__ == "__main__":
    unittest.main()
