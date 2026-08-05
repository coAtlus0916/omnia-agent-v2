"""Pure Return-preparation compiler. It performs no I/O and invokes no connector."""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from canonical import semantic_digest
from engine import derive_gra_name
from errors import EngineError, require

RETURN_SCHEMA = "omnia.create-associate.return-preparation/v1"

OPS = {
    "objectCreate": "omnia.create-associate.object.create.v1",
    "objectRead": "omnia.create-associate.object.reconcile.v1",
    "settingsWrite": "omnia.create-associate.object-settings.patch.v1",
    "settingsRead": "omnia.create-associate.object-settings.reconcile.v1",
    "relationWrite": "omnia.create-associate.relation.associate.v1",
    "relationRead": "omnia.create-associate.relation.reconcile.v1",
    "graCreate": "omnia.create-associate.gra.create.v1",
    "graRead": "omnia.create-associate.gra.reconcile.v1",
    "graStateWrite": "omnia.create-associate.gra-state.patch.v1",
    "graStateRead": "omnia.create-associate.gra-state.reconcile.v1",
    "factorWrite": "omnia.create-associate.risk-factor.patch.v1",
    "factorRead": "omnia.create-associate.risk-factor.reconcile.v1",
    "documentationWrite": "omnia.create-associate.documentation.patch.v1",
    "documentationRead": "omnia.create-associate.documentation.reconcile.v1",
    "riskWrite": "omnia.create-associate.risk-control.associate.v1",
    "riskRead": "omnia.create-associate.risk-control.reconcile.v1",
    "evaluationWrite": "omnia.create-associate.evaluation.submit.v1",
    "evaluationRead": "omnia.create-associate.evaluation.reconcile.v1",
}


def prepare_return(*, parsed: dict, governance: dict, frozen_authority_snapshot: dict, frozen_safety_snapshot: dict, preflight_facts: dict) -> dict:
    require(parsed.get("schemaVersion") == "omnia.create-associate.parsed-workbook/v1", "RETURN.PARSED_SCHEMA_INVALID", "Parsed workbook schema is invalid.")
    require(isinstance(frozen_authority_snapshot, dict), "RETURN.AUTHORITY_REQUIRED", "Frozen authority snapshot is required.")
    require(isinstance(frozen_safety_snapshot, dict), "RETURN.SAFETY_REQUIRED", "Frozen safety snapshot is required.")
    require(isinstance(preflight_facts, dict), "RETURN.PREFLIGHT_REQUIRED", "Read-only preflight facts are required.")
    authority = _authority(frozen_authority_snapshot)
    allowed_workspaces = {str(value) for value in frozen_safety_snapshot.get("workspaceIds", [])}
    require(allowed_workspaces, "RETURN.SAFETY_SCOPE_MISSING", "Safety snapshot contains no workspace IDs.")
    workspaces = {unicodedata.normalize("NFKC", str(item.get("name", ""))): str(item.get("workspaceId", "")) for item in authority["workspaces"]}
    contents = {(str(item.get("elementKind", "")), unicodedata.normalize("NFKC", str(item.get("contentName", "")))): item for item in authority["graContents"]}
    facts_by_row = preflight_facts.get("rows", {})
    if isinstance(facts_by_row, list):
        facts_by_row = {str(item.get("rowKey", "")): item for item in facts_by_row}
    require(isinstance(facts_by_row, dict), "RETURN.PREFLIGHT_ROWS_INVALID", "preflightFacts.rows must be an object or array.")
    prepared_rows: list[dict] = []
    targets: list[dict] = []
    apps = {row["elementId"].casefold(): row for row in parsed.get("rows", []) if row.get("kind") == "APP"}
    for row in parsed.get("rows", []):
        kind, row_key, element_id = str(row["kind"]), str(row["rowKey"]), str(row["elementId"])
        workspace_name = _row_field(row, governance, f"P1.{kind}.IT.WORKSPACE")
        workspace_id = workspaces.get(unicodedata.normalize("NFKC", workspace_name), "")
        require(workspace_id and workspace_id in allowed_workspaces, "RETURN.AUTHORITY_UNRESOLVED", f"Workspace authority is unavailable or unsafe for {kind}/{element_id}.")
        content_name = _row_field(row, governance, f"P1.{kind}.GRA.GRA_CONTENT")
        content = contents.get((kind, unicodedata.normalize("NFKC", content_name)))
        require(content is not None, "RETURN.CONTENT_AUTHORITY_UNRESOLVED", f"GRA content authority is unavailable for {kind}/{element_id}.")
        facts = facts_by_row.get(row_key)
        require(isinstance(facts, dict), "RETURN.PREFLIGHT_ROW_MISSING", f"Frozen preflight facts are missing for row {row_key}.")
        require(facts.get("readOnly") is True, "RETURN.PREFLIGHT_NOT_READ_ONLY", f"Preflight facts are not marked read-only for row {row_key}.")
        object_id = str(facts.get("objectId") or "")
        gra_id = str(facts.get("graId") or "")
        mode = _normalize_rait(_row_field(row, governance, f"P1.{kind}.GRA.RAIT_CONCLUSION")) if kind in ("APP", "TOOL") else ""
        inheritance = []
        if kind in ("DB", "OS"):
            require(len(row.get("relations", [])) == 1, "RETURN.APP_REFERENCE_CARDINALITY", f"{kind} {element_id} requires exactly one in-workbook APP edge.")
            app = apps.get(str(row["relations"][0]).casefold())
            require(app is not None, "RETURN.APP_REFERENCE_AMBIGUOUS", f"{kind} {element_id} has no exact in-workbook APP source.")
            app_workspace = _row_field(app, governance, "P1.APP.IT.WORKSPACE")
            require(unicodedata.normalize("NFKC", app_workspace) == unicodedata.normalize("NFKC", workspace_name), "RETURN.APP_REFERENCE_WORKSPACE_DRIFT", f"{kind} {element_id} and its APP source must use the same frozen workspace.")
            mode = _normalize_rait(_row_field(app, governance, "P1.APP.GRA.RAIT_CONCLUSION"))
            inheritance = [{"sourceRowKey": app["rowKey"], "externalId": app["elementId"], "mode": mode}]
        require(mode in ("Higher", "Lower"), "RETURN.RAIT_INVALID", f"{kind} {element_id} has an unsupported RAIT value.")
        gra_name = derive_gra_name(element_id)
        identity = [workspace_id, kind, element_id]
        object_target = _identity_key("object", identity)
        gra_target = _identity_key("gra", [*identity, gra_name])
        prepared = {
            "rowKey": row_key, "kind": kind, "elementId": element_id, "workspaceName": workspace_name,
            "workspaceId": workspace_id, "content": content, "mode": mode, "inheritanceSources": inheritance,
            "objectId": object_id, "graId": gra_id, "graName": gra_name,
            "preflightFactDigest": semantic_digest(facts),
        }
        prepared_rows.append(prepared)
        targets.extend([
            _target("object", f"object|{row_key}", row_key, workspace_id, OPS["objectCreate"], object_target, disposition="reuse" if object_id else "create", resolvedObjectId=object_id, externalId=element_id),
            _target("object", f"gra|{row_key}", row_key, workspace_id, OPS["graCreate"], gra_target, objectType="GRA", disposition="reuse" if gra_id else "create", resolvedObjectId=gra_id, externalId=gra_name, entityObjectTargetKey=f"object|{row_key}"),
            _target("field", f"gra-status|{row_key}", row_key, workspace_id, OPS["graStateWrite"], _identity_key("gra-state", [*identity, gra_name, "status"]), graTargetKey=f"gra|{row_key}", fieldId="status", value="EvaluationStarted"),
            _target("field", f"gra-rait|{row_key}", row_key, workspace_id, OPS["graStateWrite"], _identity_key("gra-state", [*identity, gra_name, "itElementRaitConclusionLevelId"]), graTargetKey=f"gra|{row_key}", fieldId="itElementRaitConclusionLevelId", value=mode),
        ])
        if kind == "APP":
            targets.append(_target("field", f"object-settings|{row_key}", row_key, workspace_id, OPS["settingsWrite"], _identity_key("object-settings", [*identity, "application-settings"]), objectTargetKey=f"object|{row_key}", isRelevant=row["fields"].get("Derived Application Is Relevant"), isDataAvailable=row["fields"].get("Derived Application Is Data Available")))
        for relation in row.get("relations", []):
            targets.append(_target("relation", f"element-relation|{row_key}|{relation}", row_key, workspace_id, OPS["relationWrite"], "post-create-resolution", sourceObjectTargetKey=f"object|{row_key}", targetExternalId=relation, relationType="InfrastructureApplication"))
        for relation in _applicable_relations(governance.get("relations", []), kind, content_name, mode):
            if str(relation.get(f"linkRequired{mode}", "")).startswith("Y"):
                targets.append(_target("risk_control", f"risk-control|{row_key}|{relation['relationId']}", row_key, workspace_id, OPS["riskWrite"], _identity_key("risk-control", [*identity, gra_name, relation["relationId"]]), graTargetKey=f"gra|{row_key}", relationId=relation["relationId"], riskName=relation.get("riskName", ""), controlName=relation.get("controlName", ""), classification=relation.get(f"classification{mode}", "")))
        if kind == "APP" and "sap ecc" in content_name.casefold():
            for item in governance.get("scoringItems", []):
                if mode != "Higher" or str(item.get("higherApplicable", "")).startswith("Y"):
                    targets.append(_target("field", f"risk-factor|{row_key}|{item['itemId']}", row_key, workspace_id, OPS["factorWrite"], _identity_key("risk-factor", [*identity, gra_name, item["itemId"]]), graTargetKey=f"gra|{row_key}", fieldId=item["itemId"], value=mode))
            factors = _row_field(row, governance, "P1.APP.GRA.FACTORS_CONSIDERED")
            if factors:
                targets.append(_target("documentation", f"documentation|{row_key}", row_key, workspace_id, OPS["documentationWrite"], _identity_key("documentation", [*identity, gra_name, "factors-considered"]), graTargetKey=f"gra|{row_key}", plainText=factors))
        targets.append(_target("evaluation", f"evaluation|{row_key}", row_key, workspace_id, OPS["evaluationWrite"], _identity_key("evaluation", [*identity, gra_name, "EvaluationComplete"]), graTargetKey=f"gra|{row_key}", value="EvaluationComplete"))
    _resolve_relation_targets(targets, prepared_rows)
    _add_inheritance_targets(targets, prepared_rows)
    targets.sort(key=lambda item: item["key"])
    prepared_rows.sort(key=lambda item: item["rowKey"])
    inventory = {"targetCount": len(targets), "targets": targets}
    plan = {"schemaVersion": "omnia.create-associate.return-plan/v1", "authority": authority, "safety": frozen_safety_snapshot, "rows": prepared_rows, "targets": targets, "preflightFactsDigest": semantic_digest(preflight_facts)}
    result = {
        "schemaVersion": RETURN_SCHEMA,
        "targetInventory": inventory,
        "plan": plan,
        "digests": {
            "authorityDigest": semantic_digest(authority),
            "safetyDigest": semantic_digest(frozen_safety_snapshot),
            "preflightDigest": semantic_digest(preflight_facts),
            "parsedDigest": str(parsed.get("semanticDigest") or semantic_digest(parsed)),
            "planDigest": semantic_digest(plan),
        },
    }
    result["semanticDigest"] = semantic_digest(result)
    return result


def _authority(value: dict) -> dict:
    required = ("authorityInstanceId", "packId", "engagementId", "workspaces", "graContents")
    for key in required:
        require(value.get(key) not in (None, "", []), "RETURN.AUTHORITY_SCOPE_MISSING", f"Frozen authority snapshot is missing {key}.")
    return value


def _row_field(row: dict, governance: dict, field_id: str) -> str:
    raw = next((name for name, canonical in governance.get("fieldAliases", {}).get(row["kind"], {}).items() if canonical == field_id), "")
    return str(row.get("fields", {}).get(raw, "")).strip() if raw else ""


def _normalize_rait(value: str) -> str:
    lowered = unicodedata.normalize("NFKC", value).strip().casefold()
    return "Higher" if lowered == "higher" else "Lower" if lowered == "lower" else unicodedata.normalize("NFKC", value).strip()


def _identity_key(prefix: str, values: list[Any]) -> str:
    return f"{prefix}:{semantic_digest(values)[:48]}"


def _target(kind: str, key: str, row_key: str, workspace: str, operation: str, identity: str, **extra: Any) -> dict:
    return {"kind": kind, "key": key, "rowKey": row_key, "workspace": workspace, "mutationOperationId": operation, "operationTargetIdentityKey": identity, **extra}


def _family(kind: str, content: str) -> str:
    normalized = " ".join(unicodedata.normalize("NFKC", content).casefold().split())
    aliases = {
        "APP": {"GENERIC": ("generic", "generic application"), "SAP_ECC": ("sap ecc",)},
        "DB": {"GENERIC": ("generic", "generic database"), "ORACLE": ("oracle", "oracle database"), "SQL": ("sql", "sql database")},
        "OS": {"GENERIC": ("generic", "generic operating system"), "UNIX": ("unix",), "WIN": ("win", "windows")},
        "TOOL": {"TICKET": ("工单工具", "ticketing tool"), "IDENTITY": ("身份和访问管理工具", "identity & access management tool")},
    }.get(kind, {})
    matches = [family for family, names in aliases.items() if normalized in names]
    require(len(matches) == 1, "RETURN.RELATION_SCOPE_DRIFT", f"GRA content {kind}/{content} has no unique governed relation family.")
    return matches[0]


def _applicable_relations(relations: list[dict], kind: str, content: str, mode: str) -> list[dict]:
    family = _family(kind, content)
    result = []
    for relation in relations:
        match = re.match(r"^REL\.(APP|DB|OS|TOOL)\.(GENERIC|SAP_ECC|ORACLE|SQL|UNIX|WIN|TICKET|IDENTITY)\.", str(relation.get("relationId", "")))
        require(match is not None, "RETURN.RELATION_SCOPE_DRIFT", f"V8 relation {relation.get('relationId', '(missing)')} has no canonical family.")
        if match.group(1) == kind and match.group(2) == family and str(relation.get(f"catalogPresent{mode}", "")).startswith("Y"):
            result.append(relation)
    return result


def _resolve_relation_targets(targets: list[dict], rows: list[dict]) -> None:
    for target in (item for item in targets if item["kind"] == "relation"):
        matches = [row for row in rows if row["kind"] == "APP" and row["elementId"].casefold() == str(target["targetExternalId"]).casefold()]
        require(len(matches) == 1, "RETURN.RELATION_TARGET_UNVERIFIED", f"Relation {target['key']} does not resolve to one in-workbook APP target.")
        target["targetObjectTargetKey"] = f"object|{matches[0]['rowKey']}"
        target["targetWorkspace"] = matches[0]["workspaceId"]


def _add_inheritance_targets(targets: list[dict], rows: list[dict]) -> None:
    by_row = {row["rowKey"]: row for row in rows}
    for row in (item for item in rows if item["kind"] in ("DB", "OS")):
        require(len(row["inheritanceSources"]) == 1, "RETURN.RAIT_INHERITANCE_AMBIGUOUS", f"{row['kind']} {row['elementId']} requires one APP inheritance source.")
        source = by_row.get(row["inheritanceSources"][0]["sourceRowKey"])
        require(source is not None, "RETURN.RAIT_INHERITANCE_AMBIGUOUS", "Inheritance source is not an exact planned identity.")
        targets.append(_target("field", f"inheritance-source|{row['rowKey']}|{source['rowKey']}", row["rowKey"], source["workspaceId"], OPS["graStateWrite"], _identity_key("gra-state", [source["rowKey"], row["rowKey"], "inherited"]), graTargetKey=f"gra|{source['rowKey']}", sourceRowKey=source["rowKey"], fieldId="itElementRaitConclusionLevelId", value=row["mode"]))
