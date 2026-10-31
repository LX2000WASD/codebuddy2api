#!/usr/bin/env python3
"""The official model-rate grammar: one leaf module, no intra-package imports.

The rate string is the upstream catalog's `credits` field, shaped like
"x1" / "x0.5" / "x 2 credits". Parsing it is a pure function of a string, so it lives in
this leaf instead of inside `app.model_rates`: that module also carries the gateway glue
(probe jobs, manual overrides), which imports `model_policy` — and `model_policy` reaches
`model_capabilities` → `model_catalog_view`, whose rate lookups need this grammar. With
the grammar in the glue module the cold-start path
`credit_floor → model_rates → model_policy → … → model_catalog_view → model_rates`
imported a half-initialised module and raised ImportError. pytest only hid it by importing
things in a different order; every caller below now imports this leaf, and
`model_rates` re-exports the names so older call sites keep working.
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
