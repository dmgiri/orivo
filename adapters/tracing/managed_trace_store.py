"""Bounded, process-local transport for owned development trace metadata."""
from __future__ import annotations

from collections import OrderedDict
import json
import re
import secrets
import threading
import time
from typing import Any


class ManagedTraceStore:
    MAX_TRACE_BYTES = 2 * 1024 * 1024
    MAX_TOTAL_BYTES = 64 * 1024 * 1024
    MAX_TRACES = 256
    TTL_SECONDS = 90

    def __init__(self) -> None:
        self._entries: OrderedDict[str, tuple[float, bytes]] = OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()

    def _discard_expired(self, now: float) -> None:
        while self._entries:
            key, (created, raw) = next(iter(self._entries.items()))
            if now - created < self.TTL_SECONDS:
                break
            self._entries.pop(key)
            self._bytes -= len(raw)

    def publish(self, payload: dict[str, Any]) -> str | None:
        # Values and parameter bindings are never added to this transport.
        # It serializes only the adapter's existing, redacted trace payload.
        if not isinstance(payload, dict) or not re.fullmatch(
                r"[A-Za-z0-9_-]{8,80}", str(payload.get("id", ""))):
            return None
        try:
            raw = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode()
        except (ValueError, TypeError, RecursionError):
            return None
        if len(raw) > self.MAX_TRACE_BYTES:
            return None
        key = secrets.token_hex(16)
        with self._lock:
            self._discard_expired(time.monotonic())
            while self._entries and (len(self._entries) >= self.MAX_TRACES
                    or self._bytes + len(raw) > self.MAX_TOTAL_BYTES):
                _, (_, removed) = self._entries.popitem(last=False)
                self._bytes -= len(removed)
            self._entries[key] = (time.monotonic(), raw)
            self._bytes += len(raw)
        return key

    def get(self, key: str) -> bytes | None:
        if not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{32}", key):
            return None
        with self._lock:
            self._discard_expired(time.monotonic())
            entry = self._entries.get(key)
            return entry[1] if entry else None

    def close(self) -> None:
        with self._lock:
            self._entries.clear()
            self._bytes = 0
