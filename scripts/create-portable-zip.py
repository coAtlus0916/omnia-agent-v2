from __future__ import annotations

import os
import pathlib
import sys
import zipfile


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: create-portable-zip.py SOURCE_DIRECTORY OUTPUT_ZIP")
    source = pathlib.Path(sys.argv[1]).resolve(strict=True)
    output = pathlib.Path(sys.argv[2]).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    if temporary.exists():
        temporary.unlink()
    with zipfile.ZipFile(
        temporary,
        mode="w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=6,
        allowZip64=True,
    ) as archive:
        for root, directories, filenames in os.walk(source, followlinks=False):
            directories.sort()
            filenames.sort()
            root_path = pathlib.Path(root)
            for filename in filenames:
                member = root_path / filename
                if not member.is_file():
                    continue
                archive.write(member, member.relative_to(source.parent).as_posix())
    os.replace(temporary, output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
