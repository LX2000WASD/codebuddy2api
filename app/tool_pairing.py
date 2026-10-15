"""Outbound tool_call/tool result pairing cleanup for OpenAI-compatible upstreams.

Ported from the panel gateway (`internal/upstream/tool_pairing.go`, reference repo
`linguo2625469/workbuddy2api-panel` @ 6b31db6). The OpenAI-compatible protocol requires
every `assistant.tool_calls[i]` to have a matching `role:tool` result message, and every
`role:tool` message to have a preceding `tool_call`. Either half missing makes the upstream
reject the whole request (CodeBuddy codes 11133 / 11148), and because clients replay the bad
history on every turn, a single broken turn poisons the entire conversation.

This module is the gateway's last line of defence: entries that cannot be paired are removed
before the request goes out, so the conversation heals instead of dying. Losing one turn of
tool context is strictly better than losing the whole conversation.

Ordering invariant (panel `payload.go:64-71`; verified against the real Go implementation,
see the report section 4.2)::

    merge_adjacent_tool_calls  ->  repack_tool_result_blocks  ->  cleanup_orphan_tool_calls

`merge_adjacent_tool_calls` must run first: it folds back-to-back `assistant.tool_calls`
messages into one, which is the direct fix for upstream code 11148. Only after merging can
`repack_tool_result_blocks` see the complete batch of calls. Measured on the reference
implementation, running repack before merge leaves a non-tool message wedged between two tool
results -- exactly the broken-pairing shape the upstream rejects.

A second invariant: every step must be written back, not just the last one. Each function
returns a new list whenever it changed anything, and :func:`sanitize_tool_pairing` always
re-assigns, so a reorder that is later undone by a no-op step can never be lost.

All functions are pure and copy-on-write: they never mutate the caller's messages.
"""

from __future__ import annotations


def _empty_content(value) -> bool:
    """Whether a message `content` counts as absent.

    A missing/nil value, an empty string and an empty array all count as empty. The empty
    array matters: some clients send `content: []` instead of `null` for "no text", and
    treating that as non-empty used to stop back-to-back `assistant.tool_calls` from
    merging, which the upstream rejects. A non-empty array still counts as content -- we
    would rather skip a merge than drop content.
    """
    if value is None:
        return True
    if isinstance(value, str):
        return value == ""
    if isinstance(value, list):
        return len(value) == 0
    return False


def tool_call_name_empty(tool_call) -> bool:
    """Whether an `assistant.tool_calls[i]` entry carries a blank `function.name`.

    Deliberately narrow: true only when `function` is an object, the `name` field is
    present and it is a blank string. A missing `function` object or a missing `name`
    field is *not* dirty -- historical payloads contain placeholder entries without a
    `function`, the upstream does not reject those, and widening the test would delete
    pairings that are actually fine.
    """
    function = tool_call.get("function")
    if not isinstance(function, dict):
        return False
    name = function.get("name")
    if not isinstance(name, str):
        return False
    return name.strip() == ""


def _merge_reasoning_content(dst: dict, src: dict) -> None:
    """Fold `src` reasoning_content into `dst`, joining with a newline when both exist.

    DeepSeek multi-turn requests require the assistant message to carry its reasoning
    back, so dropping this during a merge would trade one upstream error for another.
    """
    incoming = src.get("reasoning_content")
    if not isinstance(incoming, str) or incoming == "":
        return
    existing = dst.get("reasoning_content")
    if isinstance(existing, str) and existing != "":
        dst["reasoning_content"] = existing + "\n" + incoming
    else:
        dst["reasoning_content"] = incoming


def merge_adjacent_tool_calls(messages):
    """Merge back-to-back `assistant.tool_calls` messages into one (tool_calls concatenated).

    Some OpenAI-compatible agent clients replay a parallel tool batch as several adjacent
    assistant messages::

        assistant tool_calls=[c00]
        assistant tool_calls=[c01]
        tool c00
        tool c01

    The upstream requires an assistant declaring tool_calls to be followed by *its own*
    results, so the shape above is rejected (code 11148) and the conversation is poisoned.
    Folding the declarations into one message restores the accepted shape.

    Merging stays deliberately conservative so it cannot invent semantics:

    * the two messages must be **adjacent** -- anything in between means they are not the
      same batch declaration, and that shape is left to :func:`repack_tool_result_blocks`;
    * the later message must have empty content (non-empty content cannot be concatenated
      losslessly, so we do not guess);
    * the earlier message must itself be an assistant carrying tool_calls.

    The reverse split (a plain-text assistant following a tool_calls assistant) is folded
    the other way, so the invariant holds under either client ordering.
    """
    if len(messages) < 2:
        return messages, False
    out = []
    changed = False
    for message in messages:
        if isinstance(message, dict) and message.get("role") == "assistant" and out:
            calls = message.get("tool_calls")
            previous = out[-1]
            if (isinstance(calls, list) and calls and _empty_content(message.get("content"))
                    and isinstance(previous, dict) and previous.get("role") == "assistant"):
                previous_calls = previous.get("tool_calls")
                if isinstance(previous_calls, list) and previous_calls:
                    merged = dict(previous)
                    merged["tool_calls"] = [*previous_calls, *calls]
                    _merge_reasoning_content(merged, message)
                    out[-1] = merged
                    changed = True
                    continue
            # Reverse split: fold plain text into a preceding tool_calls assistant that has
            # no content of its own. Only a string body qualifies -- an array body may hold
            # multimodal blocks and concatenating it would lose structure.
            if "tool_calls" not in message:
                text = message.get("content")
                if isinstance(text, str) and text != "" and isinstance(previous, dict) \
                        and previous.get("role") == "assistant":
                    previous_calls = previous.get("tool_calls")
                    if (isinstance(previous_calls, list) and previous_calls
                            and _empty_content(previous.get("content"))):
                        merged = dict(previous)
                        merged["content"] = text
                        _merge_reasoning_content(merged, message)
                        out[-1] = merged
                        changed = True
                        continue
        out.append(message)
    if not changed:
        return messages, False
    return out, True


def repack_tool_result_blocks(messages):
    """Move non-tool messages that sit between a tool batch's results to after the batch.

    Codex's `image_resize_notice` feature injects a developer/system message after tool
    output; with parallel calls it lands *between* two results::

        assistant tool_calls=[c00 c01]
        tool c00
        developer <image_resize_notice>   <- wedged in the middle
        tool c01

    The upstream reads any message between an assistant and its results as a broken pairing
    (code 11148) and kills the conversation. This only reorders, never edits::

        assistant tool_calls=[c00 c01] | tool c00 | X | tool c01
        -> assistant tool_calls=[c00 c01] | tool c00 | tool c01 | X

    Result order is preserved (the original relative order of a batch is the result order),
    so no new ordering sensitivity is introduced. With nothing wedged in, this is a no-op
    and returns the original list.
    """
    if len(messages) < 3:
        return messages, False
    out = []
    changed = False
    index, total = 0, len(messages)
    while index < total:
        message = messages[index]
        if not isinstance(message, dict) or message.get("role") != "assistant":
            out.append(message)
            index += 1
            continue
        calls = message.get("tool_calls")
        if not isinstance(calls, list) or not calls:
            out.append(message)
            index += 1
            continue
        wanted = {call.get("id") for call in calls
                  if isinstance(call, dict) and isinstance(call.get("id"), str) and call.get("id")}
        out.append(message)
        index += 1
        results, between, saw_non_tool = [], [], False
        while index < total:
            candidate = messages[index]
            if not isinstance(candidate, dict):
                break
            role = candidate.get("role")
            if role == "tool":
                if candidate.get("tool_call_id") not in wanted:
                    break
                results.append(candidate)
                if saw_non_tool:
                    changed = True
                index += 1
                continue
            if not results:
                break  # No results after the assistant: leave it to cleanup_orphan_tool_calls.
            # A following assistant.tool_calls message is the next batch header, never a
            # wedged-in message: swallowing it here would stop the outer loop from treating
            # it as a header, so its own results would never be repacked.
            if role == "assistant":
                following = candidate.get("tool_calls")
                if isinstance(following, list) and following:
                    break
            between.append(candidate)
            saw_non_tool = True
            index += 1
        out.extend(results)
        out.extend(between)
    if not changed:
        return messages, False
    return out, True


def cleanup_orphan_tool_calls(messages):
    """Drop tool_calls and tool results that cannot be paired, using one shared decision.

    Collects every `role:tool` `tool_call_id` (results) and every
    `assistant.tool_calls[].id` (calls), then keeps a call only when it has a result *and*
    its `function.name` is not blank. Both sides are trimmed by that same set, so a batch
    is never left half-paired.

    Trimming symmetrically matters: an older implementation kept a whole batch only when
    every id in it was answered, which left orphan results behind (batch [c1,c2] answered
    only for c1 produced "an assistant with no tool_calls plus an orphan tool"), and the
    upstream rejected that too. A blank `function.name` is vetoed here for the same reason:
    such an entry is rejected whether or not it has a result, and an entry *with* a result
    used to pass straight through -- that was the live 503 cause.

    With no tool traffic at all the original list is returned unchanged.
    """
    if not messages:
        return messages, False
    call_ids, result_ids, blank_name_ids = set(), set(), set()
    has_traffic = False
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role == "tool":
            identifier = message.get("tool_call_id")
            if isinstance(identifier, str) and identifier:
                result_ids.add(identifier)
                has_traffic = True
        elif role == "assistant":
            calls = message.get("tool_calls")
            if isinstance(calls, list):
                for call in calls:
                    if not isinstance(call, dict):
                        continue
                    identifier = call.get("id")
                    if isinstance(identifier, str) and identifier:
                        call_ids.add(identifier)
                        # Register the id even when the name is blank: dropping it here
                        # would flip has_traffic to false for a blank-name batch with no
                        # results, and that dirty entry would leak out instead of being
                        # removed by the orphan rule.
                        if tool_call_name_empty(call):
                            blank_name_ids.add(identifier)
                        has_traffic = True
    if not has_traffic:
        return messages, False
    keep_calls = {identifier for identifier in call_ids
                  if identifier not in blank_name_ids and identifier in result_ids}
    changed = False
    trimmed = []
    for message in messages:
        if isinstance(message, dict) and message.get("role") == "assistant":
            calls = message.get("tool_calls")
            if isinstance(calls, list) and calls:
                kept = [call for call in calls
                        if isinstance(call, dict) and call.get("id") in keep_calls]
                if len(kept) != len(calls):
                    changed = True
                    replacement = dict(message)
                    if kept:
                        replacement["tool_calls"] = kept
                    else:
                        replacement.pop("tool_calls", None)
                    trimmed.append(replacement)
                    continue
        trimmed.append(message)
    kept_messages = []
    for message in trimmed:
        if isinstance(message, dict) and message.get("role") == "tool":
            if message.get("tool_call_id") not in keep_calls:
                changed = True
                continue
        kept_messages.append(message)
    if not changed:
        return messages, False
    return kept_messages, True


def sanitize_tool_pairing(messages):
    """Apply the three-step cleanup in its one correct order and always write back.

    Every step is chained, so a change made by an intermediate step survives even when a
    later step is a no-op. That is the second half of the panel's ordering invariant: the
    Go original had to remember to assign `obj["messages"]` even when only `repack` had
    changed, because otherwise the repacked result was overwritten by the original slice.

    Input is never mutated; a new list is returned when anything changed.
    """
    if not isinstance(messages, list) or not messages:
        return messages
    messages, _ = merge_adjacent_tool_calls(messages)
    messages, _ = repack_tool_result_blocks(messages)
    messages, _ = cleanup_orphan_tool_calls(messages)
    return messages
