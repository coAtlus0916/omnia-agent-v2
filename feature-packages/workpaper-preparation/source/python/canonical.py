"""Canonical JSON and digest helpers shared across process boundaries."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any

from errors import EngineError


def canonical_bytes(value: Any) -> bytes:
    _validate_json(value)
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def canonical_text(value: Any) -> str:
    return canonical_bytes(value).decode("utf-8")


def sha256_hex(value: bytes | str) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def semantic_digest(value: Any) -> str:
    return sha256_hex(canonical_bytes(value))


def _validate_json(value: Any, *, depth: int = 0) -> None:
    if depth > 64:
        raise EngineError("JSON.DEPTH_EXCEEDED", "JSON nesting exceeds 64 levels.")
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise EngineError("JSON.NON_FINITE_NUMBER", "Canonical JSON forbids non-finite numbers.")
        return
    if isinstance(value, list):
        for item in value:
            _validate_json(item, depth=depth + 1)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise EngineError("JSON.NON_STRING_KEY", "Canonical JSON object keys must be strings.")
            _validate_json(item, depth=depth + 1)
        return
    raise EngineError("JSON.UNSUPPORTED_TYPE", f"Canonical JSON cannot encode {type(value).__name__}.")
