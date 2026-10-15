#!/usr/bin/env python3
"""Official model-rate parsing, shared by the gateway and the fusion ledgers.

The rate string is the upstream catalog's `credits` field, shaped like
`"x1" / "x0.5" / "x 2 credits"`. Two modules used to carry their own copy of
this parser — `converter._multiplier_value` (inline regex) and
`app.credit_floor.multiplier_value` (module-level `_RATE`) — with identical
docstrings and semantics, and three further modules reached the converter's
private copy through `gateway._multiplier_value`. Keeping one implementation
here means a change to the accepted grammar cannot silently apply to only half
the callers.
"""
from __future__ import annotations

import math
import re

# The leading "x" is required; a bare number is not a rate. Trailing "credit(s)"
# is optional and the whitespace around the number is free-form.
RATE = re.compile(r"x\s*([0-9]+(?:\.[0-9]+)?)\s*(?:credits?)?", re.IGNORECASE)
# A rate that is explicitly zero, used to classify a model as free.
FREE_RATE = re.compile(r"x\s*0(?:\.0+)?\s*(?:credits?)?", re.IGNORECASE)


def multiplier_value(credits):
    """Parse an official model rate, returning None for missing or unknown formats."""
    if not isinstance(credits, str):
        return None
    match = RATE.fullmatch(credits.strip())
    if match is None:
        return None
    try:
        value = float(match.group(1))
    except ValueError:
        return None
    # An absurdly long digit run parses to inf; that is not a usable rate.
    return value if math.isfinite(value) else None


def is_free_multiplier(credits):
    """Report whether a rate string is an explicit zero rate."""
    if not isinstance(credits, str):
        return False
    return FREE_RATE.fullmatch(credits.strip()) is not None
