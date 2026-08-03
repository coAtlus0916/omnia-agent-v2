from __future__ import annotations

import hashlib
import json
import os
import pathlib
import shutil
import sys
import tempfile
from datetime import datetime, timezone


PRODUCT = "omnia-agent-v5-remote-connector"
PUBLIC_ROOT = pathlib.Path("/var/www/omnia-download/files/v5-remote-connector")
CONTROL_ROOT = pathlib.Path("/opt/omnia-agent-v5-remote-connector")


def sha256(filename: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with filename.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_copy(source: pathlib.Path, destination: pathlib.Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if source.stat().st_size != destination.stat().st_size or sha256(source) != sha256(destination):
            raise SystemExit(f"refusing to replace a different immutable release: {destination}")
        return
    handle, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        suffix=".tmp",
        dir=destination.parent,
    )
    temporary = pathlib.Path(temporary_name)
    try:
        with os.fdopen(handle, "wb") as output, source.open("rb") as input_file:
            shutil.copyfileobj(input_file, output, length=1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_text(content: bytes, destination: pathlib.Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        suffix=".tmp",
        dir=destination.parent,
    )
    temporary = pathlib.Path(temporary_name)
    try:
        with os.fdopen(handle, "wb") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def validate_manifest(value: object) -> dict:
    if not isinstance(value, dict):
        raise SystemExit("v5 Remote Connector stable manifest must be an object")
    legacy_expected = {
        "schemaVersion",
        "product",
        "channel",
        "platform",
        "version",
        "sequence",
        "publishedAt",
        "url",
        "sha256",
        "size",
        "minimumSupervisorVersion",
        "keyId",
        "signature",
    }
    rollout_expected = legacy_expected | {
        "rolloutPolicy",
        "securitySeverity",
        "newRunStopAt",
        "maxDrainUntil",
        "offerExpiresAt",
    }
    if set(value) not in (legacy_expected, rollout_expected):
        raise SystemExit("v5 Remote Connector stable manifest fields are incompatible")
    if (
        value["schemaVersion"] != "omnia.v5.remote-connector-update/v1"
        or value["product"] != PRODUCT
        or value["channel"] != "stable"
        or value["platform"] != "win32-x64"
        or value["keyId"] != "v5-remote-connector-release-2026-01"
    ):
        raise SystemExit("v5 Remote Connector stable manifest identity is invalid")
    version = str(value["version"])
    sequence = value["sequence"]
    if (
        len(version.split(".")) != 3
        or not all(part.isdigit() for part in version.split("."))
        or not isinstance(sequence, int)
        or isinstance(sequence, bool)
        or sequence <= 0
    ):
        raise SystemExit("v5 Remote Connector release version or sequence is invalid")
    archive_name = f"Omnia-Agent-v5-Remote-Connector-v{version}-Portable.zip"
    expected_url = (
        "https://download.labcaspian.com/files/v5-remote-connector/"
        f"releases/{version}/{archive_name}"
    )
    if value["url"] != expected_url:
        raise SystemExit("v5 Remote Connector release URL is outside its isolated path")
    if (
        not isinstance(value["sha256"], str)
        or len(value["sha256"]) != 64
        or any(character not in "0123456789abcdef" for character in value["sha256"])
        or not isinstance(value["size"], int)
        or isinstance(value["size"], bool)
        or value["size"] <= 0
    ):
        raise SystemExit("v5 Remote Connector release digest or size is invalid")
    if set(value) == rollout_expected:
        if value["rolloutPolicy"] != "automatic_safe_window" or value["securitySeverity"] not in ("normal", "high", "critical"):
            raise SystemExit("v5 Remote Connector rollout identity is invalid")
        try:
            published = datetime.fromisoformat(str(value["publishedAt"]).replace("Z", "+00:00"))
            new_run_stop = datetime.fromisoformat(str(value["newRunStopAt"]).replace("Z", "+00:00"))
            max_drain = datetime.fromisoformat(str(value["maxDrainUntil"]).replace("Z", "+00:00"))
            expires = datetime.fromisoformat(str(value["offerExpiresAt"]).replace("Z", "+00:00"))
        except ValueError as error:
            raise SystemExit("v5 Remote Connector rollout timestamps are invalid") from error
        if not (published <= new_run_stop <= max_drain <= expires) or expires <= datetime.now(timezone.utc):
            raise SystemExit("v5 Remote Connector rollout window is invalid or expired")
    return value


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit(
            "usage: install_v5_remote_connector_release.py <archive.zip> <stable.json>"
        )
    archive = pathlib.Path(sys.argv[1]).resolve(strict=True)
    stable_source = pathlib.Path(sys.argv[2]).resolve(strict=True)
    manifest_bytes = stable_source.read_bytes()
    manifest = validate_manifest(json.loads(manifest_bytes))
    if archive.name != pathlib.Path(str(manifest["url"])).name:
        raise SystemExit("archive name differs from the signed stable manifest")
    if archive.stat().st_size != manifest["size"] or sha256(archive) != manifest["sha256"]:
        raise SystemExit("archive size or SHA-256 differs from the stable manifest")

    version = str(manifest["version"])
    sequence = int(manifest["sequence"])
    public_release = PUBLIC_ROOT / "releases" / version
    control_release = CONTROL_ROOT / "releases" / version
    public_archive = public_release / archive.name
    control_archive = control_release / archive.name
    public_release_manifest = public_release / "release.json"
    control_release_manifest = control_release / "release.json"
    public_stable = PUBLIC_ROOT / "stable.json"

    existing = None
    if public_stable.exists():
        existing = validate_manifest(json.loads(public_stable.read_bytes()))
        existing_sequence = int(existing["sequence"])
        if sequence < existing_sequence:
            raise SystemExit("refusing to downgrade the v5 Remote Connector stable sequence")
        if sequence == existing_sequence and existing != manifest:
            raise SystemExit("refusing to replace an existing v5 sequence with different content")

    atomic_copy(archive, control_archive)
    atomic_copy(archive, public_archive)
    atomic_text(manifest_bytes, control_release_manifest)
    atomic_text(manifest_bytes, public_release_manifest)

    if existing is not None and existing != manifest:
        history = CONTROL_ROOT / "manifests"
        history.mkdir(parents=True, exist_ok=True)
        atomic_text(
            json.dumps(existing, indent=2, ensure_ascii=False).encode("utf-8") + b"\n",
            history / f"stable-sequence-{existing['sequence']}.json",
        )
    atomic_text(manifest_bytes, public_stable)

    print(
        json.dumps(
            {
                "ok": True,
                "product": PRODUCT,
                "version": version,
                "sequence": sequence,
                "sha256": manifest["sha256"],
                "publicArchive": str(public_archive),
                "stableManifest": str(public_stable),
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
