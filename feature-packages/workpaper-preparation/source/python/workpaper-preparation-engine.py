"""Pure deterministic planner for opening Control operating-effectiveness tabs."""

from __future__ import annotations

import hashlib
import json
import os
import re
import struct
import sys
import unicodedata
from typing import Any

# Isolated mode (-I) omits the script directory from sys.path. Add only this
# package-owned directory so the signed sibling modules resolve.
sys.dont_write_bytecode = True
_PYTHON_ROOT = os.path.realpath(os.path.dirname(__file__))
if _PYTHON_ROOT not in sys.path:
    sys.path.insert(0, _PYTHON_ROOT)

from workpaper_workbook import apply_replacement_fields, build_phase2_template, build_phase2_workbook, parse_uploaded_workbook
from policy_extract import extract_policy_archive
from policy_resolve import build_policy_index, extract_placeholders, retrieve_policy_snippets
from errors import EngineError


PROTOCOL = "omnia.python-sidecar-rpc/v1"
CAPABILITIES = ["select_hidden_tab_controls", "build_hidden_tab_plan", "classify_control_observation", "build_phase2_workbook", "parse_uploaded_workbook", "build_phase2_template", "apply_replacement_fields", "extract_policy_archive", "build_policy_index", "retrieve_policy_snippets", "extract_placeholders", "reconcile_writeback_controls"]
CONTROL_SELECTION_INPUT_SCHEMA = "omnia.workpaper-control-selection-input/v1"
CONTROL_SELECTION_OUTPUT_SCHEMA = "omnia.workpaper-control-selection/v1"
INPUT_SCHEMA = "omnia.workpaper-hidden-tab-input/v1"
OUTPUT_SCHEMA = "omnia.workpaper-hidden-tab-plan/v1"
OBSERVATION_INPUT_SCHEMA = "omnia.workpaper-control-observation-input/v1"
OBSERVATION_OUTPUT_SCHEMA = "omnia.workpaper-control-observation-classification/v1"
RECONCILE_INPUT_SCHEMA = "omnia.workpaper-writeback-reconcile-input/v1"
RECONCILE_OUTPUT_SCHEMA = "omnia.workpaper-writeback-reconcile/v1"
MAX_FRAME_BYTES = 1024 * 1024
MAX_CONTROLS = 500
HIDDEN_TAB_CONTROL_CODES = frozenset({
    "APP.01", "APP.02", "APP.03", "APP.05", "APP.06",
    "APP.10", "APP.13", "APP.15", "APP.16",
})


class PlannerError(Exception):
    def __init__(self, code: str, message: str) -> None:
        Exception.__init__(self, message)
        self.code = str(code)


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


def serialize_workpaper_plan(value: Any) -> str:
    """Freeze a Workpaper plan with this Feature's signed JSON policy."""
    encoder = json.JSONEncoder(
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    return encoder.encode(value)


def digest(value: Any) -> str:
    return hashlib.sha256(serialize_workpaper_plan(value).encode("utf-8")).hexdigest()


def hidden_tab_control_code(value: Any) -> str:
    normalized = unicodedata.normalize("NFKC", str(value or "")).strip().upper()
    match = re.match(r"^(APP\.(?:01|02|03|05|06|10|13|15|16))(?=$|[\s\-–—:：])", normalized)
    code = match.group(1) if match else ""
    return code if code in HIDDEN_TAB_CONTROL_CODES else ""


def select_hidden_tab_controls(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or payload.get("schemaVersion") != CONTROL_SELECTION_INPUT_SCHEMA:
        raise PlannerError("WORKPAPER.SELECTION_INPUT_INVALID", "Control selection input schema is invalid.")
    raw_controls = payload.get("controls")
    if not isinstance(raw_controls, list) or len(raw_controls) > MAX_CONTROLS:
        raise PlannerError("WORKPAPER.CONTROL_INVENTORY_INVALID", "Control inventory is invalid or exceeds 500 items.")
    selected = []
    for raw in raw_controls:
        if not isinstance(raw, dict):
            raise PlannerError("WORKPAPER.SELECTION_INPUT_INVALID", "Control catalog row is not an object.")
        if raw.get("associated") is not True:
            continue
        code = hidden_tab_control_code(raw.get("controlNumber"))
        if not code:
            continue
        selected.append({
            "controlId": required_text(raw.get("controlId"), "controlId", 100),
            "workItemId": required_text(raw.get("workItemId"), "control.workItemId", 100),
            "controlCode": code,
        })
    if not selected:
        raise PlannerError("WORKPAPER.TARGET_CONTROLS_ABSENT", "Selected Application GRA has none of the nine Phase 2 hidden-Tab Controls.")
    if len({item["controlCode"] for item in selected}) != len(selected):
        raise PlannerError("WORKPAPER.TARGET_CONTROL_AMBIGUOUS", "Selected Application GRA has duplicate Phase 2 hidden-Tab Control numbers.")
    if len({(item["controlId"], item["workItemId"]) for item in selected}) != len(selected):
        raise PlannerError("WORKPAPER.CONTROL_IDENTITY_DUPLICATE", "Selected Control identity is duplicated.")
    selected.sort(key=lambda item: (item["controlCode"], item["controlId"], item["workItemId"]))
    return {"schemaVersion": CONTROL_SELECTION_OUTPUT_SCHEMA, "controls": selected}


def reconcile_writeback_controls(payload: Any) -> dict[str, Any]:
    """Compute the write-back intersection between read-back Controls and the
    resolved template rows.

    The template resolution keys controlNumber by its APP.xx prefix (the system
    name is substituted in), while a read-back Control carries the raw Omnia
    controlNumber. Match on the extracted APP.xx code only. Every read-back
    Control is reported exactly once (skipped rows still count as a normal
    completed write-back row).
    """
    if not isinstance(payload, dict) or payload.get("schemaVersion") != RECONCILE_INPUT_SCHEMA:
        raise PlannerError("WORKPAPER.RECONCILE_INPUT_INVALID", "Write-back reconcile input schema is invalid.")
    readback = payload.get("readbackControls")
    resolutions = payload.get("resolutions")
    if not isinstance(readback, list) or not isinstance(resolutions, list):
        raise PlannerError("WORKPAPER.RECONCILE_INPUT_INVALID", "Write-back reconcile requires control and resolution lists.")
    resolution_by_code: dict[str, list[dict[str, Any]]] = {}
    for resolution in resolutions:
        if not isinstance(resolution, dict):
            raise PlannerError("WORKPAPER.RECONCILE_INPUT_INVALID", "Resolution row is not an object.")
        code = hidden_tab_control_code(resolution.get("controlNumber"))
        if not code:
            continue
        resolution_by_code.setdefault(code, []).append(resolution)
    rows: list[dict[str, Any]] = []
    seen_controls: set[tuple[str, str]] = set()
    for control in readback:
        if not isinstance(control, dict):
            raise PlannerError("WORKPAPER.RECONCILE_INPUT_INVALID", "Read-back Control row is not an object.")
        control_id = required_text(control.get("controlId"), "controlId", 100)
        work_item_id = required_text(control.get("workItemId"), "workItemId", 100)
        identity = (control_id, work_item_id)
        if identity in seen_controls:
            raise PlannerError("WORKPAPER.CONTROL_IDENTITY_DUPLICATE", "Read-back Control identity is duplicated.")
        seen_controls.add(identity)
        code = hidden_tab_control_code(control.get("controlNumber"))
        matched = resolution_by_code.get(code, []) if code else []
        if not matched:
            rows.append({"controlId": control_id, "workItemId": work_item_id, "controlNumber": code or optional_text(control.get("controlNumber"), 200),
                         "matched": False, "resolutionCount": 0})
            continue
        # A read-back Control matches a resolution on the same APP.xx code; the
        # resolution list may hold one row per system, but a read-back Control
        # is always a single live Omnia entity — take the first matching row.
        rows.append({"controlId": control_id, "workItemId": work_item_id, "controlNumber": code,
                     "matched": True, "resolutionCount": len(matched),
                     "resolution": matched[0]})
    return {"schemaVersion": RECONCILE_OUTPUT_SCHEMA, "rows": rows, "total": len(rows),
            "matchedCount": sum(1 for row in rows if row["matched"])}


def concurrency(value: Any, expected_tab: int, label: str) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict) or value.get("entityTabTypeId") != expected_tab:
        raise PlannerError("WORKPAPER.PLAN_INPUT_INVALID", f"{label} has an invalid tab identity.")
    updated_on = required_text(value.get("updatedOn"), f"{label}.updatedOn", 100)
    return {"entityTabTypeId": expected_tab, "updatedOn": updated_on}


def normalize_selected_gra(selected: Any) -> dict[str, Any]:
    if not isinstance(selected, dict) or str(selected.get("graType") or "").strip().lower() != "application":
        raise PlannerError("WORKPAPER.APP_GRA_ONLY", "Only an Application GRA can be selected.")
    gra_content_name = required_text(selected.get("graContentName"), "graContentName", 120)
    if gra_content_name.strip().casefold() not in {"generic", "generic application"}:
        raise PlannerError("WORKPAPER.GENERIC_APP_ONLY", "Only a Generic Application GRA can be selected.")
    return {
        "riskAssessmentId": required_text(selected.get("riskAssessmentId"), "riskAssessmentId", 100),
        "graWorkItemId": required_text(selected.get("graWorkItemId"), "graWorkItemId", 100),
        "appId": required_text(selected.get("appId"), "appId", 100),
        "appWorkItemId": required_text(selected.get("appWorkItemId"), "appWorkItemId", 100),
        "workspaceId": required_text(selected.get("workspaceId"), "workspaceId", 100),
        "graContentId": required_text(selected.get("graContentId"), "graContentId", 128),
        "graName": optional_text(selected.get("graName"), 500),
        "graReferenceNumber": optional_text(selected.get("graReferenceNumber"), 200),
        "appName": optional_text(selected.get("appName"), 500),
        "appNumber": optional_text(selected.get("appNumber"), 200),
        "graContentName": "Generic",
        "graType": "Application",
    }


def normalize_control(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise PlannerError("WORKPAPER.PLAN_INPUT_INVALID", "Control preflight is not an object.")
    control_id = required_text(raw.get("controlId"), "controlId", 100)
    work_item_id = required_text(raw.get("workItemId"), "control.workItemId", 100)
    opened = raw.get("opened") is True
    planning_common_control_testing = raw.get("planningCommonControlTesting") if isinstance(raw.get("planningCommonControlTesting"), bool) else None
    use_previous_audit_evidence = raw.get("usePreviousAuditEvidence") if isinstance(raw.get("usePreviousAuditEvidence"), bool) else None
    prior_evidence_declined = raw.get("priorEvidenceDeclined") is True
    prior_evidence_not_applicable = raw.get("priorEvidenceNotApplicable") is True
    prior_evidence_complete = raw.get("priorEvidenceComplete") is True
    if planning_common_control_testing is None:
        raise PlannerError("WORKPAPER.COMMON_CONTROL_STATE_MISSING", "Control preflight lacks its exact common-control setting.")
    if prior_evidence_complete != prior_evidence_declined:
        raise PlannerError("WORKPAPER.PRIOR_EVIDENCE_STATE_CONTRADICTION", "Prior-evidence completion flags contradict one another.")
    if prior_evidence_declined != (use_previous_audit_evidence is False):
        raise PlannerError("WORKPAPER.PRIOR_EVIDENCE_STATE_CONTRADICTION", "Prior-evidence decline does not match its authoritative field.")
    core = concurrency(raw.get("coreConcurrency"), 201, "coreConcurrency")
    oe = concurrency(raw.get("oeConcurrency"), 209, "oeConcurrency")
    operating_effectiveness_id = optional_text(raw.get("operatingEffectivenessId"), 100)
    # The recorded Tab 209 PATCH removes concurrencyTabUpdatedOn. A terminal
    # OE read-back is therefore proven by the exact OE entity and the two
    # authoritative flags; an optional Tab 209 timestamp is diagnostic only.
    # An unopened Control may legitimately have no Tab 201 row yet. The
    # recorded no-token PATCH deletes concurrencyTabUpdatedOn; updatedOn must
    # never be promoted into a concurrency token.
    open_verified = (opened and planning_common_control_testing is False and prior_evidence_complete
                     and use_previous_audit_evidence is False
                     and bool(operating_effectiveness_id))
    if isinstance(raw.get("openVerified"), bool) and raw.get("openVerified") != open_verified:
        raise PlannerError("WORKPAPER.OPEN_STATE_CONTRADICTION", "Signed Operation and Python derived different hidden-Tab completion states.")
    if opened and not operating_effectiveness_id:
        raise PlannerError("WORKPAPER.OPEN_STATE_CONTRADICTION", "A Control reports the OE flag without its exact OE entity.")
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
        "planningCommonControlTesting": planning_common_control_testing,
        "usePreviousAuditEvidence": use_previous_audit_evidence,
        "priorEvidenceDeclined": prior_evidence_declined,
        "priorEvidenceNotApplicable": prior_evidence_not_applicable,
        "priorEvidenceComplete": prior_evidence_complete,
        "coreConcurrency": core,
        "oeConcurrency": oe,
        "operatingEffectivenessId": operating_effectiveness_id,
    }


def classify_control_observation(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or payload.get("schemaVersion") != OBSERVATION_INPUT_SCHEMA:
        raise PlannerError("WORKPAPER.OBSERVATION_INPUT_INVALID", "Control observation input schema is invalid.")
    selected = normalize_selected_gra(payload.get("selectedGra"))
    expected = payload.get("expectedControl")
    observation = payload.get("observation")
    if not isinstance(expected, dict) or not isinstance(observation, dict):
        raise PlannerError("WORKPAPER.OBSERVATION_INPUT_INVALID", "Expected Control and observation must be objects.")
    for key in ("riskAssessmentId", "graWorkItemId", "appId", "appWorkItemId", "workspaceId"):
        if required_text(observation.get(key), f"observation.{key}", 100) != selected[key]:
            raise PlannerError("WORKPAPER.PREFLIGHT_CONTEXT_DRIFT", "Control observation returned another Application GRA context.")
    expected_control_id = required_text(expected.get("controlId"), "expectedControl.controlId", 100)
    expected_work_item_id = required_text(expected.get("workItemId"), "expectedControl.workItemId", 100)
    if observation.get("absent") is True or observation.get("deleted") is True:
        if required_text(observation.get("controlId"), "observation.controlId", 100) != expected_control_id:
            raise PlannerError("WORKPAPER.PREFLIGHT_IDENTITY_DRIFT", "Absent Control observation returned another identity.")
        return {
            "schemaVersion": OBSERVATION_OUTPUT_SCHEMA,
            "outcome": "contradiction",
            "control": {**selected, "controlId": expected_control_id, "workItemId": expected_work_item_id,
                        "absent": observation.get("absent") is True, "deleted": observation.get("deleted") is True},
        }
    control = normalize_control(observation)
    if control["controlId"] != expected_control_id or control["workItemId"] != expected_work_item_id:
        raise PlannerError("WORKPAPER.PREFLIGHT_IDENTITY_DRIFT", "Control observation returned another Control or Work Item.")
    mutation_payload = expected.get("mutationPayload") if isinstance(expected.get("mutationPayload"), dict) else {}
    frozen_token = optional_text(mutation_payload.get("concurrencyTabUpdatedOn") or expected.get("baselineCoreUpdatedOn"), 100)
    if control["openVerified"]:
        outcome = "applied"
    elif control["opened"] and control["operatingEffectivenessId"]:
        outcome = "partial_applied"
    elif not control["opened"]:
        baseline_common = mutation_payload.get("baselinePlanningCommonControlTesting")
        if isinstance(baseline_common, bool) and control["planningCommonControlTesting"] != baseline_common:
            outcome = "partial_applied"
        elif frozen_token and (not control["coreConcurrency"]
                               or control["coreConcurrency"]["updatedOn"] != frozen_token):
            outcome = "pending"
        else:
            outcome = "not_applied"
    else:
        outcome = "pending"
    reported = observation.get("outcome")
    if reported is not None and reported != outcome:
        raise PlannerError("WORKPAPER.OBSERVATION_OUTCOME_CONTRADICTION", "Signed Operation and Python classified different Control outcomes.")
    return {"schemaVersion": OBSERVATION_OUTPUT_SCHEMA, "outcome": outcome, "control": {**selected, **control}}


def build_hidden_tab_plan(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or payload.get("schemaVersion") != INPUT_SCHEMA:
        raise PlannerError("WORKPAPER.PLAN_INPUT_INVALID", "Hidden-tab planner input schema is invalid.")
    normalized_selected = normalize_selected_gra(payload.get("selectedGra"))
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
        mutation_payload = {
            "controlId": item["controlId"],
            "planningOperatingEffectivenessTesting": True,
            "planningCommonControlTesting": False,
            "usePreviousAuditEvidence": False,
            "concurrencyTabId": 201,
            "concurrencyTabUpdatedOn": (item["coreConcurrency"] or {}).get("updatedOn") or "",
            "baselinePlanningCommonControlTesting": item["planningCommonControlTesting"],
        }
        if item["opened"]:
            if not mutation_payload["concurrencyTabUpdatedOn"]:
                raise PlannerError("WORKPAPER.PARTIAL_STATE_TOKEN_MISSING", "A partial OE state lacks its frozen updated-on identity.")
            mutation_payload["resumeOperatingEffectivenessId"] = item["operatingEffectivenessId"]
        step = {
            **item,
            "stepId": f"control-hidden-tab|{normalized_selected['workspaceId']}|{normalized_selected['riskAssessmentId']}|{item['controlId']}",
            "mutationOperationId": "omnia.workpaper.control.open-hidden-tab.v1",
            "reconcileOperationId": "omnia.workpaper.control.reconcile.v1",
            "mutationPayload": mutation_payload,
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
                method = message.get("method")
                if method not in CAPABILITIES or not str(message.get("runId") or ""):
                    raise PlannerError("PYTHON.INVOCATION_INVALID", "Planner invocation is invalid.")
                value = (select_hidden_tab_controls(message.get("payload"))
                         if method == "select_hidden_tab_controls"
                         else classify_control_observation(message.get("payload"))
                         if method == "classify_control_observation"
                         else build_phase2_workbook(message.get("payload"))
                         if method == "build_phase2_workbook"
                         else parse_uploaded_workbook(message.get("payload"))
                         if method == "parse_uploaded_workbook"
                         else build_phase2_template(message.get("payload"))
                         if method == "build_phase2_template"
                         else apply_replacement_fields(message.get("payload"))
                         if method == "apply_replacement_fields"
                         else extract_policy_archive(message.get("payload"))
                         if method == "extract_policy_archive"
                         else build_policy_index(message.get("payload"))
                         if method == "build_policy_index"
                         else retrieve_policy_snippets(message.get("payload"))
                         if method == "retrieve_policy_snippets"
                         else extract_placeholders(message.get("payload"))
                         if method == "extract_placeholders"
                         else reconcile_writeback_controls(message.get("payload"))
                         if method == "reconcile_writeback_controls"
                         else build_hidden_tab_plan(message.get("payload")))
                write_frame({"schemaVersion": PROTOCOL, "type": "result", "requestId": request_id, "ok": True, "value": value})
            except PlannerError as error:
                write_frame({"schemaVersion": PROTOCOL, "type": "result", "requestId": request_id, "ok": False,
                             "error": {"code": error.code, "message": str(error)}})
            except EngineError as error:
                write_frame({"schemaVersion": PROTOCOL, "type": "result", "requestId": request_id, "ok": False,
                             "error": {"code": error.code, "message": error.message}})
            except Exception as error:  # noqa: BLE001 - never let an unexpected error crash the sidecar
                write_frame({"schemaVersion": PROTOCOL, "type": "result", "requestId": request_id, "ok": False,
                             "error": {"code": "PYTHON.PLANNER_FAILED", "message": str(error)}})
        else:
            raise PlannerError("PYTHON.MESSAGE_DENIED", "RPC message type is denied.")


def self_check() -> None:
    selection = select_hidden_tab_controls({
        "schemaVersion": CONTROL_SELECTION_INPUT_SCHEMA,
        "controls": [
            {"controlId": "c-5", "workItemId": "cw-5", "controlNumber": "APP.05 Control", "associated": True},
            {"controlId": "c-x", "workItemId": "cw-x", "controlNumber": "DCNO.17 Control", "associated": True},
            {"controlId": "c-1", "workItemId": "cw-1", "controlNumber": "APP.01", "associated": True},
            {"controlId": "c-16", "workItemId": "cw-16", "controlNumber": "APP.16", "associated": False},
        ],
    })
    if [item["controlCode"] for item in selection["controls"]] != ["APP.01", "APP.05"]:
        raise SystemExit("workpaper control selector self-check failed")
    classification = classify_control_observation({
        "schemaVersion": OBSERVATION_INPUT_SCHEMA,
        "selectedGra": {"riskAssessmentId": "gra-1", "graWorkItemId": "gw-1", "appId": "app-1",
                        "appWorkItemId": "aw-1", "workspaceId": "ws-1", "graContentId": "generic-content",
                        "graContentName": "Generic",
                        "graType": "Application"},
        "expectedControl": {"controlId": "c-2", "workItemId": "cw-2",
                            "mutationPayload": {"concurrencyTabUpdatedOn": "2026-01-01T00:00:00Z"}},
        "observation": {"riskAssessmentId": "gra-1", "graWorkItemId": "gw-1", "appId": "app-1",
                        "appWorkItemId": "aw-1", "workspaceId": "ws-1", "controlId": "c-2", "workItemId": "cw-2",
                        "opened": True, "openVerified": False, "planningCommonControlTesting": False,
                        "usePreviousAuditEvidence": None, "priorEvidenceDeclined": False,
                        "priorEvidenceNotApplicable": False, "priorEvidenceComplete": False,
                        "operatingEffectivenessId": "oe-2",
                        "oeConcurrency": {"entityTabTypeId": 209, "updatedOn": "2026-01-02T00:00:00Z"},
                        "outcome": "partial_applied"},
    })
    if classification["outcome"] != "partial_applied":
        raise SystemExit("workpaper observation classifier self-check failed")
    sample = {
        "schemaVersion": INPUT_SCHEMA,
        "selectedGra": {"riskAssessmentId": "gra-1", "graWorkItemId": "gw-1", "appId": "app-1",
                        "appWorkItemId": "aw-1", "workspaceId": "ws-1", "graContentId": "generic-content",
                        "graContentName": "Generic",
                        "graType": "Application"},
        "controlPreflights": [
            {"controlId": "c-1", "workItemId": "cw-1", "opened": False, "openVerified": False,
             "planningCommonControlTesting": False, "coreConcurrency": None},
            {"controlId": "c-2", "workItemId": "cw-2", "opened": True, "openVerified": True,
             "planningCommonControlTesting": False, "usePreviousAuditEvidence": False,
             "priorEvidenceDeclined": True, "priorEvidenceComplete": True,
             "operatingEffectivenessId": "oe-2", "oeConcurrency": None},
        ],
    }
    value = build_hidden_tab_plan(sample)
    if (value["counts"] != {"total": 2, "toOpen": 1, "alreadyOpen": 1}
            or value["steps"][0]["mutationPayload"]["concurrencyTabId"] != 201
            or value["steps"][0]["mutationPayload"]["concurrencyTabUpdatedOn"] != ""
            or value["steps"][0]["mutationPayload"]["planningCommonControlTesting"] is not False
            or value["steps"][0]["mutationPayload"]["usePreviousAuditEvidence"] is not False):
        raise SystemExit("workpaper planner self-check failed")
    workbook = build_phase2_workbook({
        "schemaVersion": "omnia.workpaper-phase2-workbook/v1",
        "headers": ["控制 ID", "控制名称", "记录程序结果"],
        "rows": [["APP.01 - GRA-TEST", "用户授权", "程序结果文本"], ["APP.02 - GRA-TEST", "变更管理", ""]],
        "scope": {"engagementId": "eng-1", "workspaceId": "ws-1"},
    })
    if (workbook["sha256"] != hashlib.sha256(__import__("base64").b64decode(workbook["xlsxBase64"])).hexdigest()
            or workbook["rowCount"] != 2
            or workbook["sheetNames"] != ["Controls", "Scope"]):
        raise SystemExit("workpaper workbook generator self-check failed")
    parsed = parse_uploaded_workbook({
        "schemaVersion": "omnia.workpaper-phase2-workbook/v1",
        "xlsxBase64": workbook["xlsxBase64"],
        "expectedHeaders": ["控制 ID", "控制名称", "记录程序结果"],
        "expectedScopeKeys": ["engagementId", "workspaceId"],
    })
    if parsed["rowCount"] != 2 or parsed["headers"] != ["控制 ID", "控制名称", "记录程序结果"]:
        raise SystemExit("workpaper workbook parser self-check failed")
    reconcile = reconcile_writeback_controls({
        "schemaVersion": RECONCILE_INPUT_SCHEMA,
        "readbackControls": [
            {"controlId": "c-1", "workItemId": "cw-1", "controlNumber": "APP.01 Control"},
            {"controlId": "c-2", "workItemId": "cw-2", "controlNumber": "APP.02 Control"},
            {"controlId": "c-3", "workItemId": "cw-3", "controlNumber": "APP.03 Control"},
            {"controlId": "c-5", "workItemId": "cw-5", "controlNumber": "APP.05 Control"},
        ],
        "resolutions": [
            {"controlNumber": "APP.01 - 系统A", "placeholders": []},
            {"controlNumber": "APP.02 - 系统A", "placeholders": []},
        ],
    })
    if (reconcile["total"] != 4 or reconcile["matchedCount"] != 2
            or [row["controlId"] for row in reconcile["rows"] if row["matched"]] != ["c-1", "c-2"]):
        raise SystemExit("workpaper write-back reconcile self-check failed")
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
