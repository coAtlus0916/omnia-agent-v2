"""Length-prefixed stdio RPC for the managed recording Python sidecar."""

from __future__ import annotations

import hashlib
import base64
import json
import os
import platform
import sqlite3
import struct
import sys
from collections.abc import Iterator
from typing import Any, BinaryIO

from export import write_recording_artifact
from gra_catalog import rebuild_catalogs_from_observation_evidence
from recording_store import (
    MAX_ARTIFACT_BYTES,
    MAX_RECORDING_EVENTS,
    AuthorizedHandle,
    RecordingError,
    RecordingStore,
    RuntimeScope,
    canonical_json,
    parse_json,
    parse_timestamp,
    require,
    require_text,
    require_uuid,
)


PROTOCOL = "omnia.python-sidecar-rpc/v1"
MAX_FRAME_BYTES = 1024 * 1024
MAX_NDJSON_LINE_BYTES = 16 * 1024 * 1024
CAPABILITIES = ["adopt_successor_run", "ingest_and_export", "maintenance", "mark_finalized", "mark_state"]
PYTHON_VERSION = "3.13.14"


class RecordingSidecar:
    def __init__(self) -> None:
        require(platform.python_version() == PYTHON_VERSION, "SIDECAR.PYTHON_VERSION_INVALID", "Managed CPython version is invalid.")
        require(os.environ.get("OMNIA_PYTHON_PROTOCOL") == PROTOCOL, "SIDECAR.PROTOCOL_ENV_INVALID", "Managed sidecar protocol environment is invalid.")
        self.scope = RuntimeScope()
        self.store = RecordingStore(self.scope)
        self.scope.install()
        self.hello_received = False
        self.running = True

    def close(self) -> None:
        self.store.close()

    def dispatch(self, frame: dict[str, Any]) -> dict[str, Any]:
        request_id = _request_id(frame)
        require(frame.get("schemaVersion") == PROTOCOL, "PROTOCOL.SCHEMA_INVALID", "RPC schemaVersion is invalid.")
        frame_type = str(frame.get("type") or "")
        require(frame_type in {"hello", "invoke", "heartbeat", "shutdown"}, "PROTOCOL.TYPE_DENIED", "RPC message type is denied.")
        if frame_type == "hello":
            require(not self.hello_received, "PROTOCOL.HELLO_DUPLICATE", "hello may only be sent once.")
            require(frame.get("protocol") == PROTOCOL and frame.get("pythonVersion") == PYTHON_VERSION,
                    "PROTOCOL.HELLO_MISMATCH", "RPC hello identity is invalid.")
            require(frame.get("maxFrameBytes") == MAX_FRAME_BYTES and frame.get("networkPolicy") == "deny"
                    and frame.get("storePathPolicy") == "feature_private",
                    "PROTOCOL.HELLO_POLICY_MISMATCH", "RPC hello policy is invalid.")
            self.hello_received = True
            return {
                "schemaVersion": PROTOCOL,
                "type": "ready",
                "requestId": request_id,
                "protocol": PROTOCOL,
                "pythonVersion": PYTHON_VERSION,
                "maxFrameBytes": MAX_FRAME_BYTES,
                "networkPolicy": "deny",
                "storePathPolicy": "feature_private",
                "userSite": False,
                "binaryTransfer": "managed_artifact_handle",
                "capabilities": CAPABILITIES,
            }
        require(self.hello_received, "PROTOCOL.HELLO_REQUIRED", "hello must precede all other RPC frames.")
        if frame_type == "heartbeat":
            return {"schemaVersion": PROTOCOL, "type": "heartbeat_ack", "requestId": request_id}
        if frame_type == "shutdown":
            self.running = False
            return _result(request_id, {"shutdown": True})
        run_id = self.scope.bind_invocation(frame.get("runId"))
        try:
            method = str(frame.get("method") or "")
            payload = frame.get("payload")
            require(method in CAPABILITIES and isinstance(payload, dict), "PYTHON.METHOD_DENIED", "Recording sidecar method or payload is denied.")
            if method == "maintenance":
                value = self.store.maintenance(payload)
            elif method == "adopt_successor_run":
                value = self.store.adopt_successor_run(payload, run_id)
            elif method == "mark_state":
                value = self.store.mark_state(payload, run_id)
            elif method == "mark_finalized":
                value = self.store.mark_finalized(payload, run_id)
            else:
                value = self._ingest_and_export(payload, run_id)
            return _result(request_id, value)
        finally:
            self.scope.clear_invocation()

    def _ingest_and_export(self, payload: dict[str, Any], invocation_run_id: str) -> dict[str, Any]:
        request = _validate_ingest_request(payload, invocation_run_id, self.scope)
        recording_id = request["recordingId"]
        run_id = request["runId"]
        input_handle = request["inputHandle"]
        output_handle = request["outputHandle"]
        status = request["status"]
        stopped_at = request["stoppedAt"]
        ingest_completed = False
        try:
            observed = _ingest_observation_events(
                self.store, recording_id, input_handle, status,
                request["streamSizeBytes"], request["streamSha256"]
            )
            event_count = observed["eventCount"]
            catalogs = rebuild_catalogs_from_observation_evidence(
                observed["responseEvidence"], recording_id
            )
            catalog_rows = _catalog_rows(recording_id, catalogs)
            catalog_count = len(catalog_rows)
            metadata = _observation_metadata(
                recording_id, status, request["streamSizeBytes"], request["streamSha256"],
                event_count, catalog_count, observed["pauseCount"]
            )
            self.store.begin_ingest(recording_id, run_id, metadata)
            if catalog_rows:
                self.store.insert_batch(recording_id, [], catalog_rows, event_count, catalog_count)
            session = self.store.complete_ingest(recording_id, event_count, catalog_count)
            ingest_completed = True
            output_size, output_sha256 = write_recording_artifact(self.store, recording_id, output_handle)
            metrics = _observation_metrics(observed["interactionCount"], observed["networkRequestCount"], catalogs)
            return {
                "schemaVersion": "omnia.recording.ingest-export-result/v1",
                "recordingId": recording_id,
                "runId": run_id,
                "artifact": output_handle.updated(size_bytes=output_size, sha256=output_sha256),
                "sizeBytes": output_size,
                "sha256": output_sha256,
                "eventCount": event_count,
                "catalogCount": catalog_count,
                "metrics": metrics,
                "stoppedAt": session["stoppedAt"],
                "purgeAfter": session["purgeAfter"],
            }
        except Exception as exc:
            message = str(exc) if isinstance(exc, RecordingError) else "Recording NDJSON ingestion failed."
            if ingest_completed:
                self.store.fail_finalization(recording_id, run_id, message, stopped_at)
            else:
                self.store.fail_ingest(recording_id, run_id, message, stopped_at)
            raise


def _validate_ingest_request(payload: dict[str, Any], invocation_run_id: str, scope: RuntimeScope) -> dict[str, Any]:
    """Authorize one stopped observation and its Core-managed input/output handles."""

    recording_id = require_uuid(payload.get("recordingId"), "recordingId")
    run_id = require_uuid(payload.get("runId"), "payload.runId")
    require(run_id == invocation_run_id, "RECORDING.RUN_MISMATCH", "Payload Run does not match the active invocation.")
    input_handle = scope.authorize_handle(payload.get("inputHandle"), required_access="read")
    output_handle = scope.authorize_handle(payload.get("outputHandle"), required_access="write")
    status = payload.get("observationStatus")
    require(isinstance(status, dict) and status.get("schemaVersion") == "omnia.page-observation-status/v1"
            and status.get("state") == "stopped" and status.get("complete") is True
            and status.get("omissionCount") == 0,
            "RECORDING.OBSERVATION_INCOMPLETE", "Only a complete stopped page observation can become a normal recording Artifact.")
    observation_id = require_text(status.get("observationId"), "observationId", 80)
    require(observation_id.startswith("observation_") and len(observation_id) == 44,
            "RECORDING.OBSERVATION_ID_INVALID", "Page observation identity is invalid.")
    stream_id = require_text(status.get("streamId"), "streamId", 80)
    require(stream_id.startswith("stream_") and len(stream_id) == 39,
            "RECORDING.STREAM_ID_INVALID", "Page observation stream identity is invalid.")
    stream_size_bytes = payload.get("streamSizeBytes")
    stream_sha256 = str(payload.get("streamSha256") or "")
    require(isinstance(stream_size_bytes, int) and not isinstance(stream_size_bytes, bool)
            and 0 < stream_size_bytes <= MAX_ARTIFACT_BYTES and len(stream_sha256) == 64
            and all(character in "0123456789abcdef" for character in stream_sha256),
            "HANDLE.STREAM_DIGEST_MISMATCH", "Managed stream identity is invalid.")
    ndjson_input = input_handle.media_type == "application/x-ndjson" and input_handle.original_name.lower().endswith(".ndjson")
    frozen_json_input = input_handle.media_type == "application/json" and input_handle.original_name.lower().endswith(".json")
    require(ndjson_input or frozen_json_input, "HANDLE.MEDIA_TYPE_INVALID",
            "Recording input handle must contain managed NDJSON or its Core-managed frozen JSON projection.")
    if ndjson_input:
        require(stream_size_bytes == input_handle.size_bytes and stream_sha256 == input_handle.sha256,
                "HANDLE.STREAM_DIGEST_MISMATCH", "Managed stream identity differs from its Core input handle.")
    require(output_handle.media_type == "application/json" and output_handle.original_name.lower().endswith(".json"),
            "HANDLE.MEDIA_TYPE_INVALID", "Recording output handle must be JSON.")
    require(input_handle.run_id == run_id and output_handle.run_id == run_id,
            "HANDLE.RUN_BINDING_MISMATCH", "Recording input and output handles must share the active Run.")
    started_at = str(status.get("startedAt") or "")
    stopped_at = str(status.get("stoppedAt") or "")
    parse_timestamp(started_at, "observationStatus.startedAt")
    parse_timestamp(stopped_at, "observationStatus.stoppedAt")
    return {
        "recordingId": recording_id, "runId": run_id, "inputHandle": input_handle,
        "outputHandle": output_handle, "status": status, "observationId": observation_id,
        "streamId": stream_id, "stoppedAt": stopped_at,
        "streamSizeBytes": stream_size_bytes, "streamSha256": stream_sha256,
    }


def _ingest_observation_events(
    store: RecordingStore, recording_id: str, input_handle: AuthorizedHandle, status: dict[str, Any],
    stream_size_bytes: int, stream_sha256: str
) -> dict[str, Any]:
    """Validate canonical NDJSON and persist ordered events in bounded SQLite batches."""

    _verify_plain_handle(input_handle)
    event_count = 0
    event_rows: list[tuple[str, str, int, str]] = []
    records_in_batch = 0
    batch_bytes = 0
    response_metadata: dict[str, dict[str, Any]] = {}
    response_segments: dict[str, dict[str, Any]] = {}
    interaction_count = 0
    network_request_count = 0
    pause_count = 0
    observation_id = str(status["observationId"])
    for record in _iter_observation_records(input_handle, stream_size_bytes, stream_sha256):
        event_count += 1
        require(event_count <= MAX_RECORDING_EVENTS and record.get("schemaVersion") == "omnia.page-observation-event/v1"
                and record.get("observationId") == observation_id and record.get("sequence") == event_count,
                "RECORDING.EVENT_SEQUENCE_INVALID", "Page observation event identity or sequence is invalid.")
        parse_timestamp(record.get("occurredAt"), f"event[{event_count}].occurredAt")
        target = record.get("target")
        require(isinstance(target, dict) and target.get("engagementId") == status.get("engagementId"),
                "RECORDING.EVENT_TARGET_DRIFT", "Page observation event escaped the frozen Engagement.")
        event_json = canonical_json(record)
        event_rows.append((f"{recording_id}:event:{event_count}", recording_id, event_count, event_json))
        batch_bytes += len(event_json.encode("utf-8"))
        kind = str(record.get("kind") or "")
        interaction_count += int(kind == "page.interaction")
        network_request_count += int(kind == "network.request")
        pause_count += int(kind == "observation.paused")
        _collect_response_evidence(record, response_metadata, response_segments)
        records_in_batch += 1
        if records_in_batch == 500 or batch_bytes >= 4 * 1024 * 1024:
            store.insert_batch(recording_id, event_rows, [], event_count, 0)
            event_rows.clear()
            records_in_batch = 0
            batch_bytes = 0
    require(event_count == status.get("eventCount") == status.get("lastSequence"),
            "RECORDING.EVENT_COUNT_DRIFT", "Page observation stream count differs from its terminal status.")
    if records_in_batch:
        store.insert_batch(recording_id, event_rows, [], event_count, 0)
    return {
        "eventCount": event_count, "interactionCount": interaction_count,
        "networkRequestCount": network_request_count, "pauseCount": pause_count,
        "responseEvidence": _assembled_response_evidence(response_metadata, response_segments),
    }


def _catalog_rows(
    recording_id: str, catalogs: list[tuple[dict[str, Any], dict[str, Any]]]
) -> list[tuple[str, str, str, int, str, str]]:
    """Convert Feature-owned reconstructed catalogs into deterministic SQLite rows."""

    rows: list[tuple[str, str, str, int, str, str]] = []
    for index, (catalog_metadata, catalog) in enumerate(catalogs, start=1):
        stable_id = require_uuid(catalog.get("identity", {}).get("gra", {}).get("id"), "catalog.gra.id")
        rows.append((f"{recording_id}:catalog:{index}", recording_id, stable_id, index,
                     canonical_json(catalog_metadata), canonical_json(catalog)))
    return rows


def _verify_plain_handle(handle: AuthorizedHandle) -> None:
    try:
        actual_size = os.path.getsize(handle.path)
        require(actual_size == handle.size_bytes and 0 < actual_size <= MAX_ARTIFACT_BYTES,
                "HANDLE.SIZE_MISMATCH", "Page observation stream size does not match its managed Core handle.")
        digest = hashlib.sha256()
        total = 0
        with open(handle.path, "rb") as stream:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                require(total <= handle.size_bytes, "HANDLE.SIZE_MISMATCH", "Page observation stream exceeded its frozen size.")
                digest.update(chunk)
        require(total == handle.size_bytes and digest.hexdigest() == handle.sha256,
                "HANDLE.DIGEST_MISMATCH", "Page observation stream size or digest does not match its managed Core handle.")
    except RecordingError:
        raise
    except OSError as exc:
        raise RecordingError("HANDLE.READ_FAILED", "Page observation stream could not be read.") from exc


def _iter_strict_ndjson_lines(filename: str) -> Iterator[bytes]:
    """Yield canonical LF-terminated records from one bounded managed NDJSON stream."""

    try:
        with open(filename, "rb") as stream:
            while True:
                line = stream.readline(MAX_NDJSON_LINE_BYTES + 1)
                if line == b"":
                    break
                require(len(line) <= MAX_NDJSON_LINE_BYTES and line.endswith(b"\n") and not line.endswith(b"\r\n"),
                        "RECORDING.NDJSON_CANONICAL_INVALID", "Page observation NDJSON contains an oversized or noncanonical line.")
                yield line
    except RecordingError:
        raise
    except OSError as exc:
        raise RecordingError("HANDLE.READ_FAILED", "Page observation stream could not be read.") from exc


def _iter_observation_records(
    input_handle: AuthorizedHandle, stream_size_bytes: int, stream_sha256: str
) -> Iterator[dict[str, Any]]:
    if input_handle.media_type == "application/x-ndjson":
        for raw_line in _iter_strict_ndjson_lines(input_handle.path):
            try:
                text = raw_line[:-1].decode("utf-8", errors="strict")
            except UnicodeDecodeError as exc:
                raise RecordingError("RECORDING.NDJSON_UTF8_INVALID", "Page observation NDJSON is not valid UTF-8.") from exc
            require(bool(text), "RECORDING.NDJSON_EMPTY_LINE", "Connector NDJSON contains an empty record.")
            yield parse_json(text, "RECORDING.NDJSON_RECORD_INVALID", "Connector NDJSON record is invalid.")
        return
    try:
        with open(input_handle.path, "r", encoding="utf-8", errors="strict") as stream:
            projection = json.load(stream)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RecordingError("RECORDING.FROZEN_JSON_INVALID", "Frozen observation JSON projection is invalid.") from exc
    require(isinstance(projection, dict)
            and projection.get("schemaVersion") == "omnia.recording.frozen-input/v1"
            and projection.get("streamSizeBytes") == stream_size_bytes
            and projection.get("streamSha256") == stream_sha256
            and isinstance(projection.get("streamChunkCount"), int)
            and not isinstance(projection.get("streamChunkCount"), bool)
            and 0 < projection["streamChunkCount"] <= 512
            and isinstance(projection.get("events"), list),
            "RECORDING.FROZEN_JSON_IDENTITY_MISMATCH", "Frozen observation JSON identity differs from the stopped stream.")
    for record in projection["events"]:
        require(isinstance(record, dict), "RECORDING.NDJSON_RECORD_INVALID", "Frozen observation event is invalid.")
        yield record


def _collect_response_evidence(
    event: dict[str, Any],
    responses: dict[str, dict[str, Any]],
    segments: dict[str, dict[str, Any]],
) -> None:
    kind = str(event.get("kind") or "")
    payload = event.get("payload")
    if not isinstance(payload, dict):
        return
    request_id = str(payload.get("requestId") or "")
    if not request_id or len(request_id) > 80:
        return
    if kind == "network.response":
        if str(payload.get("method") or "").upper() != "GET" or request_id in responses:
            return
        require(len(responses) < MAX_RECORDING_EVENTS, "RECORDING.RESPONSE_LIMIT", "Page observation contains too many response records.")
        status = payload.get("status")
        require(isinstance(status, int) and not isinstance(status, bool) and 100 <= status <= 599,
                "RECORDING.RESPONSE_INVALID", "Page observation response status is invalid.")
        url = require_text(payload.get("url"), "response.url", 4_096)
        responses[request_id] = {
            "requestId": request_id, "method": "GET", "url": url, "status": status,
            "occurredAt": str(event.get("occurredAt") or ""),
        }
        return
    if kind != "network.response-body.segment":
        return
    require(request_id in responses, "RECORDING.RESPONSE_SEGMENT_ORPHAN", "Response body segment has no observed GET response.")
    part_index = payload.get("partIndex")
    part_count = payload.get("partCount")
    digest = str(payload.get("bodyDigest") or "")
    encoded = payload.get("bytesBase64")
    require(payload.get("encoding") == "utf8-json-base64"
            and isinstance(part_index, int) and not isinstance(part_index, bool) and part_index >= 0
            and isinstance(part_count, int) and not isinstance(part_count, bool) and 1 <= part_count <= 32
            and part_index < part_count and len(digest) == 64
            and all(char in "0123456789abcdef" for char in digest)
            and isinstance(encoded, str),
            "RECORDING.RESPONSE_SEGMENT_INVALID", "Response body segment metadata is invalid.")
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as exc:
        raise RecordingError("RECORDING.RESPONSE_SEGMENT_INVALID", "Response body segment base64 is invalid.") from exc
    require(base64.b64encode(decoded).decode("ascii") == encoded,
            "RECORDING.RESPONSE_SEGMENT_INVALID", "Response body segment base64 is noncanonical.")
    group = segments.setdefault(request_id, {"partCount": part_count, "bodyDigest": digest,
                                             "contentType": str(payload.get("contentType") or "")[:200], "parts": {}})
    require(group["partCount"] == part_count and group["bodyDigest"] == digest,
            "RECORDING.RESPONSE_SEGMENT_DRIFT", "Response body segment identity drifted.")
    prior = group["parts"].get(part_index)
    require(prior is None or prior == decoded, "RECORDING.RESPONSE_SEGMENT_CONFLICT", "Response body segment was duplicated with different bytes.")
    group["parts"][part_index] = decoded


def _assembled_response_evidence(
    responses: dict[str, dict[str, Any]], segments: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for request_id, response in responses.items():
        row = dict(response)
        group = segments.get(request_id)
        if group is None:
            continue
        require(len(result) < 2_000, "RECORDING.RESPONSE_LIMIT", "Page observation contains too many captured JSON responses.")
        part_count = int(group["partCount"])
        parts = group["parts"]
        require(len(parts) == part_count and all(index in parts for index in range(part_count)),
                "RECORDING.RESPONSE_SEGMENT_INCOMPLETE", "Observed JSON response body is missing one or more segments.")
        body = b"".join(parts[index] for index in range(part_count))
        require(len(body) <= 1024 * 1024 and hashlib.sha256(body).hexdigest() == group["bodyDigest"],
                "RECORDING.RESPONSE_BODY_DIGEST", "Observed JSON response body size or digest is invalid.")
        try:
            parsed = json.loads(
                body.decode("utf-8", errors="strict"),
                parse_constant=lambda _value: (_ for _ in ()).throw(ValueError()),
            )
            canonical_json(parsed)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecordingError) as exc:
            raise RecordingError("RECORDING.RESPONSE_BODY_INVALID", "Observed response body is not UTF-8 JSON.") from exc
        row.update({"contentType": str(group["contentType"]), "responseCaptured": True,
                    "bodyDigest": str(group["bodyDigest"]), "response": parsed})
        result.append(row)
    return result


def _observation_metadata(
    recording_id: str,
    status: dict[str, Any],
    stream_size_bytes: int,
    stream_sha256: str,
    event_count: int,
    catalog_count: int,
    pause_count: int,
) -> dict[str, Any]:
    started_at = str(status.get("startedAt") or "")
    stopped_at = str(status.get("stoppedAt") or "")
    _, started_dt = parse_timestamp(started_at, "observationStatus.startedAt")
    _, stopped_dt = parse_timestamp(stopped_at, "observationStatus.stoppedAt")
    elapsed_ms = max(0, int((stopped_dt - started_dt).total_seconds() * 1000))
    return {
        "manifest": {
            "format": "omnia-v5-recorder/v1", "source": "page-observation", "recordingId": recording_id,
            "engagementId": str(status.get("engagementId") or "").lower(), "createdAt": started_at,
            "stoppedAt": stopped_at, "preparedAt": stopped_at, "state": "complete", "elapsedMs": elapsed_ms,
            "pauseCount": pause_count, "eventCount": event_count, "droppedEventCount": 0,
            "integrity": {"complete": True, "omissionCount": 0, "streamSha256": stream_sha256,
                          "streamSizeBytes": stream_size_bytes},
            "capture": {"graCount": catalog_count},
        },
        "security": {"headersPersisted": False, "credentialsPersisted": False,
                     "sourceRedaction": "connector-fixed-v1"},
        "featureFreeze": {
            "schemaVersion": "omnia.recording.feature-freeze/v1", "transport": "managed-page-observation-ndjson",
            "observationId": str(status.get("observationId") or ""), "streamId": str(status.get("streamId") or ""),
            "sizeBytes": stream_size_bytes, "sha256": stream_sha256,
        },
    }


def _observation_metrics(
    interaction_count: int, network_request_count: int, catalogs: list[tuple[dict[str, Any], dict[str, Any]]]
) -> dict[str, int]:
    return {
        "interactionCount": interaction_count,
        "networkRequestCount": network_request_count,
        "riskCount": sum(len(catalog.get("risks") or []) for _, catalog in catalogs),
        "controlCount": sum(len(catalog.get("controls") or []) for _, catalog in catalogs),
        "incompleteCatalogCount": sum(1 for _, catalog in catalogs if catalog.get("status") != "complete"),
    }


def main() -> int:
    sidecar: RecordingSidecar | None = None
    try:
        sidecar = RecordingSidecar()
        while sidecar.running:
            request_id = "invalid"
            try:
                frame = _read_frame(sys.stdin.buffer)
                if frame is None:
                    return 0
                request_id = _request_id(frame)
                response = sidecar.dispatch(frame)
            except RecordingError as exc:
                if exc.code in {"PROTOCOL.FRAME_SIZE_INVALID", "PROTOCOL.FRAME_TRUNCATED"}:
                    sidecar.running = False
                response = _error_result(request_id, exc)
            except (OSError, sqlite3.Error):
                response = _error_result(request_id, RecordingError("SIDECAR.POLICY_DENIED", "Recording sidecar storage policy denied the operation."))
            except Exception:
                response = _error_result(request_id, RecordingError("SIDECAR.INTERNAL", "Recording sidecar failed without exposing recording content."))
            _write_frame(sys.stdout.buffer, response)
        return 0
    except Exception:
        return 70
    finally:
        if sidecar is not None:
            sidecar.close()


def _read_frame(stream: BinaryIO) -> dict[str, Any] | None:
    header = _read_exact(stream, 4, allow_clean_eof=True)
    if header is None:
        return None
    length = struct.unpack(">I", header)[0]
    require(1 < length <= MAX_FRAME_BYTES, "PROTOCOL.FRAME_SIZE_INVALID", "RPC frame size is invalid.")
    body = _read_exact(stream, length)
    try:
        text = body.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise RecordingError("PROTOCOL.JSON_INVALID", "RPC frame is not UTF-8 JSON.") from exc
    return parse_json(text, "PROTOCOL.JSON_INVALID", "RPC frame is not a JSON object.")


def _read_exact(stream: BinaryIO, count: int, *, allow_clean_eof: bool = False) -> bytes | None:
    chunks: list[bytes] = []
    remaining = count
    while remaining:
        chunk = stream.read(remaining)
        if chunk == b"":
            if allow_clean_eof and remaining == count:
                return None
            raise RecordingError("PROTOCOL.FRAME_TRUNCATED", "RPC frame is truncated.")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _write_frame(stream: BinaryIO, frame: dict[str, Any]) -> None:
    body = canonical_json(frame).encode("utf-8")
    if len(body) > MAX_FRAME_BYTES:
        body = canonical_json(_error_result(str(frame.get("requestId") or "invalid"), RecordingError("PROTOCOL.FRAME_TOO_LARGE", "RPC response exceeds the 1 MiB bound."))).encode("utf-8")
    stream.write(struct.pack(">I", len(body)))
    stream.write(body)
    stream.flush()


def _request_id(frame: dict[str, Any]) -> str:
    value = frame.get("requestId")
    require(isinstance(value, str) and 0 < len(value) <= 256, "PROTOCOL.REQUEST_ID_INVALID", "RPC requestId is invalid.")
    return value


def _result(request_id: str, value: dict[str, Any]) -> dict[str, Any]:
    return {"schemaVersion": PROTOCOL, "type": "result", "requestId": request_id, "ok": True, "value": value}


def _error_result(request_id: str, error: RecordingError) -> dict[str, Any]:
    return {
        "schemaVersion": PROTOCOL,
        "type": "result",
        "requestId": request_id,
        "ok": False,
        "error": {"code": error.code, "message": str(error), "retryable": error.retryable},
    }
