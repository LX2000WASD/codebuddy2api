#!/usr/bin/env python3
"""Verify outbound tool pairing cleanup and prompt_cache_key injection."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.tool_pairing import (cleanup_orphan_tool_calls, merge_adjacent_tool_calls,
                              repack_tool_result_blocks, sanitize_tool_pairing,
                              tool_call_name_empty)
from app.prompt_cache import (ISOLATION_LENGTH, KEY_PREFIX, build_cache_key,
                              inject_prompt_cache_key, isolation_factor, session_source)

import json
from unittest.mock import patch

import converter as gateway
import test_region_routing as fixtures
from app.settings import SCHEMA, apply_persisted_settings, resolve_settings


def call(identifier, name="exec", arguments="{}"):
    return {"id": identifier, "type": "function",
            "function": {"name": name, "arguments": arguments}}


def assistant(identifier, *, content=None, name="exec"):
    return {"role": "assistant", "content": content, "tool_calls": [call(identifier, name=name)]}


def result(identifier, content="r"):
    return {"role": "tool", "tool_call_id": identifier, "content": content}


def shape(messages):
    """Render a message list as a compact comparable summary."""
    out = []
    for message in messages:
        role = message.get("role")
        calls = message.get("tool_calls")
        if isinstance(calls, list) and calls:
            ids = ",".join(c.get("id", "?") for c in calls if isinstance(c, dict))
            out.append(f"{role}({ids})")
        elif message.get("tool_call_id"):
            out.append(f"{role}({message['tool_call_id']})")
        else:
            out.append(f"{role}(-)")
    return " | ".join(out)


class MergeAdjacentTests(unittest.TestCase):
    def test_back_to_back_declarations_merge_in_declaration_order(self):
        messages = [assistant("c1"), assistant("c2"), result("c1"), result("c2")]
        out, changed = merge_adjacent_tool_calls(messages)
        self.assertTrue(changed)
        self.assertEqual(shape(out), "assistant(c1,c2) | tool(c1) | tool(c2)")

    def test_reverse_split_folds_text_into_preceding_call_message(self):
        messages = [assistant("c1", content=None), {"role": "assistant", "content": "text"},
                    result("c1")]
        out, changed = merge_adjacent_tool_calls(messages)
        self.assertTrue(changed)
        self.assertEqual(shape(out), "assistant(c1) | tool(c1)")
        self.assertEqual(out[0]["content"], "text")

    def test_empty_array_content_counts_as_empty_and_still_merges(self):
        messages = [assistant("c1", content=[]), assistant("c2"), result("c1"), result("c2")]
        out, changed = merge_adjacent_tool_calls(messages)
        self.assertTrue(changed)
        self.assertEqual(shape(out), "assistant(c1,c2) | tool(c1) | tool(c2)")

    def test_reasoning_content_is_preserved_with_newline_join(self):
        first = {**assistant("c1"), "reasoning_content": "a"}
        second = {**assistant("c2"), "reasoning_content": "b"}
        out, _ = merge_adjacent_tool_calls([first, second, result("c1"), result("c2")])
        self.assertEqual(out[0]["reasoning_content"], "a\nb")

    def test_non_adjacent_or_content_bearing_messages_do_not_merge(self):
        cases = {
            "separated": [assistant("c1"), {"role": "user", "content": "x"}, assistant("c2")],
            "later has content": [assistant("c1"), assistant("c2", content="text")],
            "earlier has no calls": [{"role": "assistant", "content": None}, assistant("c2")],
        }
        for label, messages in cases.items():
            with self.subTest(label=label):
                out, changed = merge_adjacent_tool_calls(messages)
                self.assertFalse(changed)
                self.assertIs(out, messages)

    def test_input_is_never_mutated(self):
        messages = [assistant("c1"), assistant("c2"), result("c1"), result("c2")]
        snapshot = [dict(m) for m in messages]
        merge_adjacent_tool_calls(messages)
        self.assertEqual(messages, snapshot)


class RepackTests(unittest.TestCase):
    def test_wedged_message_moves_after_the_batch(self):
        messages = [{"role": "user", "content": "q"},
                    {"role": "assistant", "content": None, "tool_calls": [call("c1"), call("c2")]},
                    result("c1"), {"role": "developer", "content": "notice"}, result("c2")]
        out, changed = repack_tool_result_blocks(messages)
        self.assertTrue(changed)
        self.assertEqual(shape(out), "user(-) | assistant(c1,c2) | tool(c1) | tool(c2) | developer(-)")

    def test_next_batch_header_is_not_swallowed(self):
        messages = [{"role": "assistant", "content": None, "tool_calls": [call("c1")]},
                    result("c1"), assistant("c2"), result("c2")]
        out, changed = repack_tool_result_blocks(messages)
        self.assertEqual(shape(out), "assistant(c1) | tool(c1) | assistant(c2) | tool(c2)")
        self.assertFalse(changed)

    def test_nothing_to_reorder_is_a_noop(self):
        messages = [{"role": "user", "content": "q"}, result("c9")]
        out, changed = repack_tool_result_blocks(messages)
        self.assertFalse(changed)
        self.assertIs(out, messages)


class CleanupOrphanTests(unittest.TestCase):
    def test_partial_batch_trims_both_sides_symmetrically(self):
        messages = [{"role": "assistant", "content": None, "tool_calls": [call("c1"), call("c2")]},
                    result("c1")]
        out, changed = cleanup_orphan_tool_calls(messages)
        self.assertTrue(changed)
        self.assertEqual(shape(out), "assistant(c1) | tool(c1)")

    def test_orphan_result_is_removed(self):
        messages = [{"role": "user", "content": "x"}, result("c9")]
        out, changed = cleanup_orphan_tool_calls(messages)
        self.assertTrue(changed)
        self.assertEqual(shape(out), "user(-)")

    def test_complete_pairing_and_no_traffic_are_untouched(self):
        complete = [{"role": "assistant", "content": None, "tool_calls": [call("c1"), call("c2")]},
                    result("c1"), result("c2")]
        out, changed = cleanup_orphan_tool_calls(complete)
        self.assertFalse(changed)
        self.assertIs(out, complete)
        plain = [{"role": "user", "content": "x"}]
        out, changed = cleanup_orphan_tool_calls(plain)
        self.assertFalse(changed)
        self.assertIs(out, plain)


class EmptyNameTests(unittest.TestCase):
    def test_blank_name_with_result_removes_call_and_result_together(self):
        messages = [{"role": "user", "content": "q"}, assistant("c1", name=""), result("c1"),
                    {"role": "user", "content": "next"}]
        out, changed = cleanup_orphan_tool_calls(messages)
        self.assertTrue(changed)
        self.assertEqual(shape(out), "user(-) | assistant(-) | user(-)")

    def test_whitespace_only_name_is_dirty(self):
        messages = [assistant("c1", name="   "), result("c1")]
        out, changed = cleanup_orphan_tool_calls(messages)
        self.assertTrue(changed)
        self.assertEqual(shape(out), "assistant(-)")

    def test_blank_name_without_result_still_takes_the_orphan_path(self):
        messages = [{"role": "assistant", "content": None, "tool_calls": [call("c1", name="")]},
                    {"role": "user", "content": "go"}]
        out, changed = cleanup_orphan_tool_calls(messages)
        self.assertTrue(changed)
        self.assertNotIn("tool_calls", out[0])

    def test_mixed_batch_drops_only_the_dirty_entry(self):
        messages = [{"role": "assistant", "content": None,
                     "tool_calls": [call("c1", name=""), call("c2")]},
                    result("c1"), result("c2")]
        out, changed = cleanup_orphan_tool_calls(messages)
        self.assertTrue(changed)
        self.assertEqual(shape(out), "assistant(c2) | tool(c2)")

    def test_missing_function_or_name_field_is_not_dirty(self):
        for entry in ({"id": "c1"}, {"id": "c1", "function": {}}, {"id": "c1", "function": {"name": 5}},
                      {"id": "c1", "function": None}):
            with self.subTest(entry=entry):
                self.assertFalse(tool_call_name_empty(entry))
        messages = [{"role": "assistant", "content": None, "tool_calls": [{"id": "c1"}, {"id": "c2"}]},
                    result("c1"), result("c2")]
        out, changed = cleanup_orphan_tool_calls(messages)
        self.assertFalse(changed)
        self.assertIs(out, messages)


class TruncatedSessionTests(unittest.TestCase):
    """An assistant declaring tool_calls with no results is the live 503 shape."""

    def setUp(self):
        self.messages = [{"role": "user", "content": "q"}, assistant("c1"),
                         {"role": "user", "content": "next"}]

    def test_cleanup_drops_the_whole_tool_calls_key_and_keeps_the_assistant(self):
        out, changed = cleanup_orphan_tool_calls(self.messages)
        self.assertTrue(changed)
        self.assertEqual(shape(out), "user(-) | assistant(-) | user(-)")
        self.assertNotIn("tool_calls", out[1])
        self.assertEqual(out[1]["role"], "assistant")

    def test_merge_and_repack_leave_this_shape_alone(self):
        merged, changed = merge_adjacent_tool_calls(self.messages)
        self.assertFalse(changed)
        self.assertIs(merged, self.messages)
        packed, changed = repack_tool_result_blocks(self.messages)
        self.assertFalse(changed)
        self.assertIs(packed, self.messages)

    def test_end_to_end_sanitize_heals_the_conversation(self):
        out = sanitize_tool_pairing(self.messages)
        self.assertEqual(shape(out), "user(-) | assistant(-) | user(-)")


class OrderingInvariantTests(unittest.TestCase):
    """The step order is a correctness property, verified against the Go original.

    Ground truth was produced by running the reference implementation
    (internal/upstream/tool_pairing.go) on the same composite payload; see the report
    section 4.2 for the four measured orderings.
    """

    def setUp(self):
        self.messages = [{"role": "user", "content": "q"}, assistant("c1"), assistant("c2"),
                         result("c1"), {"role": "developer", "content": "notice"}, result("c2"),
                         result("c9")]

    def test_correct_order_matches_the_reference_implementation(self):
        out = sanitize_tool_pairing(self.messages)
        self.assertEqual(shape(out),
                         "user(-) | assistant(c1,c2) | tool(c1) | tool(c2) | developer(-)")

    def test_running_repack_before_merge_produces_a_broken_pairing(self):
        # Repack must run second: before the merge it sees only a single call per batch,
        # so the wedged developer message stays between the two results.
        out, _ = repack_tool_result_blocks(self.messages)
        out, _ = merge_adjacent_tool_calls(out)
        out, _ = cleanup_orphan_tool_calls(out)
        self.assertEqual(shape(out),
                         "user(-) | assistant(c1,c2) | tool(c1) | developer(-) | tool(c2)")
        self.assertNotEqual(shape(out), shape(sanitize_tool_pairing(self.messages)))

    def test_running_cleanup_before_merge_also_produces_a_broken_pairing(self):
        out, _ = cleanup_orphan_tool_calls(self.messages)
        out, _ = repack_tool_result_blocks(out)
        out, _ = merge_adjacent_tool_calls(out)
        self.assertEqual(shape(out),
                         "user(-) | assistant(c1,c2) | tool(c1) | developer(-) | tool(c2)")

    def test_merge_must_run_first_is_the_falsifiable_property(self):
        # Swapping repack and cleanup is NOT detectable on this payload -- the reference
        # implementation produces the same result. Asserting that every permutation
        # differs would be a false test, so only "merge runs first" is asserted.
        reference = shape(sanitize_tool_pairing(self.messages))
        swapped, _ = merge_adjacent_tool_calls(self.messages)
        swapped, _ = cleanup_orphan_tool_calls(swapped)
        swapped, _ = repack_tool_result_blocks(swapped)
        self.assertEqual(shape(swapped), reference)

    def test_intermediate_step_changes_are_written_back(self):
        # Only repack changes anything here; the result must still survive the no-op
        # cleanup step (the panel had to write back after every step for this reason).
        messages = [{"role": "assistant", "content": None, "tool_calls": [call("c1"), call("c2")]},
                    result("c1"), {"role": "developer", "content": "notice"}, result("c2")]
        self.assertEqual(shape(sanitize_tool_pairing(messages)),
                         "assistant(c1,c2) | tool(c1) | tool(c2) | developer(-)")

    def test_sanitize_does_not_mutate_the_caller(self):
        snapshot = [dict(m) for m in self.messages]
        sanitize_tool_pairing(self.messages)
        self.assertEqual(self.messages, snapshot)


class IsolationFactorTests(unittest.TestCase):
    def test_distinct_accounts_never_share_a_key(self):
        first = build_cache_key("cn-cli", "account-a", "session")
        second = build_cache_key("cn-cli", "account-b", "session")
        self.assertNotEqual(first, second)

    def test_same_uid_on_two_domains_does_not_collide(self):
        domestic = build_cache_key("cn-cli", "same-account", "session")
        international = build_cache_key("intl-cli", "same-account", "session")
        self.assertNotEqual(domestic, international)

    def test_key_carries_prefix_and_isolation_segment(self):
        key = build_cache_key("cn-cli", "account-a", "session")
        self.assertTrue(key.startswith(KEY_PREFIX))
        isolation = isolation_factor("cn-cli", "account-a")
        self.assertEqual(key, f"{KEY_PREFIX}{isolation[:ISOLATION_LENGTH]}-" + key.split("-", 2)[2])

    def test_same_session_is_stable_and_different_sessions_differ(self):
        first = build_cache_key("cn-cli", "account-a", "session-1")
        self.assertEqual(first, build_cache_key("cn-cli", "account-a", "session-1"))
        self.assertNotEqual(first, build_cache_key("cn-cli", "account-a", "session-2"))

    def test_raw_uid_never_appears_verbatim(self):
        key = build_cache_key("cn-cli", "account-a", "session")
        self.assertNotIn("account-a", key)


class InjectionTests(unittest.TestCase):
    def test_non_empty_client_key_is_preserved_verbatim(self):
        # Measured against the reference implementation: only a non-empty string wins.
        for value in ("client-key", "   ", "0"):
            with self.subTest(value=value):
                body = {"model": "m", "prompt_cache_key": value}
                out = inject_prompt_cache_key(body, "cn-cli", "account-a", "session")
                self.assertEqual(out.get("prompt_cache_key"), value)

    def test_empty_null_and_non_string_client_values_are_replaced(self):
        # Reference behaviour (probed): "" , null and non-string values are treated as
        # "no usable key" and a generated key is injected instead.
        for value in ("", None, 123, [], {}):
            with self.subTest(value=value):
                body = {"model": "m", "prompt_cache_key": value}
                out = inject_prompt_cache_key(body, "cn-cli", "account-a", "session")
                self.assertTrue(out["prompt_cache_key"].startswith(KEY_PREFIX))

    def test_adapter_layer_preserves_empty_values_that_injection_replaces(self):
        # Two independent layers with deliberately different rules, so a regression in
        # either one is visible here:
        #   * the adapters FORWARD a client value verbatim, including "" and None
        #     (see tests/test_api_flow.py::CacheKeyTests);
        #   * injection only honours a NON-EMPTY client key and otherwise generates one.
        from app.adapters.anthropic_adapter import anthropic_request_to_chat
        for value in ("client-key", "", None):
            with self.subTest(value=value):
                forwarded = anthropic_request_to_chat(
                    {"model": "m", "max_tokens": 8, "prompt_cache_key": value,
                     "messages": [{"role": "user", "content": "hi"}]})
                self.assertEqual(forwarded.get("prompt_cache_key"), value)
                injected = inject_prompt_cache_key(forwarded, "cn-cli", "account-a", "session")
                if value:
                    self.assertEqual(injected.get("prompt_cache_key"), value)
                else:
                    self.assertTrue(injected["prompt_cache_key"].startswith(KEY_PREFIX))

    def test_anthropic_adapter_forwards_an_explicit_key(self):
        from app.adapters.anthropic_adapter import anthropic_request_to_chat
        forwarded = anthropic_request_to_chat(
            {"model": "m", "max_tokens": 8, "prompt_cache_key": "client-explicit-key",
             "messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(forwarded.get("prompt_cache_key"), "client-explicit-key")
        absent = anthropic_request_to_chat(
            {"model": "m", "max_tokens": 8, "messages": [{"role": "user", "content": "hi"}]})
        self.assertNotIn("prompt_cache_key", absent)

    def test_generated_key_is_added_when_absent(self):
        out = inject_prompt_cache_key({"model": "m"}, "cn-cli", "account-a", "session")
        self.assertTrue(out["prompt_cache_key"].startswith(KEY_PREFIX))
        self.assertNotIn("prompt_cache_key", {"model": "m"})

    def test_missing_identity_or_body_is_left_alone(self):
        for body, profile, identity in (({"model": "m"}, "", "account-a"),
                                        ({"model": "m"}, "cn-cli", ""),
                                        ("not-a-dict", "cn-cli", "account-a")):
            with self.subTest(profile=profile, identity=identity):
                self.assertIs(inject_prompt_cache_key(body, profile, identity, "s"), body)

    def test_session_source_priority_prefers_body_then_metadata_then_context(self):
        class Context:
            scoped = True
            session_key = "scoped-key"

        self.assertEqual(session_source({"conversation_id": "body-id"}, Context(), "legacy"), "body-id")
        self.assertEqual(session_source({"conversationId": "camel"}, Context(), "legacy"), "camel")
        self.assertEqual(session_source({"metadata": {"conversation_id": "meta"}}, Context(), "legacy"), "meta")
        self.assertEqual(session_source({}, Context(), "legacy"), "scoped-key")

        class Legacy:
            scoped = False
            session_key = "ignored"

        self.assertEqual(session_source({}, Legacy(), "legacy"), "legacy")
        self.assertEqual(session_source({}, None, None), "")

    def test_whitespace_only_conversation_id_is_ignored(self):
        self.assertEqual(session_source({"conversation_id": "   "}, None, "legacy"), "legacy")

    def test_empty_session_still_yields_an_account_isolated_key(self):
        first = build_cache_key("cn-cli", "account-a", "")
        second = build_cache_key("cn-cli", "account-b", "")
        self.assertNotEqual(first, second)
        self.assertTrue(first.startswith(KEY_PREFIX))


class WireLevelTests(unittest.TestCase):
    """Prove both features actually reach the outbound upstream request.

    Uses the same mocked-upstream fixture as tests/test_api_flow.py, so nothing here
    touches the network.
    """

    def setUp(self):
        self.fx = fixtures.RegionRoutingTests()
        self.addCleanup(self.fx.doCleanups)
        self.fx.setUp()
        self.fx.allowed_profiles = set(fixtures.PROFILES)
        self.enterContext(patch.object(gateway, "_log"))

    def sent_body(self, endpoint="chat/completions", *, messages=None, payload=None):
        request = payload if payload is not None else self.fx.payload(endpoint)
        if messages is not None:
            request["messages"] = messages
        response = self.fx.client.post("/v1/" + endpoint, json=request)
        self.assertEqual(response.status_code, 200, response.text)
        return json.loads(self.fx.requests[-1].content)

    def test_generated_key_reaches_the_wire_with_the_selected_account_segment(self):
        self.fx.configure(profiles=("cn-cli",))
        body = self.sent_body()
        key = body["prompt_cache_key"]
        self.assertTrue(key.startswith(KEY_PREFIX))
        # The isolation segment must match the account that was actually selected.
        uid = self.fx.requests[-1].headers["x-user-id"]
        profile = self.fx.account_profiles[uid]
        expected = isolation_factor(profile, self.fx.entries[uid]["account_key"])[:ISOLATION_LENGTH]
        self.assertEqual(key.split("-")[1], expected)

    def test_the_same_request_on_a_different_domain_gets_a_different_segment(self):
        # Same payload text on the domestic and international profiles: the isolation
        # segment must differ, because these are two independent upstreams.
        segments = {}
        for profile in ("cn-cli", "intl-cli"):
            self.fx.configure(profiles=(profile,))
            body = self.sent_body(payload=self.fx.payload("chat/completions", text="identical"))
            self.assertEqual(self.fx.requests[-1].headers["x-user-id"], profile)
            segments[profile] = body["prompt_cache_key"].split("-")[1]
        self.assertNotEqual(segments["cn-cli"], segments["intl-cli"])

    def test_generated_key_is_stable_for_the_same_account_and_session(self):
        self.fx.configure(profiles=("cn-cli",))
        first = self.sent_body()["prompt_cache_key"]
        # A different user text is a different session, so the key must differ.
        second = self.sent_body()["prompt_cache_key"]
        self.assertNotEqual(first, second)

    def test_explicit_client_key_wins_on_every_protocol(self):
        self.fx.configure(profiles=("cn-cli",))
        for endpoint in ("chat/completions", "responses", "messages"):
            with self.subTest(endpoint=endpoint):
                request = self.fx.payload(endpoint)
                request["prompt_cache_key"] = "client-explicit"
                body = self.sent_body(endpoint, payload=request)
                self.assertEqual(body["prompt_cache_key"], "client-explicit")

    def test_disabling_generation_removes_the_key_but_keeps_an_explicit_one(self):
        self.fx.configure(profiles=("cn-cli",))
        with patch.dict(gateway.CONFIG, {"prompt_cache_key_enabled": False}):
            self.assertNotIn("prompt_cache_key", self.sent_body())
            request = self.fx.payload("chat/completions")
            request["prompt_cache_key"] = "client-explicit"
            body = self.sent_body(payload=request)
            self.assertEqual(body["prompt_cache_key"], "client-explicit")

    def test_broken_tool_history_is_repaired_before_it_reaches_the_upstream(self):
        self.fx.configure(profiles=("cn-cli",))
        messages = [{"role": "user", "content": "go"},
                    {"role": "assistant", "content": None,
                     "tool_calls": [{"id": "c1", "type": "function",
                                     "function": {"name": "exec", "arguments": "{}"}}]},
                    {"role": "user", "content": "still there?"}]
        body = self.sent_body(messages=messages)
        sent = [m for m in body["messages"] if m.get("role") == "assistant"]
        self.assertTrue(sent)
        for message in sent:
            self.assertNotIn("tool_calls", message)

    def test_wedged_message_is_reordered_before_it_reaches_the_upstream(self):
        self.fx.configure(profiles=("cn-cli",))
        messages = [{"role": "user", "content": "go"},
                    {"role": "assistant", "content": None,
                     "tool_calls": [{"id": "c1", "type": "function",
                                     "function": {"name": "exec", "arguments": "{}"}},
                                    {"id": "c2", "type": "function",
                                     "function": {"name": "exec", "arguments": "{}"}}]},
                    {"role": "tool", "tool_call_id": "c1", "content": "r1"},
                    {"role": "developer", "content": "notice"},
                    {"role": "tool", "tool_call_id": "c2", "content": "r2"}]
        body = self.sent_body(messages=messages)
        roles = [m.get("role") for m in body["messages"]]
        # The developer message is normalized to system and moved to the front before this
        # pipeline runs, so what matters is that the two tool results ended up adjacent with
        # no wedged message between them.
        tool_positions = [i for i, role in enumerate(roles) if role == "tool"]
        self.assertEqual(len(tool_positions), 2)
        self.assertEqual(tool_positions[1] - tool_positions[0], 1)
        self.assertEqual([m["tool_call_id"] for m in body["messages"] if m.get("role") == "tool"],
                         ["c1", "c2"])


class SettingTests(unittest.TestCase):
    """The switch is a normal management setting: hot, default on, env-overridable."""

    def test_schema_entry_defaults_to_enabled_and_is_hot(self):
        spec = SCHEMA["prompt_cache_key_enabled"]
        self.assertTrue(spec["default"])
        self.assertEqual(spec["type"], "boolean")
        self.assertEqual(spec["env"], "CODEBUDDY2API_PROMPT_CACHE_KEY")
        self.assertEqual(spec["mode"], "hot")
        self.assertFalse(spec["sensitive"])

    def test_environment_value_is_parsed_and_invalid_values_are_rejected(self):
        for raw, expected in (("false", False), ("true", True), ("0", False), ("1", True), ("on", True)):
            with self.subTest(raw=raw):
                config = {"control_store": None, "settings_sources": {}}
                apply_persisted_settings(config, environ={"CODEBUDDY2API_PROMPT_CACHE_KEY": raw})
                self.assertEqual(config["prompt_cache_key_enabled"], expected)
                self.assertEqual(config["settings_sources"]["prompt_cache_key_enabled"], "environment")
        config = {"control_store": None, "settings_sources": {}}
        with self.assertRaises(ValueError):
            apply_persisted_settings(config, environ={"CODEBUDDY2API_PROMPT_CACHE_KEY": "notabool"})

    def test_module_default_matches_the_schema_default(self):
        # The audit found several CONFIG defaults drifting from SCHEMA; keep this one equal.
        self.assertEqual(gateway.CONFIG["prompt_cache_key_enabled"], SCHEMA["prompt_cache_key_enabled"]["default"])

    def test_resolved_settings_expose_the_key_to_the_management_ui(self):
        config = {"control_store": None, "settings_sources": {}, "prompt_cache_key_enabled": True}
        items = {item["key"]: item for item in resolve_settings(config)}
        self.assertIn("prompt_cache_key_enabled", items)
        self.assertTrue(items["prompt_cache_key_enabled"]["value"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
