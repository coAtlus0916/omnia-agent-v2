#!/usr/bin/env python3
import argparse
import os
import shutil
import tempfile

BEGIN = "# BEGIN OMNIA AGENT V5 BRIDGE"
END = "# END OMNIA AGENT V5 BRIDGE"


def site_closing_line(lines: list[str], site: str) -> int:
    start = -1
    depth = 0
    for index, line in enumerate(lines):
        stripped = line.strip()
        if start < 0:
            if stripped.startswith("#") or site not in stripped or "{" not in stripped:
                continue
            start = index
            depth = line.count("{") - line.count("}")
            if depth <= 0:
                raise RuntimeError("Caddy site block closes on its header; refusing to patch.")
            continue
        depth += line.count("{") - line.count("}")
        if depth == 0:
            return index
    raise RuntimeError(f"Could not find a complete Caddy site block containing: {site}")


def atomic_write(filename: str, content: str) -> None:
    directory = os.path.dirname(os.path.abspath(filename))
    metadata = os.stat(filename, follow_symlinks=False)
    fd, temporary = tempfile.mkstemp(prefix=".omnia-v5-caddy-", dir=directory, text=True)
    try:
        os.fchmod(fd, metadata.st_mode & 0o7777)
        os.fchown(fd, metadata.st_uid, metadata.st_gid)
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, filename)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def install(filename: str, site: str) -> None:
    with open(filename, "r", encoding="utf-8") as stream:
        content = stream.read()
    if BEGIN in content and END in content:
        print("Caddy v5 Bridge route is already present.")
        return
    if BEGIN in content or END in content:
        raise RuntimeError("Incomplete v5 Bridge marker found; refusing to patch.")
    lines = content.splitlines(keepends=True)
    closing = site_closing_line(lines, site)
    indent = lines[closing][: len(lines[closing]) - len(lines[closing].lstrip())] + "    "
    route = [
        f"{indent}{BEGIN}\n",
        f"{indent}handle_path /v5-bridge/* {{\n",
        f"{indent}    reverse_proxy 127.0.0.1:18785\n",
        f"{indent}}}\n",
        f"{indent}{END}\n",
    ]
    backup = filename + ".omnia-agent-v5-bridge.prepatch"
    if os.path.exists(backup):
        raise RuntimeError(f"Pre-patch backup already exists: {backup}")
    shutil.copy2(filename, backup)
    atomic_write(filename, "".join(lines[:closing] + route + lines[closing:]))
    print(f"Patched {filename}; rollback backup: {backup}")


def rollback(filename: str) -> None:
    backup = filename + ".omnia-agent-v5-bridge.prepatch"
    if not os.path.isfile(backup):
        raise RuntimeError(f"Rollback backup is unavailable: {backup}")
    shutil.copy2(backup, filename)
    print(f"Restored {filename} from {backup}")


parser = argparse.ArgumentParser()
parser.add_argument("action", choices=("install", "rollback"))
parser.add_argument("--caddyfile", default="/etc/caddy/Caddyfile")
parser.add_argument("--site", default="labcaspian.com")
args = parser.parse_args()

if args.action == "install":
    install(args.caddyfile, args.site)
else:
    rollback(args.caddyfile)
