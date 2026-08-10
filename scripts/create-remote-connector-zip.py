from __future__ import annotations

import pathlib
import sys
import zipfile


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit(
            "usage: create-remote-connector-zip.py <portable-directory> <output.zip>"
        )
    source = pathlib.Path(sys.argv[1]).resolve()
    destination = pathlib.Path(sys.argv[2]).resolve()
    if not source.is_dir():
        raise SystemExit(f"portable directory does not exist: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        destination.unlink()
    with zipfile.ZipFile(
        destination,
        mode="w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
        allowZip64=True,
    ) as archive:
        for entry in sorted(source.rglob("*")):
            if entry.is_symlink():
                raise SystemExit(f"symbolic links are not allowed: {entry}")
            if not entry.is_file():
                continue
            relative = entry.relative_to(source.parent).as_posix()
            archive.write(entry, relative)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

