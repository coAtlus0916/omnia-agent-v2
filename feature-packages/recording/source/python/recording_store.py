"""Private recording state and managed-handle policy for the recording sidecar."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import sys
import uuid
from dataclasses import dataclass
from typing import Any, Iterable


HANDLE_SCHEMA = "omnia.python-artifact-handle/v1"
MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
MAX_ERROR_CHARS = 2_000
MAX_RECORDING_EVENTS = 100_000
TERMINAL_PURGE_STATES = frozenset({"finalized", "failed", "cancelled"})
STAGING_RETENTION = dt.timedelta(days=1)
MARKABLE_STATES = frozenset({
    "starting", "active", "pausing", "paused", "resuming", "stopping",
    "failed", "uncertain", "cancelled",
})
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class RecordingError(Exception):
    """A bounded, user-safe sidecar error."""

    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def require(condition: bool, code: str, message: str) -> None:
    if not condition:
        raise RecordingError(code, message)


def canonical_json(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise RecordingError("RECORDING.JSON_INVALID", "Recording data is not finite JSON.") from exc


def parse_json(text: str, code: str, message: str) -> dict[str, Any]:
    try:
        value = json.loads(text, parse_constant=lambda _value: (_ for _ in ()).throw(ValueError()))
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
        raise RecordingError(code, message) from exc
    require(isinstance(value, dict), code, message)
    return value


def require_uuid(value: Any, label: str) -> str:
    text = str(value or "")
    try:
        parsed = uuid.UUID(text)
    except (ValueError, AttributeError) as exc:
        raise RecordingError("RECORDING.IDENTITY_INVALID", f"{label} is invalid.") from exc
    require(parsed.int != 0 and text == str(parsed), "RECORDING.IDENTITY_INVALID", f"{label} is invalid.")
    return text


def require_text(value: Any, label: str, maximum: int = 2_000) -> str:
    text = str(value or "").strip()
    require(bool(text) and len(text) <= maximum, "RECORDING.VALUE_INVALID", f"{label} is invalid.")
    return text


def parse_timestamp(value: Any, label: str, *, required: bool = True) -> tuple[str, dt.datetime] | tuple[str, None]:
    text = str(value or "").strip()
    if not text and not required:
        return "", None
    require(bool(text) and len(text) <= 100, "RECORDING.TIMESTAMP_INVALID", f"{label} is invalid.")
    try:
        parsed = dt.datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith("Z") else text)
    except ValueError as exc:
        raise RecordingError("RECORDING.TIMESTAMP_INVALID", f"{label} is invalid.") from exc
    require(parsed.tzinfo is not None, "RECORDING.TIMESTAMP_INVALID", f"{label} must include a timezone.")
    parsed = parsed.astimezone(dt.timezone.utc)
    return _utc_text(parsed), parsed


def _utc_text(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _native_path(value: str) -> str:
    absolute = os.path.abspath(value)
    if os.name != "nt" or absolute.startswith("\\\\?\\"):
        return absolute
    if absolute.startswith("\\\\"):
        return "\\\\?\\UNC\\" + absolute[2:]
    return "\\\\?\\" + absolute


def _public_path(value: str) -> str:
    if os.name != "nt" or not value.startswith("\\\\?\\"):
        return value
    if value.startswith("\\\\?\\UNC\\"):
        return "\\\\" + value[8:]
    return value[4:]


def _within(path: str, root: str) -> bool:
    try:
        return os.path.commonpath((path, root)) == root
    except ValueError:
        return False


@dataclass(frozen=True)
class AuthorizedHandle:
    handle_id: str
    run_id: str
    path: str
    access: str
    media_type: str
    original_name: str
    size_bytes: int
    sha256: str

    def updated(self, *, size_bytes: int, sha256: str) -> dict[str, Any]:
        return {
            "schemaVersion": HANDLE_SCHEMA,
            "handleId": self.handle_id,
            "runId": self.run_id,
            "path": _public_path(self.path),
            "access": self.access,
            "mediaType": self.media_type,
            "originalName": self.original_name,
            "sizeBytes": size_bytes,
            "sha256": sha256,
        }


class RuntimeScope:
    """Fail-closed environment and filesystem authorization."""

    def __init__(self) -> None:
        self.package_root = self._absolute_directory("OMNIA_PYTHON_PACKAGE_ROOT")
        self.temp_root = self._absolute_directory("OMNIA_PYTHON_TEMP_ROOT")
        raw_store = os.environ.get("OMNIA_FEATURE_STORE_PATH", "")
        require(bool(raw_store) and os.path.isabs(raw_store), "SIDECAR.STORE_PATH_INVALID", "Feature private Store path is unavailable.")
        self.store_path = os.path.realpath(_native_path(raw_store))
        require(os.path.basename(self.store_path).lower() == "store.sqlite", "SIDECAR.STORE_PATH_INVALID", "Feature private Store must be store.sqlite.")
        require(os.path.basename(os.path.dirname(self.store_path)).lower() == "omnia.recording",
                "SIDECAR.STORE_PATH_INVALID", "Feature private Store is outside the recording namespace.")
        require(os.path.isfile(self.store_path), "SIDECAR.STORE_PATH_INVALID", "Feature private Store is unavailable.")
        module_path = os.path.realpath(_native_path(__file__))
        require(_within(module_path, self.package_root), "SIDECAR.PACKAGE_ROOT_INVALID", "Recording sidecar module escaped its signed package root.")
        require(not _within(self.temp_root, self.package_root) and not _within(self.package_root, self.temp_root),
                "SIDECAR.ROOTS_INVALID", "Package and temporary roots must be isolated.")
        require(not _within(self.store_path, self.temp_root) and not _within(self.store_path, self.package_root),
                "SIDECAR.STORE_PATH_INVALID", "Feature private Store escaped its private data root.")
        self.runtime_root = os.path.realpath(_native_path(sys.base_prefix))
        self.read_paths: set[str] = set()
        self.write_paths: set[str] = set()
        self.invocation_run_id = ""
        self._installed = False

    @staticmethod
    def _absolute_directory(name: str) -> str:
        raw = os.environ.get(name, "")
        require(bool(raw) and os.path.isabs(raw), "SIDECAR.ROOT_INVALID", f"{name} must be an absolute managed path.")
        path = os.path.realpath(_native_path(raw))
        require(os.path.isdir(path), "SIDECAR.ROOT_INVALID", f"{name} is unavailable.")
        return path

    def install(self) -> None:
        if not self._installed:
            sys.addaudithook(self._audit)
            self._installed = True

    def bind_invocation(self, run_id: Any) -> str:
        self.invocation_run_id = ""
        self.read_paths.clear()
        self.write_paths.clear()
        self.invocation_run_id = require_uuid(run_id, "runId")
        return self.invocation_run_id

    def clear_invocation(self) -> None:
        self.invocation_run_id = ""
        self.read_paths.clear()
        self.write_paths.clear()

    def authorize_handle(self, descriptor: Any, *, required_access: str) -> AuthorizedHandle:
        require(isinstance(descriptor, dict) and descriptor.get("schemaVersion") == HANDLE_SCHEMA,
                "HANDLE.SCHEMA_INVALID", "Managed Artifact handle schema is invalid.")
        handle_id = require_uuid(descriptor.get("handleId"), "handleId")
        run_id = require_uuid(descriptor.get("runId"), "handle.runId")
        require(run_id == self.invocation_run_id, "HANDLE.RUN_BINDING_MISMATCH", "Artifact handle is not bound to the active Run.")
        raw_path = descriptor.get("path")
        require(isinstance(raw_path, str) and os.path.isabs(raw_path), "HANDLE.PATH_INVALID", "Artifact handle path must be absolute.")
        access = str(descriptor.get("access") or "")
        require(access in {"read", "write", "readwrite"}, "HANDLE.ACCESS_INVALID", "Artifact handle access is invalid.")
        expected_root = os.path.realpath(_native_path(os.path.join(self.temp_root, run_id, handle_id)))
        require(_within(expected_root, self.temp_root) and os.path.isdir(expected_root),
                "HANDLE.ROOT_INVALID", "Artifact handle root is unavailable.")
        resolved = os.path.realpath(_native_path(raw_path))
        require(os.path.dirname(resolved) == expected_root and _within(resolved, expected_root),
                "HANDLE.PATH_OUTSIDE_RUN", "Artifact handle escaped its Run temp root.")
        require(os.path.isfile(resolved), "HANDLE.FILE_MISSING", "Artifact handle does not resolve to a regular file.")
        if required_access == "read":
            require(access in {"read", "readwrite"}, "HANDLE.READ_FORBIDDEN", "Artifact handle does not grant read access.")
            self.read_paths.add(resolved)
        elif required_access == "write":
            require(access in {"write", "readwrite"}, "HANDLE.WRITE_FORBIDDEN", "Artifact handle does not grant write access.")
            self.write_paths.add(resolved)
        else:
            raise RecordingError("HANDLE.ACCESS_INVALID", "Requested Artifact access is invalid.")
        size_bytes = descriptor.get("sizeBytes")
        require(isinstance(size_bytes, int) and not isinstance(size_bytes, bool) and 0 <= size_bytes <= MAX_ARTIFACT_BYTES,
                "HANDLE.SIZE_INVALID", "Artifact handle size is invalid.")
        digest = str(descriptor.get("sha256") or "").lower()
        if required_access == "read":
            require(_SHA256.fullmatch(digest) is not None, "HANDLE.DIGEST_INVALID", "Readable Artifact handle digest is invalid.")
        else:
            require(size_bytes == 0 and digest == "", "HANDLE.OUTPUT_NOT_EMPTY", "Writable Artifact handle must be empty.")
        return AuthorizedHandle(
            handle_id=handle_id,
            run_id=run_id,
            path=resolved,
            access=access,
            media_type=require_text(descriptor.get("mediaType"), "handle.mediaType", 160),
            original_name=require_text(descriptor.get("originalName"), "handle.originalName", 255),
            size_bytes=size_bytes,
            sha256=digest,
        )

    def _audit(self, event: str, args: tuple[Any, ...]) -> None:
        if event.startswith("socket.") or event in {"subprocess.Popen", "os.system", "os.posix_spawn", "os.posix_spawnp", "pty.spawn"} or event.startswith("os.spawn"):
            raise PermissionError("recording sidecar capability denied")
        if event.startswith("ctypes."):
            raise PermissionError("recording sidecar native loading denied")
        if event == "sqlite3.connect" and args:
            candidate = os.path.realpath(_native_path(os.fspath(args[0])))
            if candidate != self.store_path:
                raise PermissionError("recording sidecar database denied")
        if event == "open" and args:
            raw_path = args[0]
            if isinstance(raw_path, int):
                return
            try:
                candidate = os.path.realpath(_native_path(os.fspath(raw_path)))
            except (TypeError, ValueError, OSError):
                raise PermissionError("recording sidecar file access denied") from None
            mode = args[1] if len(args) > 1 else "r"
            flags = args[2] if len(args) > 2 else 0
            writing = (isinstance(mode, str) and any(char in mode for char in "wax+")) or (
                isinstance(flags, int) and bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
            )
            allowed = self.write_paths if writing else self.read_paths
            if candidate not in allowed:
                raise PermissionError("recording sidecar managed handle denied")
        if event in {"os.remove", "os.rename", "os.replace", "os.rmdir", "os.mkdir", "os.truncate", "os.chmod", "os.chown", "os.link", "os.symlink"}:
            raise PermissionError("recording sidecar filesystem mutation denied")


class RecordingStore:
    """Owns Feature recording projections, frozen-transfer evidence, and staged rows."""

    def __init__(self, scope: RuntimeScope) -> None:
        self.scope = scope
        try:
            self.connection = sqlite3.connect(scope.store_path, timeout=30.0, isolation_level="IMMEDIATE")
            self.connection.row_factory = sqlite3.Row
            self.connection.execute("PRAGMA foreign_keys=ON")
            self.connection.execute("PRAGMA busy_timeout=30000")
            self._ensure_schema()
        except sqlite3.Error as exc:
            raise RecordingError("STORE.OPEN_FAILED", "Feature private recording Store is unavailable.", retryable=True) from exc

    def close(self) -> None:
        self.connection.close()

    def _ensure_schema(self) -> None:
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS recording_sessions(
              recording_id TEXT PRIMARY KEY,
              run_id TEXT NOT NULL,
              state TEXT NOT NULL,
              started_at TEXT NOT NULL,
              stopped_at TEXT,
              finalized_at TEXT,
              purge_after TEXT,
              event_count INTEGER NOT NULL,
              catalog_count INTEGER NOT NULL,
              metadata_json TEXT,
              artifact_json TEXT,
              error_message TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS recording_events(
              event_key TEXT PRIMARY KEY,
              recording_id TEXT NOT NULL,
              sequence INTEGER NOT NULL,
              event_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_recording_events_order ON recording_events(recording_id, sequence);
            CREATE TABLE IF NOT EXISTS recording_catalogs(
              catalog_key TEXT PRIMARY KEY,
              recording_id TEXT NOT NULL,
              stable_id TEXT NOT NULL,
              sequence INTEGER NOT NULL,
              metadata_json TEXT NOT NULL,
              catalog_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_recording_catalogs_order ON recording_catalogs(recording_id, sequence);
            CREATE TABLE IF NOT EXISTS recording_run_recoveries(
              recovery_id TEXT PRIMARY KEY,
              recording_id TEXT NOT NULL,
              predecessor_run_id TEXT NOT NULL UNIQUE,
              successor_run_id TEXT NOT NULL UNIQUE,
              lineage_digest TEXT NOT NULL,
              lineage_json TEXT NOT NULL,
              adopted_at TEXT NOT NULL
            );
            """
        )

    def adopt_successor_run(self, payload: dict[str, Any], invocation_run_id: str) -> dict[str, Any]:
        expected_keys = {
            "recordingId", "predecessorRunId", "successorRunId", "startedAt", "stoppedAt",
            "eventCount", "recoveryLineage", "lineageDigest",
        }
        require(set(payload) == expected_keys, "RECORDING.SUCCESSOR_REQUEST_INVALID",
                "Successor adoption payload has unexpected or missing fields.")
        recording_id = require_uuid(payload.get("recordingId"), "recordingId")
        predecessor_run_id = require_uuid(payload.get("predecessorRunId"), "predecessorRunId")
        successor_run_id = require_uuid(payload.get("successorRunId"), "successorRunId")
        require(successor_run_id == invocation_run_id and predecessor_run_id != successor_run_id,
                "RECORDING.SUCCESSOR_IDENTITY_INVALID", "Successor adoption Run identity is invalid.")
        started_at, _ = parse_timestamp(payload.get("startedAt"), "startedAt")
        stopped_at, stopped = parse_timestamp(payload.get("stoppedAt"), "stoppedAt")
        event_count = payload.get("eventCount")
        require(isinstance(event_count, int) and not isinstance(event_count, bool) and 0 < event_count <= MAX_RECORDING_EVENTS,
                "RECORDING.EVENT_COUNT_INVALID", "Successor adoption event count is invalid.")
        lineage = payload.get("recoveryLineage")
        require(isinstance(lineage, dict), "RECORDING.SUCCESSOR_LINEAGE_INVALID", "Successor recovery lineage is invalid.")
        require(set(lineage) == {
                    "schemaVersion", "recoveryKind", "predecessorRunId", "predecessorFeatureVersion",
                    "predecessorStateRevision", "predecessorCreatedAt", "externalId", "frozenInput",
                }, "RECORDING.SUCCESSOR_LINEAGE_INVALID", "Successor recovery lineage has unexpected or missing fields.")
        lineage_json = canonical_json(lineage)
        lineage_digest = str(payload.get("lineageDigest") or "")
        require(len(lineage_digest) == 64 and all(char in "0123456789abcdef" for char in lineage_digest)
                and hashlib.sha256(lineage_json.encode("utf-8")).hexdigest() == lineage_digest,
                "RECORDING.SUCCESSOR_LINEAGE_INVALID", "Successor recovery lineage digest is invalid.")
        frozen = lineage.get("frozenInput")
        require(isinstance(frozen, dict) and set(frozen) == {
                    "schemaVersion", "observationId", "streamId", "stoppedAt", "eventCount",
                    "complete", "omissionCount", "streamSha256", "streamSizeBytes", "streamChunkCount",
                }, "RECORDING.SUCCESSOR_LINEAGE_INVALID", "Frozen-input lineage has unexpected or missing fields.")
        require(lineage.get("schemaVersion") == "omnia.processing-run-recovery-lineage/v1"
                and lineage.get("recoveryKind") == "frozen_input_finalize"
                and lineage.get("predecessorRunId") == predecessor_run_id
                and lineage.get("externalId") == recording_id
                and frozen.get("schemaVersion") == "omnia.recording-frozen-input/v1"
                and isinstance(frozen.get("observationId"), str)
                and re.fullmatch(r"observation_[0-9a-f]{32}", frozen["observationId"]) is not None
                and isinstance(frozen.get("streamId"), str)
                and re.fullmatch(r"stream_[0-9a-f]{32}", frozen["streamId"]) is not None
                and frozen.get("stoppedAt") == stopped_at and frozen.get("eventCount") == event_count
                and frozen.get("complete") is True and frozen.get("omissionCount") == 0
                and isinstance(frozen.get("streamSha256"), str) and _SHA256.fullmatch(frozen["streamSha256"]) is not None
                and isinstance(frozen.get("streamSizeBytes"), int) and not isinstance(frozen["streamSizeBytes"], bool)
                and 0 < frozen["streamSizeBytes"] <= MAX_ARTIFACT_BYTES
                and isinstance(frozen.get("streamChunkCount"), int) and not isinstance(frozen["streamChunkCount"], bool)
                and 0 < frozen["streamChunkCount"] <= 512,
                "RECORDING.SUCCESSOR_LINEAGE_INVALID", "Successor recovery lineage differs from the recording input.")
        adopted_at = _utc_text(dt.datetime.now(dt.timezone.utc))
        purge_after = _utc_text(stopped + STAGING_RETENTION)
        with self.connection:
            session = self._session(recording_id)
            require(session is not None, "RECORDING.SESSION_MISSING", "Recording session is unavailable for successor adoption.")
            require(str(session["state"]) != "finalized" and not session["artifact_json"],
                    "RECORDING.SUCCESSOR_ARTIFACT_CONFLICT", "A finalized or artifact-bearing recording cannot be adopted.")
            existing_started_at = str(session["started_at"] or "")
            existing_stopped_at = str(session["stopped_at"] or "")
            require(not existing_started_at or existing_started_at == started_at,
                    "RECORDING.SUCCESSOR_TIME_DRIFT", "Successor adoption startedAt differs from the retained session.")
            require(not existing_stopped_at or existing_stopped_at == stopped_at,
                    "RECORDING.SUCCESSOR_TIME_DRIFT", "Successor adoption stoppedAt differs from the retained session.")
            owner_run_id = str(session["run_id"])
            require(owner_run_id in {predecessor_run_id, successor_run_id},
                    "RECORDING.SUCCESSOR_OWNER_CONFLICT", "Recording is owned by an unrelated Run.")
            audit = self.connection.execute(
                "SELECT * FROM recording_run_recoveries WHERE predecessor_run_id=? OR successor_run_id=?",
                (predecessor_run_id, successor_run_id),
            ).fetchall()
            if audit:
                require(len(audit) == 1 and str(audit[0]["recording_id"]) == recording_id
                        and str(audit[0]["predecessor_run_id"]) == predecessor_run_id
                        and str(audit[0]["successor_run_id"]) == successor_run_id
                        and str(audit[0]["lineage_digest"]) == lineage_digest
                        and str(audit[0]["lineage_json"]) == lineage_json,
                        "RECORDING.SUCCESSOR_AUDIT_CONFLICT", "Stored successor recovery audit differs from this request.")
            else:
                require(owner_run_id == predecessor_run_id, "RECORDING.SUCCESSOR_AUDIT_MISSING",
                        "Successor-owned session lacks its immutable recovery audit.")
                self.connection.execute(
                    "INSERT INTO recording_run_recoveries(recovery_id,recording_id,predecessor_run_id,successor_run_id,lineage_digest,lineage_json,adopted_at) VALUES(?,?,?,?,?,?,?)",
                    (str(uuid.uuid4()), recording_id, predecessor_run_id, successor_run_id, lineage_digest, lineage_json, adopted_at),
                )
            if owner_run_id == predecessor_run_id:
                updated = self.connection.execute(
                    """
                    UPDATE recording_sessions
                    SET run_id=?,state='finalizing',started_at=?,stopped_at=?,purge_after=?,event_count=?,error_message='',updated_at=?
                    WHERE recording_id=? AND run_id=? AND state!='finalized' AND artifact_json IS NULL
                    """,
                    (successor_run_id, started_at, stopped_at, purge_after, event_count, adopted_at,
                     recording_id, predecessor_run_id),
                )
                require(updated.rowcount == 1, "RECORDING.SUCCESSOR_CAS_CONFLICT",
                        "Recording session changed before successor adoption committed.")
        projection = self.session_projection(recording_id)
        return {
            "schemaVersion": "omnia.recording-successor-adoption/v1",
            "recordingId": recording_id,
            "predecessorRunId": predecessor_run_id,
            "successorRunId": successor_run_id,
            "lineageDigest": lineage_digest,
            "idempotent": owner_run_id == successor_run_id,
            "session": projection,
        }

    def mark_state(self, payload: dict[str, Any], invocation_run_id: str) -> dict[str, Any]:
        recording_id, run_id = self._identities(payload, invocation_run_id)
        self._require_run_owner(recording_id, run_id)
        state = str(payload.get("state") or "")
        require(state in MARKABLE_STATES, "RECORDING.STATE_INVALID", "Recording state is not markable.")
        timestamp = _utc_text(dt.datetime.now(dt.timezone.utc))
        started_at, _ = parse_timestamp(payload.get("startedAt"), "startedAt", required=False)
        stopped_at, stopped = parse_timestamp(payload.get("stoppedAt"), "stoppedAt", required=False)
        error_message = str(payload.get("error") or "").strip()[:MAX_ERROR_CHARS]
        existing = self._session(recording_id)
        if existing is not None:
            require(existing["run_id"] == run_id, "RECORDING.RUN_MISMATCH", "Recording is owned by another Run.")
            require(existing["state"] != "finalized", "RECORDING.ALREADY_FINALIZED", "Finalized recording state is immutable.")
            transitions = {
                "starting": {"starting", "uncertain"},
                "active": {"starting", "active", "paused", "resuming", "pausing", "uncertain"},
                "pausing": {"active", "pausing", "uncertain"},
                "paused": {"active", "pausing", "paused", "resuming", "uncertain"},
                "resuming": {"paused", "resuming", "uncertain"},
                "stopping": {"active", "pausing", "paused", "resuming", "stopping", "uncertain"},
                "failed": {"starting", "active", "pausing", "paused", "resuming", "stopping", "finalizing", "failed", "uncertain"},
                "uncertain": {"starting", "pausing", "resuming", "stopping", "uncertain"},
                "cancelled": {"starting", "active", "pausing", "paused", "resuming", "stopping", "uncertain", "cancelled"},
            }
            require(str(existing["state"]) in transitions[state], "RECORDING.STATE_TRANSITION_INVALID",
                    "Recording state transition is invalid for this recordingId.")
            started_at = started_at or str(existing["started_at"] or "")
            stopped_at = stopped_at or str(existing["stopped_at"] or "")
            if stopped_at:
                _, stopped = parse_timestamp(stopped_at, "stoppedAt")
        require(state not in {"starting", "active"} or bool(started_at),
                "RECORDING.START_TIME_REQUIRED", "Starting or active recording requires startedAt.")
        purge_after = _utc_text(stopped + STAGING_RETENTION) if stopped and state in {"failed", "cancelled"} else ""
        with self.connection:
            self.connection.execute(
                """
                INSERT INTO recording_sessions(
                  recording_id,run_id,state,started_at,stopped_at,finalized_at,purge_after,event_count,catalog_count,
                  metadata_json,artifact_json,error_message,created_at,updated_at
                ) VALUES(?,?,?,?,?,NULL,?,0,0,'{}',NULL,?,?,?)
                ON CONFLICT(recording_id) DO UPDATE SET
                  state=excluded.state,started_at=COALESCE(NULLIF(excluded.started_at,''),recording_sessions.started_at),
                  stopped_at=COALESCE(NULLIF(excluded.stopped_at,''),recording_sessions.stopped_at),
                  purge_after=NULLIF(excluded.purge_after,''),error_message=excluded.error_message,updated_at=excluded.updated_at
                """,
                (recording_id, run_id, state, started_at, stopped_at, purge_after, error_message, timestamp, timestamp),
            )
        return self.session_projection(recording_id)

    def begin_ingest(self, recording_id: str, run_id: str, metadata: dict[str, Any]) -> None:
        self._require_run_owner(recording_id, run_id)
        timestamp = _utc_text(dt.datetime.now(dt.timezone.utc))
        manifest = metadata["manifest"]
        started_at, _ = parse_timestamp(manifest.get("createdAt"), "manifest.createdAt")
        stopped_at, stopped = parse_timestamp(manifest.get("stoppedAt"), "manifest.stoppedAt")
        purge_after = _utc_text(stopped + STAGING_RETENTION)
        existing = self._session(recording_id)
        reset_legacy_derived_rows = False
        if existing is not None:
            require(existing["run_id"] == run_id, "RECORDING.RUN_MISMATCH", "Recording is owned by another Run.")
            require(existing["state"] != "finalized", "RECORDING.ALREADY_FINALIZED", "Finalized recording cannot be ingested again.")
            previous_metadata = parse_json(str(existing["metadata_json"] or "{}"), "STORE.METADATA_CORRUPT", "Stored recording metadata is invalid.")
            compatible_metadata = previous_metadata == {} or previous_metadata == metadata
            if not compatible_metadata and "featureFreeze" not in previous_metadata:
                compatible_metadata = {**previous_metadata, "featureFreeze": metadata.get("featureFreeze")} == metadata
            # A newly marked recording owns an empty metadata object while its
            # canonical NDJSON rows are streamed into SQLite.  Empty metadata is
            # not a legacy parser projection and must not delete those rows.
            reset_legacy_derived_rows = (
                compatible_metadata and previous_metadata != {} and "featureFreeze" not in previous_metadata
            )
            require(compatible_metadata,
                    "RECORDING.METADATA_CONFLICT", "Recording retry metadata conflicts with staged content.")
        with self.connection:
            if reset_legacy_derived_rows:
                # These rows were derived by the pre-migration parser. The raw
                # immutable transfer has already passed handle/digest checks and
                # its metadata is byte-equivalent, so rebuild them under the
                # Feature-owned parser instead of accepting conflicting summaries.
                self.connection.execute("DELETE FROM recording_events WHERE recording_id=?", (recording_id,))
                self.connection.execute("DELETE FROM recording_catalogs WHERE recording_id=?", (recording_id,))
            self.connection.execute(
                """
                INSERT INTO recording_sessions(
                  recording_id,run_id,state,started_at,stopped_at,finalized_at,purge_after,event_count,catalog_count,
                  metadata_json,artifact_json,error_message,created_at,updated_at
                ) VALUES(?,?,'finalizing',?,?,NULL,?,0,0,?,NULL,'',?,?)
                ON CONFLICT(recording_id) DO UPDATE SET
                  state='finalizing',started_at=excluded.started_at,stopped_at=excluded.stopped_at,finalized_at=NULL,
                  purge_after=excluded.purge_after,metadata_json=excluded.metadata_json,
                  artifact_json=NULL,error_message='',updated_at=excluded.updated_at
                """,
                (recording_id, run_id, started_at, stopped_at, purge_after, canonical_json(metadata), timestamp, timestamp),
            )

    def insert_batch(
        self,
        recording_id: str,
        events: Iterable[tuple[str, str, int, str]],
        catalogs: Iterable[tuple[str, str, str, int, str, str]],
        event_count: int,
        catalog_count: int,
    ) -> None:
        with self.connection:
            for row in events:
                existing = self.connection.execute(
                    "SELECT recording_id,sequence,event_json FROM recording_events WHERE event_key=?", (row[0],)
                ).fetchone()
                if existing is None:
                    self.connection.execute(
                        "INSERT INTO recording_events(event_key,recording_id,sequence,event_json) VALUES(?,?,?,?)", row
                    )
                else:
                    require((str(existing["recording_id"]), int(existing["sequence"]), str(existing["event_json"])) == row[1:],
                            "RECORDING.EVENT_CONFLICT", "Recording retry contains conflicting event content.")
            for row in catalogs:
                existing = self.connection.execute(
                    "SELECT recording_id,stable_id,sequence,metadata_json,catalog_json FROM recording_catalogs WHERE catalog_key=?", (row[0],)
                ).fetchone()
                if existing is None:
                    self.connection.execute(
                        "INSERT INTO recording_catalogs(catalog_key,recording_id,stable_id,sequence,metadata_json,catalog_json) VALUES(?,?,?,?,?,?)",
                        row,
                    )
                else:
                    require(
                        (str(existing["recording_id"]), str(existing["stable_id"]), int(existing["sequence"]),
                         str(existing["metadata_json"]), str(existing["catalog_json"])) == row[1:],
                        "RECORDING.CATALOG_CONFLICT", "Recording retry contains conflicting Catalog content."
                    )
            self.connection.execute(
                "UPDATE recording_sessions SET event_count=?,catalog_count=?,updated_at=? WHERE recording_id=? AND state='finalizing'",
                (event_count, catalog_count, _utc_text(dt.datetime.now(dt.timezone.utc)), recording_id),
            )

    def complete_ingest(self, recording_id: str, event_count: int, catalog_count: int) -> dict[str, Any]:
        actual_events = self.connection.execute(
            "SELECT COUNT(*) AS count,COUNT(DISTINCT sequence) AS distinct_count,COALESCE(MIN(sequence),0) AS minimum,COALESCE(MAX(sequence),0) AS maximum FROM recording_events WHERE recording_id=?",
            (recording_id,),
        ).fetchone()
        actual_catalogs = self.connection.execute(
            "SELECT COUNT(*) AS count,COUNT(DISTINCT sequence) AS distinct_count,COALESCE(MIN(sequence),0) AS minimum,COALESCE(MAX(sequence),0) AS maximum FROM recording_catalogs WHERE recording_id=?",
            (recording_id,),
        ).fetchone()
        require(int(actual_events["count"]) == event_count and int(actual_events["distinct_count"]) == event_count
                and int(actual_events["minimum"]) == (1 if event_count else 0) and int(actual_events["maximum"]) == event_count,
                "RECORDING.EVENT_COUNT_CONFLICT", "Staged recording events do not match the complete input.")
        require(int(actual_catalogs["count"]) == catalog_count and int(actual_catalogs["distinct_count"]) == catalog_count
                and int(actual_catalogs["minimum"]) == (1 if catalog_count else 0) and int(actual_catalogs["maximum"]) == catalog_count,
                "RECORDING.CATALOG_COUNT_CONFLICT", "Staged recording Catalogs do not match the complete input.")
        with self.connection:
            cursor = self.connection.execute(
                "UPDATE recording_sessions SET event_count=?,catalog_count=?,updated_at=? WHERE recording_id=? AND state='finalizing'",
                (event_count, catalog_count, _utc_text(dt.datetime.now(dt.timezone.utc)), recording_id),
            )
        require(cursor.rowcount == 1, "RECORDING.SESSION_LOST", "Recording finalization session is unavailable.")
        return self.session_projection(recording_id)

    def fail_ingest(self, recording_id: str, run_id: str, message: str, stopped_at: str = "") -> None:
        """Retain every validated SQLite row so the same frozen input can resume safely."""
        timestamp = _utc_text(dt.datetime.now(dt.timezone.utc))
        existing = self._session(recording_id)
        if existing is not None and existing["run_id"] != run_id:
            return
        if existing is not None and existing["state"] == "finalized":
            return
        if existing is None:
            # The supported Worker path always writes the Feature-private
            # session before ingest. Rows without that owner cannot be
            # recovered or retained safely.
            with self.connection:
                self.connection.execute("DELETE FROM recording_events WHERE recording_id=?", (recording_id,))
                self.connection.execute("DELETE FROM recording_catalogs WHERE recording_id=?", (recording_id,))
            return
        stopped_text, purge_after = self._retention_window(existing, stopped_at)
        event_count = int(self.connection.execute(
            "SELECT COUNT(*) FROM recording_events WHERE recording_id=?", (recording_id,)
        ).fetchone()[0])
        catalog_count = int(self.connection.execute(
            "SELECT COUNT(*) FROM recording_catalogs WHERE recording_id=?", (recording_id,)
        ).fetchone()[0])
        with self.connection:
            self.connection.execute(
                "UPDATE recording_sessions SET state='failed',stopped_at=COALESCE(NULLIF(?,''),stopped_at),purge_after=NULLIF(?,''),event_count=?,catalog_count=?,error_message=?,updated_at=? WHERE recording_id=? AND run_id=? AND state!='finalized'",
                (stopped_text, purge_after, event_count, catalog_count,
                 str(message)[:MAX_ERROR_CHARS], timestamp, recording_id, run_id),
            )

    def fail_finalization(self, recording_id: str, run_id: str, message: str, stopped_at: str = "") -> None:
        """Mark Artifact finalization failed without discarding complete staged evidence."""
        timestamp = _utc_text(dt.datetime.now(dt.timezone.utc))
        existing = self._session(recording_id)
        if existing is None or existing["run_id"] != run_id or existing["state"] == "finalized":
            return
        stopped_text, purge_after = self._retention_window(existing, stopped_at)
        with self.connection:
            self.connection.execute(
                "UPDATE recording_sessions SET state='failed',stopped_at=COALESCE(NULLIF(?,''),stopped_at),purge_after=NULLIF(?,''),error_message=?,updated_at=? WHERE recording_id=? AND run_id=? AND state!='finalized'",
                (stopped_text, purge_after, str(message)[:MAX_ERROR_CHARS], timestamp, recording_id, run_id),
            )

    def mark_finalized(self, payload: dict[str, Any], invocation_run_id: str) -> dict[str, Any]:
        recording_id, run_id = self._identities(payload, invocation_run_id)
        finalized_at, finalized = parse_timestamp(payload.get("finalizedAt"), "finalizedAt")
        artifact = payload.get("artifact")
        require(isinstance(artifact, dict), "RECORDING.ARTIFACT_INVALID", "Finalized recording requires a Core Artifact.")
        require_uuid(artifact.get("artifactId"), "artifact.artifactId")
        digest = str(artifact.get("sha256") or "").lower()
        size_bytes = artifact.get("sizeBytes")
        require(_SHA256.fullmatch(digest) is not None and isinstance(size_bytes, int) and not isinstance(size_bytes, bool) and 0 < size_bytes <= MAX_ARTIFACT_BYTES,
                "RECORDING.ARTIFACT_INVALID", "Core Artifact identity, size, or digest is invalid.")
        require(artifact.get("available") is not False, "RECORDING.ARTIFACT_INVALID", "Unavailable Artifact cannot finalize a recording.")
        existing = self._session(recording_id)
        require(existing is not None and existing["run_id"] == run_id, "RECORDING.SESSION_MISSING", "Recording session is unavailable for finalization.")
        artifact_json = canonical_json(artifact)
        if existing["state"] == "finalized":
            require(str(existing["artifact_json"] or "") == artifact_json,
                    "RECORDING.ARTIFACT_CONFLICT", "Finalized recording is already bound to another Core Artifact.")
            return self._projection(existing)
        stopped_at = str(existing["stopped_at"] or "")
        require(bool(stopped_at), "RECORDING.STOP_TIME_REQUIRED", "Finalized recording requires stoppedAt.")
        _, stopped = parse_timestamp(stopped_at, "stoppedAt")
        purge_after = _utc_text(stopped + STAGING_RETENTION)
        with self.connection:
            self.connection.execute(
                "UPDATE recording_sessions SET state='finalized',finalized_at=?,purge_after=?,artifact_json=?,error_message='',updated_at=? WHERE recording_id=? AND run_id=?",
                (finalized_at, purge_after, artifact_json, _utc_text(finalized), recording_id, run_id),
            )
        return self.session_projection(recording_id)

    def maintenance(self, payload: dict[str, Any]) -> dict[str, Any]:
        now_text, now_value = parse_timestamp(payload.get("now"), "maintenance.now")
        requested = payload.get("limit", 20)
        require(isinstance(requested, int) and not isinstance(requested, bool) and requested == 20,
                "RECORDING.LIMIT_INVALID", "Maintenance history limit must be exactly 20 sessions.")
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            purge_ids = self._expired_terminal_recording_ids(now_value)
            self._purge_terminal_recordings(purge_ids)
            sessions = self._recent_session_projections(requested)
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise
        return {
            "schemaVersion": "omnia.recording.maintenance-result/v1",
            "maintainedAt": now_text,
            "purgedRecordingIds": purge_ids,
            "sessions": sessions,
        }

    def _expired_terminal_recording_ids(self, now_value: dt.datetime) -> list[str]:
        rows = self.connection.execute(
            "SELECT recording_id,stopped_at FROM recording_sessions WHERE state IN ('finalized','failed','cancelled') AND stopped_at IS NOT NULL AND stopped_at!=''"
        ).fetchall()
        expired: list[str] = []
        for row in rows:
            _, stopped = parse_timestamp(row["stopped_at"], "stored stoppedAt")
            if now_value >= stopped + STAGING_RETENTION:
                expired.append(str(row["recording_id"]))
        return sorted(expired)

    def _purge_terminal_recordings(self, recording_ids: list[str]) -> None:
        if not recording_ids:
            return
        parameters = [(recording_id,) for recording_id in recording_ids]
        self.connection.executemany("DELETE FROM recording_events WHERE recording_id=?", parameters)
        self.connection.executemany("DELETE FROM recording_catalogs WHERE recording_id=?", parameters)
        self.connection.executemany(
            "DELETE FROM recording_sessions WHERE recording_id=? AND state IN ('finalized','failed','cancelled')", parameters
        )

    def _recent_session_projections(self, limit: int) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT * FROM recording_sessions ORDER BY updated_at DESC, recording_id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [self._projection(row) for row in rows]

    @staticmethod
    def _retention_window(existing: sqlite3.Row | None, stopped_at: str) -> tuple[str, str]:
        stopped_text, stopped = parse_timestamp(stopped_at, "stoppedAt", required=False)
        if not stopped_text and existing is not None:
            stopped_text = str(existing["stopped_at"] or "")
            if stopped_text:
                _, stopped = parse_timestamp(stopped_text, "stoppedAt")
        return stopped_text, _utc_text(stopped + STAGING_RETENTION) if stopped else ""

    def session_projection(self, recording_id: str) -> dict[str, Any]:
        row = self._session(recording_id)
        require(row is not None, "RECORDING.SESSION_MISSING", "Recording session is unavailable.")
        return self._projection(row)

    def metadata(self, recording_id: str) -> dict[str, Any]:
        row = self._session(recording_id)
        require(row is not None, "RECORDING.SESSION_MISSING", "Recording session is unavailable.")
        return parse_json(str(row["metadata_json"]), "STORE.METADATA_CORRUPT", "Stored recording metadata is invalid.")

    def event_rows(self, recording_id: str) -> sqlite3.Cursor:
        return self.connection.execute(
            "SELECT sequence,event_json FROM recording_events WHERE recording_id=? ORDER BY sequence", (recording_id,)
        )

    def catalog_rows(self, recording_id: str) -> sqlite3.Cursor:
        return self.connection.execute(
            "SELECT sequence,metadata_json,catalog_json FROM recording_catalogs WHERE recording_id=? ORDER BY sequence", (recording_id,)
        )

    def _session(self, recording_id: str) -> sqlite3.Row | None:
        return self.connection.execute("SELECT * FROM recording_sessions WHERE recording_id=?", (recording_id,)).fetchone()

    def _require_run_owner(self, recording_id: str, run_id: str) -> None:
        owners = self.connection.execute("SELECT recording_id FROM recording_sessions WHERE run_id=?", (run_id,)).fetchall()
        require(len(owners) <= 1 and (not owners or str(owners[0]["recording_id"]) == recording_id),
                "RECORDING.RUN_CONFLICT", "Processing Run is already bound to another recordingId.")

    @staticmethod
    def _identities(payload: dict[str, Any], invocation_run_id: str) -> tuple[str, str]:
        recording_id = require_uuid(payload.get("recordingId"), "recordingId")
        run_id = require_uuid(payload.get("runId"), "payload.runId")
        require(run_id == invocation_run_id, "RECORDING.RUN_MISMATCH", "Payload Run does not match the active invocation.")
        return recording_id, run_id

    @staticmethod
    def _projection(row: sqlite3.Row) -> dict[str, Any]:
        artifact = None
        if row["artifact_json"]:
            artifact = parse_json(str(row["artifact_json"]), "STORE.ARTIFACT_CORRUPT", "Stored Artifact projection is invalid.")
        return {
            "recordingId": str(row["recording_id"]),
            "runId": str(row["run_id"]),
            "state": str(row["state"]),
            "startedAt": str(row["started_at"] or ""),
            "stoppedAt": str(row["stopped_at"] or ""),
            "finalizedAt": str(row["finalized_at"] or ""),
            "purgeAfter": str(row["purge_after"] or ""),
            "eventCount": int(row["event_count"] or 0),
            "catalogCount": int(row["catalog_count"] or 0),
            "artifact": artifact,
            "error": str(row["error_message"] or ""),
            "createdAt": str(row["created_at"]),
            "updatedAt": str(row["updated_at"]),
        }
