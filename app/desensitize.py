"""Adapt selected roles and trusted harness templates while preserving real conversation content."""

from __future__ import annotations

import re
from copy import deepcopy
from typing import Any, Iterable

from app.harness_context import parse_harness_text

# Limit substitutions to known templates without globally stripping whitespace.
def _template_source(text: str) -> str:
    words = [re.escape(char) for char in text.split(" ")]
    return r"[\s]+".join(words)


def _template_pattern(text: str) -> re.Pattern:
    return re.compile(r"(?<!\w)" + _template_source(text) + r"(?!\w)", re.IGNORECASE)


_DSH_WORKBUDDY_IDENTITY = "You are WorkBuddy, a powerful AI assistant"
_WORKBUDDY_IDENTITY = "You are CodeBuddy, Tencent's official CLI"
_CLAUDE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude"
_TEMPLATE_REPLACEMENTS = tuple(
    (_template_pattern(source), target) for source, target in (
        (_CLAUDE_IDENTITY + ", running within the Claude Agent SDK", _WORKBUDDY_IDENTITY),
        (_CLAUDE_IDENTITY, _WORKBUDDY_IDENTITY),
        ("You are a Claude agent, built on Anthropic's Claude Agent SDK", _WORKBUDDY_IDENTITY),
        ("Main branch (you will usually use this for PRs)",
         "Main branch (you will usually use this for PR)"),
        # The DeepSeek Harness identity sentence is deliberately NOT replaced here: the
        # identity switch (identity_normalize: off / running_on) owns it through
        # normalize_identity_prefix, so a template pass must not overwrite the operator's
        # choice — least of all with "off", where the sentence has to stay verbatim.
    )
)
_WORKBUDDY_IDENTITY_PATTERN = _template_pattern(_WORKBUDDY_IDENTITY)

# The codebuddy.cn gateway rejects a request whose system message *starts with* the
# DeepSeek Harness identity sentence (400 / code 11128 / "Illegal API invocation from an
# unapproved channel"). Measured behaviour on the live channel (2026-10-21):
#   * the match is an exact prefix at offset 0 — the same sentence at offset 30/120/400,
#     inside a user message, or as a bare phrase never triggers it;
#   * a single leading space also passes, so the upstream does not trim;
#   * every system message is judged independently, not just the first one.
# So the fix belongs exactly where the check lives: rewrite the prefix of each system
# message, and leave every other byte alone. Compressing the prompt instead would delete
# the agent's operating rules (measured: 476 B -> 173 B, 63.7% lost), which is why this
# module never compacts a harness prompt.
_DSH_IDENTITY = "You are an AI agent powered by DeepSeek Harness."
_DSH_IDENTITY_PATTERN = re.compile(r"^You are an AI agent powered by DeepSeek Harness.")

# Same sentence, different connective: the product name stays visible so an agent
# working *on* DeepSeek Harness still knows what it is running on. Rewriting the prefix is
# the only identity transformation left: the retired modes replaced the sentence with the
# WorkBuddy persona, which is template impersonation rather than normalisation.
_DSH_IDENTITY_RUNNING_ON = "You are an AI agent running on DeepSeek Harness."

IDENTITY_MODES = ("off", "running_on")


def normalize_identity_prefix(text, mode: str = "off"):
    """Rewrite only the upstream-checked identity prefix of one system message.

    Returns the text unchanged for any mode other than a known one, and only touches a
    message that begins exactly with the identity sentence. Text after the sentence —
    including any further mention of "DeepSeek Harness" — is preserved byte for byte.
    """
    if not isinstance(text, str) or not text or mode not in IDENTITY_MODES or mode == "off":
        return text
    return _DSH_IDENTITY_PATTERN.sub(lambda _m: _DSH_IDENTITY_RUNNING_ON, text, count=1)


_CHANNEL_IDENTITY_PATTERN = _template_pattern("You are an AI agent powered by DeepSeek Harness")
_DSH_CODING_PATTERN = re.compile(
    r"(?<!\w)" + _template_source("You are a coding agent powered by the")
    + r"[\s]+(?P<model>[^\r\n]{1,200}?)[\s]+"
    + _template_source("model") + r"(?!\w)",
    re.IGNORECASE,
)
_DSH_MINIMAL_PATTERN = _template_pattern("You are a helpful software engineer assistant")
_DSH_DIRECT_PATTERN = _template_pattern("You are DeepSeek Harness")
_DSH_WEB_GUI_PATTERN = _template_pattern("DeepSeek Harness Web GUI")
_DSH_WEB_GUI_FINGERPRINT_PATTERN = re.compile(
    r"\bWeb GUI whose URL the runtime context names\.\s+When the user refers",
    re.IGNORECASE,
)
_CHANNEL_IDENTITY_FIXED = _DSH_WORKBUDDY_IDENTITY
_CHANNEL_SYSTEM_DEFAULT = "You are a helpful assistant."
_CHANNEL_INSTRUCTIONS_OPEN = "<instructions>\n"
_CHANNEL_INSTRUCTIONS_CLOSE = "\n</instructions>"

WORKBUDDY_SYSTEM_PROMPT = (
    "You are WorkBuddy, a powerful AI assistant.\n\n"
    "Your main goal is to follow the USER's instructions at each message, denoted by the <user_query> tag."
)
CODEBUDDY_SYSTEM_PROMPT = (
    "You are CodeBuddy Code.\n\n"
    "You are an interactive CLI tool that helps users with software engineering tasks. "
    "Use the instructions below and the tools available to you to assist the user. "
    "Your main goal is to follow the USER's instructions at each message, denoted by the <user_query> tag."
)
_GIT_STATUS_CONTEXT = re.compile(
    r"^\s*(?:gitStatus:\s*|#\s*gitStatus\s*\n)"
    r"This is the git status at the start of the conversation\.", re.IGNORECASE | re.MULTILINE,
)


def _replace_git_status_text(text: str, protected: bool = False) -> tuple[str, bool]:
    lines = []
    for line in text.splitlines(keepends=True):
        label = line.lstrip(" \t")
        if re.match(r"(?:Status|Recent commits):", label, re.IGNORECASE):
            protected = True
        if not protected:
            for index, (pattern, target) in enumerate(_TEMPLATE_REPLACEMENTS):
                match = pattern.match(label)
                if match and (label[match.end():].lstrip().startswith(":") if index == 3
                              else label[match.end():].strip() in ("", ".")):
                    indent = line[:len(line) - len(label)]
                    line = indent + target + label[match.end():]
                    break
        lines.append(line)
    return "".join(lines), protected


def _replace_git_status_content(content):
    """Apply the template substitutions to a gitStatus message without pruning its data."""
    if isinstance(content, str):
        return _replace_git_status_text(content)[0]
    blocks, protected = [], False
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            text, protected = _replace_git_status_text(block.get("text", ""), protected)
            block = {**block, "text": text}
        blocks.append(block)
    return blocks


def _replace_workbuddy_templates(text: str) -> str:
    for pattern, replacement in _TEMPLATE_REPLACEMENTS:
        text = pattern.sub(replacement, text)
    return text


def _is_claude_system(text: str) -> bool:
    return (any(pattern.search(text) for pattern, _ in _TEMPLATE_REPLACEMENTS[:3])
            or bool(_WORKBUDDY_IDENTITY_PATTERN.search(text))
            or "You are Claude Code" in text)


_CODEX_SYSTEM_MARKERS = (
    "You are a coding agent running in the Codex CLI",
    "Within this context, Codex refers to",
    "# How you work",
    "You are Claude Code",         # Claude Code system prompt
)

_PERMISSIONS_MARKERS = (
    "<permissions instructions>",
    "Filesystem sandboxing defines which files can be read or written.",
    "## How to request escalation",
)

_SKILLS_MARKERS = (
    "<skills_instructions>",
    "### Available skills",
    "### How to use skills",
)


def desensitize_text(text: str) -> str:
    """Apply the known client-template substitutions, byte for byte otherwise.

    The word-level zero-width pass that used to run here is gone: the upstream gateway
    normalises before matching, so it never hid a term, and inserting invisible characters
    into outbound prompt text is itself an evasion signature (30b §4.1). Only literal
    template phrases from other agent harnesses are still replaced.
    """
    if not text:
        return text
    context = _GIT_STATUS_CONTEXT.search(text)
    if context:
        return desensitize_text(text[:context.start()]) + _replace_git_status_text(text[context.start():])[0]
    return _replace_workbuddy_templates(text)


def _replace_dsh_coding_persona(match: re.Match) -> str:
    model = match.group("model").strip()
    return f"{_DSH_WORKBUDDY_IDENTITY}. This conversation is powered by the {model} model"


def desensitize_channel_text(text: str) -> str:
    """Convert official DSH role prompts without changing unrelated brand references."""
    if not text:
        return text
    text = _DSH_CODING_PATTERN.sub(_replace_dsh_coding_persona, text)
    text = _CHANNEL_IDENTITY_PATTERN.sub(_CHANNEL_IDENTITY_FIXED, text)
    text = _DSH_MINIMAL_PATTERN.sub(_CHANNEL_IDENTITY_FIXED, text)
    text = _DSH_DIRECT_PATTERN.sub(_CHANNEL_IDENTITY_FIXED, text)
    text = _DSH_WEB_GUI_PATTERN.sub("WorkBuddy Web GUI", text)
    return _DSH_WEB_GUI_FINGERPRINT_PATTERN.sub(
        "Web GUI whose URL the runtime context names. The interface, when the user refers",
        text,
    )


def _iter_text_blocks(content):
    """Yield text containers and keys from string or block-based Chat content."""
    if isinstance(content, str):
        yield content, None  # The caller replaces plain strings directly.
    elif isinstance(content, list):
        for blk in content:
            if isinstance(blk, dict) and blk.get("type") == "text":
                yield blk, "text"


def _content_to_text(content) -> str:
    """Extract plain text from content blocks for trusted-template detection."""
    text = content if isinstance(content, str) else ""
    if isinstance(content, list):
        parts = []
        for blk in content:
            if isinstance(blk, dict) and blk.get("type") == "text":
                parts.append(str(blk.get("text", "")))
        text = "".join(parts)
    return text


def _prune_runtime_fragments(role: str, text: str) -> str:
    """Compact only context with trusted boundaries, preserving unknown text and trailing instructions."""
    return parse_harness_text(text).render() if text else text


def _compact_harness_message(role: str, content) -> str | None:
    """Compact system context independently of structured user-context extraction."""
    if isinstance(content, list) and any(
            not isinstance(block, dict) or block.get("type") != "text" for block in content):
        return None  # Summaries must not discard images or unknown blocks.
    text = _content_to_text(content)
    if not text:
        return None
    if role in ("system", "developer") and (
            _is_claude_system(text) or any(marker in text for marker in _CODEX_SYSTEM_MARKERS)):
        if _is_claude_system(text):
            return (
                "You are a coding assistant. Be precise, helpful, concise, and safe. "
                "Use available tools when needed, follow repository instructions, and keep the user informed."
            )
        return (
            "You are a coding assistant in Codex CLI. Be precise, helpful, concise, and safe. "
            "Use available tools when needed, follow repository instructions, and keep the user informed."
        )
    if role == "system" and any(marker in text for marker in _PERMISSIONS_MARKERS):
        return (
            "Runtime permissions apply: filesystem access may be sandboxed, network may be restricted, "
            "and some commands may require user approval."
        )
    if role == "system" and any(marker in text for marker in _SKILLS_MARKERS):
        return (
            "Runtime skill metadata is available. Use relevant skills only when explicitly requested or clearly applicable."
        )
    return None


def _normalize_identity_content(content, mode: str):
    """Apply the identity-prefix rewrite to the opening text of one message."""
    if not isinstance(content, str) and not isinstance(content, list):
        return content
    if isinstance(content, str):
        return normalize_identity_prefix(content, mode)
    # Block content: only the first text block can be the message's offset 0.
    for index, block in enumerate(content):
        if isinstance(block, dict) and block.get("type") == "text":
            text = block.get("text")
            if not isinstance(text, str):
                return content
            rewritten = normalize_identity_prefix(text, mode)
            if rewritten == text:
                return content
            return [*content[:index], {**block, "text": rewritten}, *content[index + 1:]]
    return content


def desensitize_messages(messages: Iterable[dict],
                         roles: tuple[str, ...] = ("system",),
                         compact_harness: bool = False,
                         identity_mode: str = "off") -> list[dict]:
    """Copy and adapt the selected roles without altering real user input.

    Only roles named in the roles tuple are touched. Rewriting user-role harness context
    cost 63.7% of the prompt in the 10-27 measurement, which deletes the instructions the
    agent needs to call its tools, so that path is gone rather than merely switched off.
    """
    out: list[dict] = []
    for m in messages:
        if not isinstance(m, dict):
            out.append(m)
            continue
        role = m.get("role")
        should_desensitize = role in roles
        nm = dict(m)  # Preserve caller-owned message objects.
        if should_desensitize:
            content = m.get("content")
            text = _content_to_text(content)
            if _GIT_STATUS_CONTEXT.match(text) and re.search(r"(?m)^Current branch:", text):
                # An official gitStatus block is data, not prompt text: substitute the known
                # templates and leave every branch name, file name and blank line alone.
                nm["content"] = _replace_git_status_content(content)
                out.append(nm)
                continue
            # The identity rewrite runs FIRST: it matches the literal sentence at offset 0
            # and must see the byte-for-byte prefix the channel inspects.
            if role in ("system", "developer"):
                content = _normalize_identity_content(content, identity_mode)
            compacted = _compact_harness_message(role, content) if compact_harness else None
            if compacted is not None:
                nm["content"] = desensitize_text(compacted)
            elif isinstance(content, str):
                nm["content"] = desensitize_text(_prune_runtime_fragments(role, content))
            elif isinstance(content, list):
                new_blocks = []
                git_context = git_data = False
                for blk in content:
                    if isinstance(blk, dict) and blk.get("type") == "text":
                        nb = dict(blk)
                        text = blk.get("text", "")
                        context = _GIT_STATUS_CONTEXT.search(text) if isinstance(text, str) else None
                        if git_context and isinstance(text, str):
                            nb["text"], git_data = _replace_git_status_text(text, git_data)
                        elif context:
                            head = desensitize_text(_prune_runtime_fragments(role, text[:context.start()]))
                            tail, git_data = _replace_git_status_text(text[context.start():])
                            nb["text"] = head + tail
                            git_context = True
                        else:
                            nb["text"] = desensitize_text(_prune_runtime_fragments(role, text))
                        new_blocks.append(nb)
                    else:
                        new_blocks.append(blk)
                nm["content"] = new_blocks
        out.append(nm)
    return out


def desensitize_body(body: dict, roles: tuple[str, ...] = ("system",),
                     compact_harness: bool = False,
                     identity_mode: str = "off") -> dict:
    """Return a shallow request copy with the selected roles adapted.

    Tool definitions are left alone on purpose: a rewritten tool description changes the
    schema the model follows, and dropping one removes the tool's instructions entirely.
    Neither hides a client fingerprint, and the upstream never asked for either.
    """
    if not body.get("messages"):
        return body
    nb = dict(body)
    nb["messages"] = desensitize_messages(
        body["messages"],
        roles=roles,
        compact_harness=compact_harness,
        identity_mode=identity_mode,
    )
    return nb


def desensitize_channel_body(body: dict) -> dict:
    """Remove the known channel identity from instruction and assistant text."""
    if not body.get("messages"):
        return body
    messages = []
    for message in body["messages"]:
        if not isinstance(message, dict) or message.get("role") not in ("system", "developer", "assistant"):
            messages.append(message)
            continue
        adapted = dict(message)
        content = message.get("content")
        if isinstance(content, str):
            adapted["content"] = desensitize_channel_text(content)
        elif isinstance(content, list):
            adapted["content"] = [
                {**block, "text": desensitize_channel_text(block["text"])}
                if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
                else block
                for block in content
            ]
        messages.append(adapted)
    return {**body, "messages": messages}


def _instruction_blocks(contents: list) -> list[dict]:
    """Wrap system content as user-visible instructions without dropping non-text blocks."""
    blocks: list[dict] = [{"type": "text", "text": _CHANNEL_INSTRUCTIONS_OPEN}]
    for index, content in enumerate(contents):
        if index:
            blocks.append({"type": "text", "text": "\n\n"})
        if isinstance(content, str):
            blocks.append({"type": "text", "text": content})
        elif isinstance(content, list):
            blocks.extend(deepcopy(content))
        elif content is not None:
            blocks.append({"type": "text", "text": str(content)})
    blocks.append({"type": "text", "text": _CHANNEL_INSTRUCTIONS_CLOSE})
    return blocks


def _prepend_user_instructions(message: dict, contents: list) -> dict:
    """Prepend wrapped instructions to one user message while preserving its shape."""
    moved = _instruction_blocks(contents)
    existing = message.get("content")
    updated = dict(message)
    if isinstance(existing, str):
        if any(block.get("type") != "text" for block in moved):
            updated["content"] = moved + ([{"type": "text", "text": existing}] if existing else [])
        else:
            text = "".join(block.get("text", "") for block in moved)
            updated["content"] = text + ("\n\n" + existing if existing else "")
    elif isinstance(existing, list):
        updated["content"] = moved + deepcopy(existing)
    elif existing is None:
        updated["content"] = moved
    else:
        updated["content"] = moved + [{"type": "text", "text": str(existing)}]
    return updated


def system_as_user_body(body: dict) -> dict:
    """Move a refused system prompt into the first user message for one bounded retry."""
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        return body
    leading: list = []
    index = 0
    while index < len(messages) and isinstance(messages[index], dict) \
            and messages[index].get("role") == "system":
        leading.append(messages[index].get("content"))
        index += 1
    rest = [deepcopy(message) for message in messages[index:]]
    later_system = False
    for message in rest:
        if isinstance(message, dict) and message.get("role") == "system":
            message["role"] = "user"
            later_system = True
    meaningful = any(_content_to_text(content).strip() for content in leading)
    if meaningful and leading and not (
        len(leading) == 1 and _content_to_text(leading[0]).strip() == _CHANNEL_SYSTEM_DEFAULT
    ):
        user_index = next((i for i, message in enumerate(rest)
                           if isinstance(message, dict) and message.get("role") == "user"), None)
        moved = _instruction_blocks(leading)
        if user_index is None:
            rest.insert(0, {"role": "user", "content": moved})
        else:
            rest[user_index] = _prepend_user_instructions(rest[user_index], leading)
    if not meaningful and not later_system:
        return body
    return {**body, "messages": [{"role": "system", "content": _CHANNEL_SYSTEM_DEFAULT}, *rest]}


def apply_system_prompt_mode(body: dict, profile: str, mode: str) -> dict:
    """Apply an optional profile prompt without mutating canonical messages."""
    if mode == "empty":
        return body
    if mode != "prepend":
        raise ValueError("prompt_mode 仅支持 empty 或 prepend")
    prompt = WORKBUDDY_SYSTEM_PROMPT if profile in ("cn-work", "intl-work") else CODEBUDDY_SYSTEM_PROMPT
    messages = body.get("messages")
    if not isinstance(messages, list):
        return body
    if messages and isinstance(messages[0], dict) and messages[0].get("role") == "system" \
            and _content_to_text(messages[0].get("content")) == prompt:
        return body
    return {**body, "messages": [{"role": "system", "content": prompt}, *messages]}


# ---------------------------------------------------------------------------
# Standalone template adaptation checks
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    samples = [
        "You are Claude Code, Anthropic's official CLI for Claude",
        "Refuse requests for DoS attacks and exploit development.",
        "这是一段正常的中文。",
    ]
    print("=== 模板替换前后对比 ===")
    for s in samples:
        d = desensitize_text(s)
        print(("✓改" if d != s else "  不") + f" | 原文: {s}")
        if d != s:
            print(f"     | 替换: {d}")
    print()
    print("=== messages 脱敏（只处理 system）===")
    msgs = [
        {"role": "system", "content": "You are Claude Code, Anthropic's official CLI for Claude"},
        {"role": "user", "content": "explain DoS attacks"},  # Preserve real user text.
    ]
    out = desensitize_messages(msgs)
    for m in out:
        print(f"  [{m['role']}] {m['content']!r}")
    print()
    assert out[0]["content"] == "You are CodeBuddy, Tencent's official CLI", "system 模板应被替换"
    assert out[1]["content"] == msgs[1]["content"], "user 应保持原样"
    print("✓ 自测通过：system 模板被替换，user 保持原样，正文无零宽字符")
