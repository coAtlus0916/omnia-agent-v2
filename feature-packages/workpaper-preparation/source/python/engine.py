"""Pure deterministic planner for opening Control operating-effectiveness tabs."""

from __future__ import annotations

import hashlib
import json
import os
import struct
import sys
from typing import Any


PROTOCOL = "omnia.python-sidecar-rpc/v1"
CAPABILITIES = ["build_hidden_tab_plan"]
INPUT_SCHEMA = "omnia.workpaper-hidden-tab-input/v1"
OUTPUT_SCHEMA = "omnia.workpaper-hidden-tab-plan/v1"
MAX_FRAME_BYTES = 1024 * 1024
MAX_CONTROLS = 500


class PlannerError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def required_text(value: Any, label: str, maximum: int = 800) -> str:
    result = str(value or "").strip()
    if not result or len(result) > maximum:
        raise PlannerError("WORKPAPER.PLAN_INPUT_INVALID", f"{label} is invalid.")
    return result


def optional_text(value: Any, maximum: int = 800) -> str:
    result = str(value or "").strip()
    if len(result) > maximum:
        raise PlannerError("WORKPAPER.PLAN_INPUT_INVALID", "Optional text exceeds its signed bound.")
    return result


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def concurrency(value: Any, expected_tab: int, label: str) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict) or value.get("entityTabTypeId") != expected_tab:
        raise PlannerError("WORKPAPER.PLAN_INPUT_INVALID", f"{label} has an invalid tab identity.")
    updated_on = required_text(value.get("updatedOn"), f"{label}.updatedOn", 100)
    return {"entityTabTypeId": expected_tab, "updatedOn": updated_on}


def normalize_control(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise PlannerError("WORKPAPER.PLAN_INPUT_INVALID", "Control preflight is not an object.")
    control_id = required_text(raw.get("controlId"), "controlId", 100)
    work_item_id = required_text(raw.get("workItemId"), "control.workItemId", 100)
    opened = raw.get("opened") is True
    open_verified = raw.get("openVerified") is True
    core = concurrency(raw.get("coreConcurrency"), 201, "coreConcurrency")
    oe = concurrency(raw.get("oeConcurrency"), 209, "oeConcurrency")
    operating_effectiveness_id = optional_text(raw.get("operatingEffectivenessId"), 100)
    if open_verified and (not opened or not oe or not operating_effectiveness_id):
        raise PlannerError("WORKPAPER.OPEN_STATE_CONTRADICTION", "An open Control lacks its OE entity or unique Tab 209 token.")
    if opened and not open_verified:
        raise PlannerError("WORKPAPER.OPEN_STATE_CONTRADICTION", "A Control reports the OE flag without a verified hidden tab.")
    if not opened and not core:
        raise PlannerError("WORKPAPER.CORE_TOKEN_MISSING", "A closed Control lacks its unique Tab 201 token.")
    if raw.get("absent") is True or raw.get("deleted") is True:
        raise PlannerError("WORKPAPER.CONTROL_ABSENT", "A selected GRA Control is absent or deleted.")
    return {
        "controlId": control_id,
        "workItemId": work_item_id,
        "controlNumber": optional_text(raw.get("controlNumber"), 200),
        "name": optional_text(raw.get("name"), 500),
        "updatedOn": optional_text(raw.get("updatedOn"), 100),
        "opened": opened,
        "openVerified": open_verified,
        "coreConcurrency": core,
        "oeConcurrency": oe,
        "operatingEffectivenessId": operating_effectiveness_id,
    }


def build_hidden_tab_plan(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or payload.get("schemaVersion") != INPUT_SCHEMA:
        raise PlannerError("WORKPAPER.PLAN_INPUT_INVALID", "Hidden-tab planner input schema is invalid.")
    selected = payload.get("selectedGra")
    if not isinstance(selected, dict) or str(selected.get("graType") or "").strip().lower() != "application":
        raise PlannerError("WORKPAPER.APP_GRA_ONLY", "Only an Application GRA can be selected.")
    normalized_selected = {
        "riskAssessmentId": required_text(selected.get("riskAssessmentId"), "riskAssessmentId", 100),
        "graWorkItemId": required_text(selected.get("graWorkItemId"), "graWorkItemId", 100),
        "appId": required_text(selected.get("appId"), "appId", 100),
        "appWorkItemId": required_text(selected.get("appWorkItemId"), "appWorkItemId", 100),
        "workspaceId": required_text(selected.get("workspaceId"), "workspaceId", 100),
        "graName": optional_text(selected.get("graName"), 500),
        "graReferenceNumber": optional_text(selected.get("graReferenceNumber"), 200),
        "appName": optional_text(selected.get("appName"), 500),
        "appNumber": optional_text(selected.get("appNumber"), 200),
        "graType": "Application",
    }
    raw_controls = payload.get("controlPreflights")
    if not isinstance(raw_controls, list) or len(raw_controls) > MAX_CONTROLS:
        raise PlannerError("WORKPAPER.CONTROL_INVENTORY_INVALID", "Control inventory is invalid or exceeds 500 items.")
    controls = sorted((normalize_control(item) for item in raw_controls), key=lambda item: item["controlId"])
    if len({item["controlId"] for item in controls}) != len(controls) or len({item["workItemId"] for item in controls}) != len(controls):
        raise PlannerError("WORKPAPER.CONTROL_IDENTITY_DUPLICATE", "Control or Work Item identity is duplicated.")
    already_open = [item for item in controls if item["openVerified"]]
    steps = []
    for item in controls:
        if item["openVerified"]:
            continue
        step = {
            **item,
            "stepId": f"control-hidden-tab|{normalized_selected['workspaceId']}|{normalized_selected['riskAssessmentId']}|{item['controlId']}",
            "mutationOperationId": "omnia.workpaper.control.open-hidden-tab.v1",
            "reconcileOperationId": "omnia.workpaper.control.reconcile.v1",
            "mutationPayload": {
                "controlId": item["controlId"],
                "planningOperatingEffectivenessTesting": True,
                "concurrencyTabId": 201,
                "concurrencyTabUpdatedOn": item["coreConcurrency"]["updatedOn"],
            },
        }
        step["preflightDigest"] = digest(item)
        steps.append(step)
    result = {
        "schemaVersion": OUTPUT_SCHEMA,
        "selectedGra": normalized_selected,
        "controls": controls,
        "steps": steps,
        "alreadyOpen": already_open,
        "counts": {"total": len(controls), "toOpen": len(steps), "alreadyOpen": len(already_open)},
    }
    result["planDigest"] = digest(result)
    return result


def read_frame() -> dict[str, Any] | None:
    prefix = sys.stdin.buffer.read(4)
    if not prefix:
        return None
    if len(prefix) != 4:
        raise PlannerError("PYTHON.FRAME_INVALID", "RPC frame prefix is incomplete.")
    length = struct.unpack(">I", prefix)[0]
    if length < 2 or length > MAX_FRAME_BYTES:
        raise PlannerError("PYTHON.FRAME_INVALID", "RPC frame length is invalid.")
    body = sys.stdin.buffer.read(length)
    if len(body) != length:
        raise PlannerError("PYTHON.FRAME_INVALID", "RPC frame body is incomplete.")
    value = json.loads(body.decode("utf-8"))
    if not isinstance(value, dict):
        raise PlannerError("PYTHON.MESSAGE_INVALID", "RPC message is invalid.")
    return value


def write_frame(value: dict[str, Any]) -> None:
    body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(body) > MAX_FRAME_BYTES:
        raise PlannerError("PYTHON.FRAME_TOO_LARGE", "RPC response exceeds its bound.")
    sys.stdout.buffer.write(struct.pack(">I", len(body)))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def serve() -> None:
    while True:
        message = read_frame()
        if message is None:
            return
        request_id = str(message.get("requestId") or "")
        if message.get("schemaVersion") != PROTOCOL or not request_id:
            raise PlannerError("PYTHON.MESSAGE_INVALID", "RPC envelope is invalid.")
        message_type = message.get("type")
        if message_type == "hello":
            if (message.get("protocol") != PROTOCOL or message.get("pythonVersion") != "3.13.14"
                    or message.get("maxFrameBytes") != MAX_FRAME_BYTES or message.get("networkPolicy") != "deny"
                    or message.get("userSite") is not False or message.get("binaryTransfer") != "json_only"):
                raise PlannerError("PYTHON.HANDSHAKE_MISMATCH", "RPC policy does not match the signed runtime.")
            write_frame({"schemaVersion": PROTOCOL, "type": "ready", "requestId": request_id,
                         "protocol": PROTOCOL, "pythonVersion": "3.13.14", "capabilities": CAPABILITIES,
                         "maxFrameBytes": MAX_FRAME_BYTES, "networkPolicy": "deny", "userSite": False,
                         "binaryTransfer": "json_only"})
        elif message_type == "heartbeat":
            write_frame({"schemaVersion": PROTOCOL, "type": "heartbeat_ack", "requestId": request_id})
        elif message_type == "shutdown":
            return
        elif message_type == "invoke":
            try:
                if message.get("method") != "build_hidden_tab_plan" or not str(message.get("runId") or ""):
                    raise PlannerError("PYTHON.INVOCATION_INVALID", "Planner invocation is invalid.")
                value = build_hidden_tab_plan(message.get("payload"))
                write_frame({"schemaVersion": PROTOCOL, "type": "result", "requestId": request_id, "ok": True, "value": value})
            except PlannerError as error:
                write_frame({"schemaVersion": PROTOCOL, "type": "result", "requestId": request_id, "ok": False,
                             "error": {"code": error.code, "message": str(error)}})
        else:
            raise PlannerError("PYTHON.MESSAGE_DENIED", "RPC message type is denied.")


def self_check() -> None:
    sample = {
        "schemaVersion": INPUT_SCHEMA,
        "selectedGra": {"riskAssessmentId": "gra-1", "graWorkItemId": "gw-1", "appId": "app-1",
                        "appWorkItemId": "aw-1", "workspaceId": "ws-1", "graType": "Application"},
        "controlPreflights": [
            {"controlId": "c-1", "workItemId": "cw-1", "opened": False, "openVerified": False,
             "coreConcurrency": {"entityTabTypeId": 201, "updatedOn": "2026-01-01T00:00:00Z"}},
            {"controlId": "c-2", "workItemId": "cw-2", "opened": True, "openVerified": True,
             "operatingEffectivenessId": "oe-2", "oeConcurrency": {"entityTabTypeId": 209, "updatedOn": "2026-01-01T00:00:00Z"}},
        ],
    }
    value = build_hidden_tab_plan(sample)
    if value["counts"] != {"total": 2, "toOpen": 1, "alreadyOpen": 1} or value["steps"][0]["mutationPayload"]["concurrencyTabId"] != 201:
        raise SystemExit("workpaper planner self-check failed")
    print("workpaper planner self-check passed")


if __name__ == "__main__":
    if sys.version_info[:3] != (3, 13, 14):
        raise SystemExit("Release-managed CPython 3.13.14 is required.")
    if "--stdio-rpc" in sys.argv:
        serve()
    elif "--self-check" in sys.argv:
        self_check()
    else:
        raise SystemExit("Use --stdio-rpc or --self-check.")
