from __future__ import annotations

import pathlib
import sys


MARKER = "@v5_remote_connector_stable path /files/v5-remote-connector/stable.json"
UNQUOTED_DOWNLOAD_HEADER = (
    "\theader @downloads Cache-Control public, max-age=31536000, immutable\n"
)
QUOTED_DOWNLOAD_HEADER = (
    '\theader @downloads Cache-Control "public, max-age=31536000, immutable"\n'
)
OLD = """\t@downloads path /files/*
""" + UNQUOTED_DOWNLOAD_HEADER
NEW = """\t@v5_remote_connector_stable path /files/v5-remote-connector/stable.json
\theader @v5_remote_connector_stable Cache-Control no-store
\t@downloads {
\t\tpath /files/*
\t\tnot path /files/v5-remote-connector/stable.json
\t}
""" + QUOTED_DOWNLOAD_HEADER


def write_atomic(filename: pathlib.Path, content: str) -> None:
    temporary = filename.with_name(f".{filename.name}.v5-remote-connector.tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.chmod(filename.stat().st_mode)
    temporary.replace(filename)


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: update_download_caddy_v5.py <Caddyfile>")
    filename = pathlib.Path(sys.argv[1]).resolve(strict=True)
    source = filename.read_text(encoding="utf-8")
    if MARKER in source:
        if QUOTED_DOWNLOAD_HEADER in source:
            print("v5 Remote Connector cache policy is already installed")
            return 0
        if source.count(UNQUOTED_DOWNLOAD_HEADER) != 1:
            raise SystemExit("refusing to repair an unexpected v5 download cache policy")
        write_atomic(
            filename,
            source.replace(UNQUOTED_DOWNLOAD_HEADER, QUOTED_DOWNLOAD_HEADER),
        )
        print("repaired the v5 Remote Connector immutable archive cache policy")
        return 0
    if source.count(OLD) != 1:
        raise SystemExit("refusing to patch an unexpected download.example.invalid Caddy block")
    write_atomic(filename, source.replace(OLD, NEW))
    print("installed the isolated v5 Remote Connector cache policy")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
