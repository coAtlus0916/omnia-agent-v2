"""Stable error contract for the workpaper-preparation engine."""

from __future__ import annotations


class EngineError(Exception):
    """An expected, fail-closed contract error."""

    def __init__(self, code: str, message: str, *, details: dict | None = None) -> None:
        Exception.__init__(self, message)
        self.code, self.message = code, message
        self.details = dict(details) if details else {}

    def as_dict(self) -> dict:
        result: dict[str, object] = {"code": self.code, "message": self.message}
        if self.details:
            result.update({"details": dict(self.details)})
        return result


def require(condition: object, code: str, message: str, **details: object) -> None:
    if condition:
        return
    raise EngineError(code, message, details=details or None)
