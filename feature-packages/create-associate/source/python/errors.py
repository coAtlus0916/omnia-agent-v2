"""Stable error contract for the create-associate data engine."""

from __future__ import annotations


class EngineError(Exception):
    """An expected, fail-closed contract error."""

    def __init__(self, code: str, message: str, *, details: dict | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}

    def as_dict(self) -> dict:
        result = {"code": self.code, "message": self.message}
        if self.details:
            result["details"] = self.details
        return result


def require(condition: object, code: str, message: str, **details: object) -> None:
    if not condition:
        raise EngineError(code, message, details=details or None)
