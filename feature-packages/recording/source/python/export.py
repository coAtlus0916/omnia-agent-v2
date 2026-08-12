"""Cursor-streamed canonical recorder Artifact writer."""

from __future__ import annotations

import errno
import hashlib
import os
import stat
from typing import Any, BinaryIO

from recording_store import MAX_ARTIFACT_BYTES, AuthorizedHandle, RecordingError, RecordingStore, canonical_json, parse_json, require


FINAL_FORMAT = "omnia-v5-recorder/v1"


class DigestWriter:
    def __init__(self, stream: BinaryIO) -> None:
        self.stream = stream
        self.digest = hashlib.sha256()
        self.size_bytes = 0

    def write(self, value: str | bytes) -> None:
        data = value.encode("utf-8") if isinstance(value, str) else value
        require(self.size_bytes + len(data) <= MAX_ARTIFACT_BYTES, "RECORDING.OUTPUT_TOO_LARGE", "Recording Artifact exceeds the 64 MiB Store limit.")
        written = self.stream.write(data)
        require(written == len(data), "HANDLE.WRITE_INCOMPLETE", "Recording Artifact output handle accepted a short write.")
        self.digest.update(data)
        self.size_bytes += len(data)


def _flush_and_sync_managed_output(stream: BinaryIO, managed_path: str, expected_size: int) -> None:
    """Flush output and require durable sync, except for Windows regular-file EPERM."""
    stream.flush()
    try:
        os.fsync(stream.fileno())
    except OSError as exc:
        # Some Windows-managed output files reject fsync with EPERM even though
        # their buffered bytes were flushed. The exception is safe to tolerate
        # only after proving this descriptor is the authorized regular file and
        # its complete expected byte count is visible to the filesystem.
        descriptor = os.fstat(stream.fileno())
        managed = os.stat(managed_path)
        same_file = (descriptor.st_dev, descriptor.st_ino) == (managed.st_dev, managed.st_ino)
        tolerable_windows_fsync = (
            os.name == "nt"
            and exc.errno == errno.EPERM
            and stat.S_ISREG(descriptor.st_mode)
            and stat.S_ISREG(managed.st_mode)
            and same_file
            and descriptor.st_size == expected_size
            and managed.st_size == expected_size
        )
        if not tolerable_windows_fsync:
            raise


def write_recording_artifact(store: RecordingStore, recording_id: str, output: AuthorizedHandle) -> tuple[int, str]:
    require(output.media_type == "application/json", "HANDLE.MEDIA_TYPE_INVALID", "Recording output handle must be application/json.")
    metadata = store.metadata(recording_id)
    manifest = metadata.get("manifest")
    security = metadata.get("security")
    require(isinstance(manifest, dict) and isinstance(security, dict), "STORE.METADATA_CORRUPT", "Stored recording metadata is incomplete.")
    require(manifest.get("format") == FINAL_FORMAT and manifest.get("recordingId") == recording_id,
            "STORE.METADATA_CORRUPT", "Stored recording identity is invalid.")
    scalar = {
        "format": FINAL_FORMAT,
        "source": str(manifest.get("source") or "edge-cdp"),
        "recordingId": recording_id,
        "engagementId": str(manifest.get("engagementId") or ""),
        "createdAt": str(manifest.get("createdAt") or ""),
        "exportedAt": str(manifest.get("preparedAt") or ""),
        "state": str(manifest.get("state") or "incomplete"),
        "elapsedMs": int(manifest.get("elapsedMs") or 0),
        "pauseCount": int(manifest.get("pauseCount") or 0),
        "integrity": manifest.get("integrity") if isinstance(manifest.get("integrity"), dict) else {},
        "featureFreeze": metadata.get("featureFreeze") if isinstance(metadata.get("featureFreeze"), dict) else {},
    }
    try:
        with open(output.path, "wb") as stream:
            writer = DigestWriter(stream)
            writer.write("{")
            first = True
            for key, value in scalar.items():
                if not first:
                    writer.write(",")
                writer.write(canonical_json(key))
                writer.write(":")
                writer.write(canonical_json(value))
                first = False
            writer.write(',"catalogs":[')
            first_item = True
            catalog_count = 0
            for row in store.catalog_rows(recording_id):
                if not first_item:
                    writer.write(",")
                catalog_metadata = parse_json(str(row["metadata_json"]), "STORE.CATALOG_CORRUPT", "Stored recording Catalog metadata is invalid.")
                catalog = parse_json(str(row["catalog_json"]), "STORE.CATALOG_CORRUPT", "Stored recording Catalog is invalid.")
                writer.write(canonical_json({"metadata": catalog_metadata, "catalog": catalog}))
                first_item = False
                catalog_count += 1
            writer.write('],"security":')
            writer.write(canonical_json(security))
            writer.write(',"totalEvents":')
            writer.write(str(int(manifest.get("eventCount") or 0)))
            writer.write(',"droppedEvents":')
            writer.write(str(int(manifest.get("droppedEventCount") or 0)))
            writer.write(',"events":[')
            first_item = True
            event_count = 0
            for row in store.event_rows(recording_id):
                if not first_item:
                    writer.write(",")
                event = parse_json(str(row["event_json"]), "STORE.EVENT_CORRUPT", "Stored recording event is invalid.")
                writer.write(canonical_json(event))
                first_item = False
                event_count += 1
            writer.write("]}")
            require(event_count == int(manifest.get("eventCount") or 0), "STORE.EVENT_COUNT_DRIFT", "Stored recording event count drifted before Artifact write.")
            capture = manifest.get("capture") if isinstance(manifest.get("capture"), dict) else {}
            declared_catalogs = capture.get("graCount")
            if isinstance(declared_catalogs, int) and not isinstance(declared_catalogs, bool):
                require(catalog_count == declared_catalogs, "STORE.CATALOG_COUNT_DRIFT", "Stored recording Catalog count drifted before Artifact write.")
            _flush_and_sync_managed_output(stream, output.path, writer.size_bytes)
            require(writer.size_bytes > 0, "RECORDING.OUTPUT_EMPTY", "Recording Artifact is empty.")
            return writer.size_bytes, writer.digest.hexdigest()
    except RecordingError:
        raise
    except OSError as exc:
        raise RecordingError("HANDLE.WRITE_FAILED", "Recording Artifact output handle could not be written.") from exc
