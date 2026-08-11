"""Managed CPython 3.13.14 entry point for the recording Feature."""

from __future__ import annotations

import sys
from pathlib import Path


_SIGNED_PYTHON_ROOT = Path(__file__).resolve().parent
if str(_SIGNED_PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(_SIGNED_PYTHON_ROOT))

from protocol import main  # noqa: E402


if __name__ == "__main__":
    if sys.argv[1:] != ["--stdio-rpc"]:
        raise SystemExit(64)
    raise SystemExit(main())
