"""Length-prefixed stdio sidecar protocol. stdout is reserved for frames."""

from __future__ import annotations

import json
import os
import platform
import struct
import sys
from typing import Any

from canonical import canonical_bytes
try:
    from __main__ import parse_workbook, validate_ir
except ImportError:
    import importlib.util
    from pathlib import Path

    _engine_path = Path(__file__).with_name('create-associate-engine.py')
    _engine_spec = importlib.util.spec_from_file_location('create_associate_feature_engine', _engine_path)
    if _engine_spec is None or _engine_spec.loader is None:
        raise ImportError('Create/associate Feature engine entry is unavailable.')
    _engine_module = importlib.util.module_from_spec(_engine_spec)
    _engine_spec.loader.exec_module(_engine_module)
    parse_workbook = _engine_module.parse_workbook
    validate_ir = _engine_module.validate_ir
from errors import EngineError, require
from plan_ir import build_plan_ir
from security import AuditPolicy, MAX_ARTIFACT_BYTES
from workbook_compile import compile_runtime_workbook

SCHEMA = "omnia.python-sidecar-rpc/v1"
MAX_FRAME_BYTES = 1024 * 1024
MAX_REQUEST_ID = 256
EXPECTED_PYTHON_VERSION = "3.13.14"
OPERATION_SCHEMA = "omnia.create-associate.python-operation/v1"


class Sidecar:
    def __init__(self) -> None:
        self.policy = AuditPolicy(os.path.dirname(__file__))
        self.policy.install()
        self.hello_received = False
        self.running = True

    def dispatch(self, frame: dict) -> dict:
        request_id = _request_id(frame)
        require(frame.get("schemaVersion") == SCHEMA, "PROTOCOL.SCHEMA_MISMATCH", "Sidecar protocol schemaVersion is invalid.")
        frame_type = frame.get("type")
        require(frame_type in ("hello", "invoke", "port_result", "heartbeat", "shutdown"), "PROTOCOL.TYPE_INVALID", "Sidecar frame type is invalid.")
        if frame_type == "hello":
            require(not self.hello_received, "PROTOCOL.HELLO_DUPLICATE", "hello may only be sent once.")
            require(frame.get("protocol") == SCHEMA, "PROTOCOL.HELLO_MISMATCH", "hello protocol does not match.")
            require(frame.get("maxFrameBytes") == MAX_FRAME_BYTES and frame.get("networkPolicy") == "deny" and frame.get("userSite") is False and frame.get("binaryTransfer") == "managed_artifact_handle", "PROTOCOL.HELLO_POLICY_MISMATCH", "hello runtime policy does not match.")
            self.hello_received = True
            return {
                "schemaVersion": SCHEMA, "type": "ready", "requestId": request_id,
                "protocol": SCHEMA, "pythonVersion": platform.python_version(),
                "networkPolicy": "deny", "userSite": False, "maxFrameBytes": MAX_FRAME_BYTES,
                "binaryTransfer": "managed_artifact_handle",
                "capabilities": ["parse_workbook", "validate_ir", "build_plan_ir", "compile_workbook"],
            }
        require(self.hello_received, "PROTOCOL.HELLO_REQUIRED", "hello must precede all other frames.")
        if frame_type == "heartbeat":
            return _frame("heartbeat_ack", request_id, {"alive": True})
        if frame_type == "shutdown":
            self.running = False
            return _result(request_id, {"shutdown": True})
        if frame_type == "port_result":
            raise EngineError("PROTOCOL.PORT_RESULT_UNEXPECTED", "This pure data engine never issues port_call frames.")
        operation = frame.get("method")
        payload = frame.get("payload") or {}
        require(isinstance(operation, str) and operation, "PROTOCOL.OPERATION_REQUIRED", "invoke operation is required.")
        require(isinstance(payload, dict), "PROTOCOL.PAYLOAD_INVALID", "invoke payload must be an object.")
        require(payload.get("schemaVersion") == OPERATION_SCHEMA, "PROTOCOL.OPERATION_SCHEMA_INVALID", "invoke payload schemaVersion is invalid.")
        self.policy.bind_invocation(str(frame.get("runId") or ""))
        if operation == "parse_workbook":
            workbook = self.policy.read(payload.get("workbookHandle"), max_bytes=64 * 1024 * 1024)
            result = parse_workbook(workbook, source_artifact_id=str(payload.get("sourceArtifactId") or ""), governance=_json_value(self.policy, payload, "governance"))
            return self._deliver(request_id, result, payload.get("resultHandle"))
        if operation == "validate_ir":
            result = validate_ir(_json_value(self.policy, payload, "parsed"))
            return self._deliver(request_id, result, payload.get("resultHandle"))
        if operation == "build_plan_ir":
            result = build_plan_ir(parsed=_json_value(self.policy, payload, "parsed"), governance=_json_value(self.policy, payload, "governance"))
            return self._deliver(request_id, result, payload.get("resultHandle"))
        if operation == "compile_workbook":
            base = self.policy.read(payload.get("baseWorkbookHandle"), max_bytes=64 * 1024 * 1024)
            parsed = _json_value(self.policy, payload, "parsed")
            metadata = _json_value(self.policy, payload, "metadata")
            output, descriptor = compile_runtime_workbook(base, parsed=parsed, metadata=metadata)
            output_handle = payload.get("outputWorkbookHandle")
            require(output_handle is not None, "OUTPUT.HANDLE_REQUIRED", "compile_workbook requires outputWorkbookHandle.")
            artifact = self.policy.write(output_handle, output)
            return _result(request_id, {"artifact": artifact, "workbook": descriptor})
        raise EngineError("PROTOCOL.OPERATION_UNSUPPORTED", f"Unsupported data-engine operation: {operation}.")

    def _deliver(self, request_id: str, value: dict, output_handle: dict | None) -> dict:
        encoded = canonical_bytes(value)
        inline = _result(request_id, value)
        if len(canonical_bytes(inline)) <= MAX_FRAME_BYTES:
            return inline
        require(output_handle is not None, "OUTPUT.HANDLE_REQUIRED", "Result exceeds the frame limit and requires resultHandle.")
        artifact = self.policy.write(output_handle, encoded)
        return _result(request_id, {"artifact": artifact, "contentSchemaVersion": value.get("schemaVersion"), "semanticDigest": value.get("semanticDigest")})


def main() -> None:
    sidecar = Sidecar()
    reader, writer = sys.stdin.buffer, sys.stdout.buffer
    while sidecar.running:
        request_id = "invalid"
        try:
            header = _read_exact(reader, 4, allow_clean_eof=True)
            if header is None:
                return
            length = struct.unpack(">I", header)[0]
            require(0 < length <= MAX_FRAME_BYTES, "PROTOCOL.FRAME_SIZE_INVALID", "Frame size is outside the 1 MiB limit.")
            body = _read_exact(reader, length)
            try:
                frame = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise EngineError("PROTOCOL.JSON_INVALID", "Frame is not valid UTF-8 JSON.") from exc
            require(isinstance(frame, dict), "PROTOCOL.FRAME_INVALID", "Frame must be a JSON object.")
            request_id = _request_id(frame)
            response = sidecar.dispatch(frame)
        except EngineError as exc:
            response = _error_result(request_id, exc)
            if exc.code in ("PROTOCOL.FRAME_SIZE_INVALID", "PROTOCOL.FRAME_TRUNCATED"):
                sidecar.running = False
        except (PermissionError, OSError) as exc:
            response = _error_result(request_id, EngineError("SIDECAR.POLICY_DENIED", "Sidecar security policy denied the operation."))
        except Exception:
            response = _error_result(request_id, EngineError("ENGINE.INTERNAL", "The data engine failed without exposing input content."))
        _write_frame(writer, response)


def _json_value(policy: AuditPolicy, payload: dict, name: str) -> dict:
    direct = payload.get(name)
    handle = payload.get(f"{name}Handle")
    require((direct is None) != (handle is None), "INPUT.JSON_SOURCE_INVALID", f"Exactly one of {name} or {name}Handle is required.")
    if handle is not None:
        data = policy.read(handle, max_bytes=MAX_ARTIFACT_BYTES)
        try:
            direct = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise EngineError("INPUT.JSON_ARTIFACT_INVALID", f"{name}Handle does not contain valid UTF-8 JSON.") from exc
    require(isinstance(direct, dict), "INPUT.JSON_OBJECT_REQUIRED", f"{name} must be a JSON object.")
    return direct


def _request_id(frame: dict) -> str:
    value = frame.get("requestId")
    require(isinstance(value, str) and 0 < len(value) <= MAX_REQUEST_ID, "PROTOCOL.REQUEST_ID_INVALID", "Every frame requires a bounded requestId.")
    return value


def _frame(frame_type: str, request_id: str, payload: dict) -> dict:
    return {"schemaVersion": SCHEMA, "type": frame_type, "requestId": request_id, "payload": payload}


def _result(request_id: str, value: dict) -> dict:
    return {"schemaVersion": SCHEMA, "type": "result", "requestId": request_id, "ok": True, "value": value}


def _error_result(request_id: str, error: EngineError) -> dict:
    return {"schemaVersion": SCHEMA, "type": "result", "requestId": request_id, "ok": False, "error": {**error.as_dict(), "retryable": False}}


def _read_exact(stream: Any, count: int, *, allow_clean_eof: bool = False) -> bytes | None:
    chunks: list[bytes] = []
    remaining = count
    while remaining:
        chunk = stream.read(remaining)
        if chunk == b"":
            if allow_clean_eof and remaining == count:
                return None
            raise EngineError("PROTOCOL.FRAME_TRUNCATED", "Frame is truncated.")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _write_frame(stream: Any, frame: dict) -> None:
    body = canonical_bytes(frame)
    if len(body) > MAX_FRAME_BYTES:
        body = canonical_bytes(_error_result(str(frame.get("requestId") or "invalid"), EngineError("OUTPUT.FRAME_SIZE_EXCEEDED", "Response exceeds the 1 MiB frame limit.")))
    stream.write(struct.pack(">I", len(body)))
    stream.write(body)
    stream.flush()
