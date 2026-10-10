#!/usr/bin/env python3
"""Local EMA charge ledger and credit-floor admission for account selection.

Fusion port of workbuddy2api-panel (internal/pool/state.go NoteModelCost and
internal/pool/pick.go floorBlockedForRealmModel): the pool must not route a
paid model to an account whose balance sits under the configured credit floor.
Whether a model is paid is decided by two independent criteria:

* the local charge ledger — an EMA of observed credits-per-1k tokens
  (alpha=0.3, so a single outlier cannot dominate), whose observations expire
  after a TTL (6h by default) so a time-limited free window cannot come back
  to life after the period rolled over;
* the upstream catalog multiplier, used as a fallback for models with no live
  local observation yet (otherwise "never observed" would equal "free").

Observations are entered from completed upstream chat responses (the usage
block's credit and token counters). The balance itself comes from the existing
per-credit snapshot; this ledger only classifies cost, it never mutates
balances. Persistence is a standalone bounded JSON file next to the control
database (the SQLite state store has a fixed namespace set); a failed write
degrades to the in-memory ledger and is reported via last_error, mirroring the
cooldown store's tolerant contract.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time

VERSION = 1
MAX_ACCOUNTS = 256          # Bounded table, matching the credential pool's practical size.
MAX_MODELS = 64             # Bounded per-account model rows.
MAX_BYTES = 256 * 1024      # Bounded read *and* write.
DEFAULT_TTL_S = 6 * 3600    # Observation lifetime: a free window must not revive cross-period.
DEFAULT_ALPHA = 0.3         # EMA smoothing: roughly five samples to converge.

_IDENTITY = re.compile(r"[0-9a-f]{64}")
# Model and profile identifiers may contain slashes (vendor-qualified names), so allow the
# punctuation seen in routing rather than assuming a bare token.
_TOKEN = re.compile(r"[A-Za-z0-9_.:/\-]{1,128}")
_RATE = re.compile(r"x\s*([0-9]+(?:\.[0-9]+)?)\s*(?:credits?)?", re.IGNORECASE)
_FIELDS = {"cost_per_1k", "samples", "last_seen"}


def _number(value):
    """Accept only a finite number; bool is not a number, and a huge int must not raise."""
    if type(value) not in (int, float):
        return None
    try:
        number = float(value)
    except (OverflowError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def _valid_identity(value):
    return isinstance(value, str) and _IDENTITY.fullmatch(value) is not None


def _valid_model(value):
    return isinstance(value, str) and _TOKEN.fullmatch(value) is not None


def multiplier_value(credits):
    """Parse an official model rate, returning None for missing or unknown formats."""
    if not isinstance(credits, str):
        return None
    match = _RATE.fullmatch(credits.strip())
    if match is None:
        return None
    try:
        return float(match.group(1))
    except ValueError:
        return None


class CostLedger:
    """Thread-safe, optionally persisted EMA charge ledger keyed by (account, model)."""

    def __init__(self, path=None, *, alpha: float = DEFAULT_ALPHA, ttl: float = DEFAULT_TTL_S):
        self.path = str(path) if path else None
        self.alpha = min(1.0, max(0.01, float(alpha or DEFAULT_ALPHA)))
        self.ttl = max(60.0, float(ttl or DEFAULT_TTL_S))
        self._lock = threading.RLock()
        self._data: dict[str, dict] = {}
        # Last write failure, surfaced for diagnostics instead of failing silently.
        self.last_error: str | None = None
        if self.path:
            self._load()

    # -- persistence -------------------------------------------------------

    def _load(self):
        """Adopt only a fully valid snapshot; anything else leaves the ledger empty."""
        try:
            with open(self.path, "rb") as stream:
                raw = stream.read(MAX_BYTES + 1)
        except OSError:
            return
        if len(raw) > MAX_BYTES:
            return
        try:
            document = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeError):
            return
        if (not isinstance(document, dict) or set(document) != {"version", "accounts"}
                or type(document["version"]) is not int or document["version"] != VERSION):
            return
        accounts = document["accounts"]
        if not isinstance(accounts, dict) or len(accounts) > MAX_ACCOUNTS:
            return
        restored: dict[str, dict] = {}
        for identity, models in accounts.items():
            if not _valid_identity(identity) or not isinstance(models, dict) or len(models) > MAX_MODELS:
                return
            kept = {}
            for model, row in models.items():
                if (not _valid_model(model) or not isinstance(row, dict) or set(row) != _FIELDS):
                    return
                cost, samples, seen = (_number(row["cost_per_1k"]), _number(row["samples"]),
                                       _number(row["last_seen"]))
                if cost is None or samples is None or seen is None or samples <= 0:
                    return
                kept[model] = {"cost_per_1k": cost, "samples": int(samples), "last_seen": seen}
            if kept:
                restored[identity] = kept
        with self._lock:
            self._data = restored

    def _save_locked(self) -> bool:
        """Atomically rewrite the ledger; returns False when the update was not durable."""
        if not self.path:
            return True
        content = json.dumps({"version": VERSION, "accounts": self._data},
                             ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        temporary = None
        try:
            directory = os.path.dirname(self.path) or "."
            os.makedirs(directory, mode=0o700, exist_ok=True)
            name = os.path.basename(self.path) or "credit-floor"
            fd, temporary = tempfile.mkstemp(prefix="." + name + "-", suffix=".tmp", dir=directory)
            with os.fdopen(fd, "wb") as stream:
                stream.write(content)
            try:
                os.chmod(temporary, 0o600)
            except OSError:
                pass    # chmod does not establish owner-only ACLs on Windows.
            os.replace(temporary, self.path)
        except OSError as error:
            self.last_error = type(error).__name__
            return False
        finally:
            if temporary:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass
        self.last_error = None
        return True

    # -- writes ------------------------------------------------------------

    def _ensure_locked(self, identity, model):
        """Write-side lookup, bounded by the reader's own capacity contract."""
        if not _valid_identity(identity) or not _valid_model(model):
            return None
        row = self._data.get(identity)
        if row is None:
            if len(self._data) >= MAX_ACCOUNTS:
                self._drop_locked()
            row = self._data[identity] = {}
        return row

    def _drop_locked(self):
        """Evict the account whose newest observation is oldest, to stay within capacity."""
        if not self._data:
            return
        oldest = min(self._data, key=lambda key: max(
            (entry["last_seen"] for entry in self._data[key].values()), default=0.0))
        self._data.pop(oldest, None)

    def note(self, identity: str, model: str, credit: float, tokens: float, now=None) -> bool:
        """Record one observed charge as a per-1k EMA sample; returns whether it is durable."""
        credit, tokens = _number(credit), _number(tokens)
        stamp = _number(time.time() if now is None else now)
        if credit is None or tokens is None or stamp is None or tokens <= 0 or credit < 0:
            return False        # Reject before mutating anything.
        per1k = credit / tokens * 1000.0
        with self._lock:
            self._prune_locked(stamp)   # Capacity must reflect live observations only.
            models = self._ensure_locked(identity, model)
            if models is None:
                return False
            if model not in models and len(models) >= MAX_MODELS:
                # Evict the stalest observation rather than refusing the new one.
                models.pop(min(models, key=lambda name: models[name]["last_seen"]), None)
            previous = models.get(model)
            if previous is None:
                models[model] = {"cost_per_1k": per1k, "samples": 1, "last_seen": stamp}
            else:
                blended = previous["cost_per_1k"] * (1.0 - self.alpha) + per1k * self.alpha
                models[model] = {"cost_per_1k": blended, "samples": previous["samples"] + 1,
                                 "last_seen": stamp}
            return self._save_locked()

    def forget(self, identity: str) -> bool:
        """Drop one account's rows; used when its credential is deleted or replaced."""
        with self._lock:
            if self._data.pop(identity, None) is None:
                return True
            return self._save_locked()

    def prune(self, now=None) -> bool:
        """Drop expired observations so the ledger cannot accumulate dead rows."""
        stamp = _number(time.time() if now is None else now)
        if stamp is None:
            return True
        with self._lock:
            changed = False
            for identity in list(self._data):
                current = self._data[identity]
                kept = {model: row for model, row in current.items()
                        if stamp - row["last_seen"] <= self.ttl}
                if len(kept) == len(current):
                    continue
                if kept:
                    self._data[identity] = kept
                else:
                    self._data.pop(identity, None)
                changed = True
            if not changed:
                return True
            return self._save_locked()

    def _prune_locked(self, now: float):
        for identity in list(self._data):
            kept = {model: row for model, row in self._data[identity].items()
                    if now - row["last_seen"] <= self.ttl}
            if kept:
                self._data[identity] = kept
            else:
                self._data.pop(identity, None)

    # -- reads -------------------------------------------------------------

    def cost_of(self, identity: str, model: str, now=None) -> float | None:
        """Return the live per-1k EMA, or None when there is no observation within the TTL."""
        stamp = _number(time.time() if now is None else now)
        if stamp is None:
            return None
        with self._lock:
            row = (self._data.get(identity) or {}).get(model)
            if row is None or stamp - row["last_seen"] > self.ttl:
                return None        # Stale prices must not revive cross-period.
            return float(row["cost_per_1k"])

    def paid(self, identity: str, model: str, now=None) -> bool | None:
        """Classify cost from local observation: True paid, False free, None unobserved."""
        cost = self.cost_of(identity, model, now=now)
        if cost is None:
            return None
        return cost > 0.0

    def detail(self, now=None) -> list:
        """Return a bounded snapshot for diagnostics."""
        stamp = _number(time.time() if now is None else now)
        with self._lock:
            rows = [{"identity": identity, "model": model, **row}
                    for identity, models in self._data.items()
                    for model, row in models.items()
                    if stamp is None or stamp - row["last_seen"] <= self.ttl]
        rows.sort(key=lambda row: (row["identity"], row["model"]))
        return rows


def catalog_paid(serves, routed_model) -> bool | None:
    """Classify cost from the upstream catalog: True paid, False zero-rate, None unknown.

    The multiplier text arrives per model entry in the account's own table
    ("x1.62 credits"). An entry without a parseable rate stays None so callers
    fall back to other criteria instead of guessing — the same conservative
    reading the catalog applies elsewhere.
    """
    if not routed_model:
        return None
    rate = None
    for item in serves or []:
        if isinstance(item, dict) and item.get("id") == routed_model:
            rate = multiplier_value(item.get("credits"))
            break
    if rate is None:
        return None
    return rate > 0.0


def floor_admit(balance_credits, observed, catalog) -> bool:
    """Decide whether an under-floor account must be held out of a model's selection.

    The two cost criteria are independent and conservative in the safe
    direction: only a positive signal from either one blocks the account. An
    explicitly free model (observed cost of zero or a zero catalog multiplier)
    is never blocked, because the floor exists to protect the remaining
    balance for free use. Unknown cost (no observation and no catalog rate)
    does not block either — a deliberate choice, trading a bounded billing
    risk against permanently orphaning catalog-gap models. A None balance is
    not a floor signal: unknown is not the same as empty.
    """
    if balance_credits is None:
        return False
    if observed is False or catalog is False:
        return False        # Explicitly free: the floor must not block it.
    return observed is True or catalog is True
