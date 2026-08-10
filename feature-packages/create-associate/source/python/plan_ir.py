"""Pure, governance-driven capability plan compiler.

The compiler performs no I/O and emits no Connector request.  It freezes the
deterministic row/capability/dependency decisions that the Worker later enriches
with authoritative Remote identities and signed preflight facts.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from canonical import semantic_digest
try:
    from __main__ import PARSED_SCHEMA, derive_gra_name
except ImportError:
    from engine import PARSED_SCHEMA, derive_gra_name
from errors import require

PLAN_IR_SCHEMA = "omnia.create-associate.capability-plan-ir/v1"
RETURN_INTENTS_SCHEMA = "omnia.create-associate.deterministic-return-intents/v1"


def build_plan_ir(*, parsed: dict, governance: dict) -> dict:
    require(parsed.get("schemaVersion") == PARSED_SCHEMA, "PLAN.PARSED_SCHEMA_INVALID", "Parsed workbook schema is invalid.")
    registry = governance.get("kindRegistry")
    require(isinstance(registry, dict) and registry == parsed.get("kindRegistry"), "PLAN.KIND_REGISTRY_DRIFT", "Parsed and signed kind registries differ.")
    excluded = {str(value) for value in parsed.get("excludedRowKeys", [])}
    all_rows = list(parsed.get("rows", []))
    active_rows = [row for row in all_rows if str(row.get("rowKey")) not in excluded]
    by_row = {str(row.get("rowKey")): row for row in active_rows}
    require(len(by_row) == len(active_rows), "PLAN.ROW_IDENTITY_DUPLICATE", "Active plan rows do not have unique row identities.")
    all_row_keys = {str(row.get("rowKey")) for row in all_rows}
    issue_by_row: dict[str, list[str]] = {}
    global_blocker_codes: set[str] = set()
    for issue in parsed.get("issues", []):
        if issue.get("state") not in ("blocking", "needs_input"):
            continue
        field_key = str(issue.get("fieldKey") or "")
        row_key = next((key for key in all_row_keys if field_key == key or field_key.startswith(f"{key}.")), "")
        if row_key in excluded:
            continue
        if row_key in by_row:
            issue_by_row.setdefault(row_key, []).append(str(issue.get("code") or "LOCAL.UNKNOWN"))
        else:
            global_blocker_codes.add(str(issue.get("code") or "LOCAL.UNKNOWN"))

    apps_by_identity: dict[str, list[dict]] = {}
    for row in active_rows:
        if row.get("kind") == "APP":
            apps_by_identity.setdefault(_identity(row.get("elementId")), []).append(row)
    app_spec = registry["APP"]
    rows = [
        _compile_row(
            row,
            registry[str(row.get("kind"))],
            app_spec,
            [*issue_by_row.get(str(row.get("rowKey")), []), *global_blocker_codes],
            apps_by_identity,
            governance,
        )
        for row in active_rows
    ]
    row_keys = {row["rowKey"] for row in rows}
    for row in rows:
        missing = [key for key in row["dependencyRowKeys"] if key not in row_keys]
        require(not missing, "PLAN.DEPENDENCY_ROW_MISSING", f"Plan row {row['rowKey']} references a missing APP dependency.")
    rows.sort(key=lambda item: item["rowKey"])
    result = {
        "schemaVersion": PLAN_IR_SCHEMA,
        "parsedDigest": str(parsed.get("semanticDigest") or semantic_digest(parsed)),
        "governanceDigest": str(governance.get("semanticDigest") or ""),
        "excludedRowKeys": sorted(excluded),
        "globalBlockerCodes": sorted(global_blocker_codes),
        "rows": rows,
    }
    result["semanticDigest"] = semantic_digest(result)
    return result


def _compile_row(row: dict, spec: dict, app_spec: dict, blocker_codes: list[str], apps_by_identity: dict[str, list[dict]], governance: dict) -> dict:
    kind, row_key = str(row.get("kind")), str(row.get("rowKey"))
    require(spec and spec.get("id") and isinstance(spec.get("capabilities"), dict), "PLAN.KIND_UNDECLARED", f"Plan kind is undeclared: {kind}.")
    workspace = _field(row, spec, f"P1.{kind}.IT.WORKSPACE")
    content = _field(row, spec, f"P1.{kind}.GRA.GRA_CONTENT")
    policy = spec.get("relationPolicy") or {}
    relation_targets = [str(value) for value in row.get("relations", [])]
    dependency_rows: list[str] = []
    effective_blockers = set(blocker_codes)
    if relation_targets:
        for target in relation_targets:
            matches = [candidate for candidate in apps_by_identity.get(_identity(target), []) if _workspace(candidate, app_spec) == workspace]
            if len(matches) == 1:
                dependency_rows.append(str(matches[0].get("rowKey") or ""))
            else:
                effective_blockers.add("PLAN.RELATION_TARGET_UNRESOLVED")
    minimum, maximum = int(policy.get("min") or 0), int(policy.get("max") or 0)
    if spec.get("relation") and not minimum <= len(relation_targets) <= maximum:
        effective_blockers.add("PLAN.RELATION_CARDINALITY_INVALID")
    if spec.get("inheritRait") is True:
        source_rows = {str(item.get("rowKey") or "") for item in row.get("inheritance", {}).get("sourceApps", [])}
        if source_rows != set(dependency_rows):
            effective_blockers.add("PLAN.INHERITANCE_SOURCE_DRIFT")
    rait = _rait(row, spec)
    if (spec.get("inheritRait") is True or spec.get("capabilities", {}).get("directRait") is True) and rait["value"] not in ("Higher", "Lower"):
        effective_blockers.add("PLAN.RAIT_UNRESOLVED")
    capabilities = {str(key): bool(value) for key, value in spec["capabilities"].items()}
    return_intents = _return_intents(
        row=row,
        spec=spec,
        governance_relations=list(governance.get("relations") or ()),
        governance_fields=list(governance.get("fields") or ()),
        governance_scoring_items=list(governance.get("scoringItems") or ()),
        content=content,
        mode=rait["value"],
        capabilities=capabilities,
    )
    return {
        "rowKey": row_key,
        "kind": kind,
        "returnSupport": str(spec.get("returnSupport") or "unsupported"),
        "object": {
            "objectType": str(spec.get("objectType") or ""),
            "objectSubtype": str(spec.get("objectSubtype") or ""),
            "externalId": str(row.get("elementId") or ""),
            "graName": derive_gra_name(row.get("elementId")),
            "workspaceName": workspace,
            "contentName": content,
        },
        "capabilities": capabilities,
        "stageNodes": [str(value) for value in spec.get("stageNodes", [])],
        "relationPolicy": {
            "targetKind": str(policy.get("targetKind") or ""),
            "minimum": minimum,
            "maximum": maximum,
            "relationType": str(policy.get("relationType") or ""),
            "concurrencyTabId": int(policy.get("concurrencyTabId") or 0),
            "targets": relation_targets,
        },
        "rait": rait,
        "returnIntents": return_intents,
        "dependencyRowKeys": sorted(set(dependency_rows)),
        "blockerCodes": sorted(effective_blockers),
        "status": "blocked" if effective_blockers else "ready_for_remote_preflight",
    }


def _field(row: dict, spec: dict, field_id: str) -> str:
    raw = next((name for name, canonical_id in spec.get("aliases", {}).items() if canonical_id == field_id), "")
    return unicodedata.normalize("NFC", str(row.get("fields", {}).get(raw, ""))).strip() if raw else ""


def _identity(value: object) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).casefold()


def _workspace(row: dict, spec: dict) -> str:
    return _field(row, spec, "P1.APP.IT.WORKSPACE")


def _rait(row: dict, spec: dict) -> dict[str, Any]:
    if spec.get("inheritRait") is True:
        inheritance = row.get("inheritance") or {}
        sources = [
            {"rowKey": str(item.get("rowKey") or ""), "elementId": str(item.get("elementId") or "")}
            for item in inheritance.get("sourceApps", [])
        ]
        return {
            "strategy": "any_higher_else_all_lower",
            "value": str(inheritance.get("rait") or ""),
            "sources": sources,
        }
    kind = str(row.get("kind"))
    return {
        "strategy": "direct",
        "value": _field(row, spec, f"P1.{kind}.GRA.RAIT_CONCLUSION"),
        "sources": [],
    }


def _return_intents(
    *,
    row: dict,
    spec: dict,
    governance_relations: list[dict],
    governance_fields: list[dict],
    governance_scoring_items: list[dict],
    content: str,
    mode: str,
    capabilities: dict[str, bool],
) -> dict:
    """Freeze pure business decisions before any authority or Connector call.

    The result contains no URL, HTTP method, remote object ID, safety credential,
    or mutation permit.  The Worker later binds this signed deterministic intent
    to authoritative identities while Core remains the only CAS/safety owner.
    """

    kind = str(row.get("kind") or "")
    unresolved_mode = mode not in ("Higher", "Lower")
    selected_relations: list[dict] = []
    required_relations: list[dict] = []
    risk_classifications: list[dict] = []
    scoring_items: list[dict] = []
    if capabilities.get("riskControl") is True and not unresolved_mode:
        selected_relations = _applicable_relations(governance_relations, kind, content, mode)
        if selected_relations:
            required_relations = [relation for relation in selected_relations if _yes(relation.get(f"linkRequired{mode}"))]
            risk_classifications = _risk_classifications(
                fields=governance_fields,
                selected_relations=selected_relations,
                kind=kind,
                content=content,
                mode=mode,
            )
    if capabilities.get("appScoring") is True and not unresolved_mode:
        scoring_items = _scoring_items(governance_scoring_items, mode)
    settings = None
    if capabilities.get("settings") is True:
        settings = {
            "isRelevant": row.get("fields", {}).get("Derived Application Is Relevant"),
            "isDataAvailable": row.get("fields", {}).get("Derived Application Is Data Available"),
        }
    documentation = ""
    if capabilities.get("appScoring") is True:
        documentation = _field(row, spec, "P1.APP.GRA.FACTORS_CONSIDERED")
    body = {
        "schemaVersion": RETURN_INTENTS_SCHEMA,
        "blockedPendingRecording": False,
        "blockedUnresolvedRait": unresolved_mode,
        "description": str(row.get("elementId") or ""),
        "settings": settings,
        "relationTargets": [str(value) for value in row.get("relations", [])],
        "riskControlCatalogRelations": selected_relations,
        "riskControlRelations": required_relations,
        "riskClassifications": risk_classifications,
        "scoringItems": scoring_items,
        "documentation": documentation,
    }
    return {**body, "semanticDigest": semantic_digest(body)}


def _identity_text(value: object) -> str:
    return " ".join(unicodedata.normalize("NFKC", str(value or "")).casefold().split())


def _yes(value: object) -> bool:
    return unicodedata.normalize("NFKC", str(value or "")).strip() == "Y"


def _catalog_number(value: object) -> str:
    return re.split(r"[|｜]", unicodedata.normalize("NFKC", str(value or "")).strip(), maxsplit=1)[0].strip()


def _app_family(value: object) -> str:
    normalized = "".join(character for character in unicodedata.normalize("NFKC", str(value or "")).casefold() if character.isalnum())
    normalized = re.sub(r"(?:application|应用程序)$", "", normalized)
    return "generic" if normalized in ("generic", "通用") else normalized


def _requested_family(kind: str, content: str) -> str:
    value = _identity_text(content)
    aliases = {
        "DB": {"GENERIC": ("generic", "generic database"), "ORACLE": ("oracle", "oracle database"), "SQL": ("sql", "sql database")},
        "OS": {"GENERIC": ("generic", "generic operating system"), "UNIX": ("unix",), "WIN": ("win", "windows")},
        "TOOL": {"TICKET": ("工单工具", "ticketing tool"), "IDENTITY": ("身份和访问管理工具", "identity & access management tool")},
        "DCNO": {"NETWORK": ("网络", "通用网络设备", "generic network device")},
    }.get(kind)
    require(aliases is not None, "PLAN.RELATION_SCOPE_DRIFT", f"Unsupported relation object kind: {kind}.")
    matches = [family for family, names in aliases.items() if value in {_identity_text(name) for name in names}]
    require(len(matches) <= 1, "PLAN.RELATION_SCOPE_DRIFT", f"GRA content {kind}/{content} maps to multiple governed relation families.")
    return matches[0] if matches else ""


def _family_matches(kind: str, content: str, actual_family: str) -> bool:
    expected = _app_family(content) if kind == "APP" else _requested_family(kind, content)
    actual = _app_family(actual_family) if kind == "APP" else actual_family
    return actual == expected


def _applicable_relations(relations: list[dict], kind: str, content: str, mode: str) -> list[dict]:
    selected: list[dict] = []
    for relation in relations:
        match = re.match(r"^REL\.(APP|DB|OS|TOOL|DCNO)\.([A-Z][A-Z0-9_]{0,63})\.", str(relation.get("relationId") or ""))
        require(match is not None, "PLAN.RELATION_SCOPE_DRIFT", f"Relation {relation.get('relationId') or '(missing)'} has no canonical object/subtype family.")
        if match.group(1) == kind and _family_matches(kind, content, match.group(2)) and _yes(relation.get(f"catalogPresent{mode}")):
            selected.append(dict(relation))
    selected.sort(key=lambda item: str(item.get("relationId") or ""))
    return selected


def _risk_classifications(*, fields: list[dict], selected_relations: list[dict], kind: str, content: str, mode: str) -> list[dict]:
    inventory: list[dict] = []
    for field in fields:
        match = re.match(r"^P1\.RISK\.(APP|DB|OS|TOOL|DCNO)\.([A-Z][A-Z0-9_]{0,63})\.(RAIT(?:COR|TOOL)\d+)$", str(field.get("fieldId") or ""))
        if match is None or match.group(1) != kind or not _family_matches(kind, content, match.group(2)):
            continue
        risk_number = match.group(3)
        require(_catalog_number(field.get("label")) == risk_number, "PLAN.RISK_CLASSIFICATION_GOVERNANCE_INVALID", f"Risk field identity drifted: {field.get('fieldId') or '(missing)' }.")
        require(str(field.get(f"{mode.casefold()}Applicable") or "").startswith("Y"), "PLAN.RISK_CLASSIFICATION_GOVERNANCE_INVALID", f"Risk field is not applicable for {mode}: {field.get('fieldId')}.")
        field_relations = [relation for relation in selected_relations if relation.get("riskFieldId") == field.get("fieldId")]
        classification = mode if any(_yes(relation.get(f"linkRequired{mode}")) for relation in field_relations) else "ClassificationNA"
        declared = {str(relation.get(f"classification{mode}") or "").strip() for relation in field_relations}
        require(len(declared) <= 1 and (not declared or classification in declared), "PLAN.RISK_CLASSIFICATION_GOVERNANCE_CONFLICT", f"Risk {risk_number}/{mode} classification is not derived from its link-required values.")
        inventory.append({
            "riskFieldId": str(field.get("fieldId") or ""),
            "riskName": str(field.get("label") or ""),
            "riskNumber": risk_number,
            "classification": classification,
        })
    require(inventory, "PLAN.RISK_CLASSIFICATION_GOVERNANCE_MISSING", f"{kind} content {content} has no exact governed Risk inventory.")
    inventory.sort(key=lambda item: item["riskFieldId"])
    return inventory


def _scoring_items(items: list[dict], mode: str) -> list[dict]:
    scoped: list[dict] = []
    for item in items:
        item_id = str(item.get("itemId") or "").strip()
        match = re.match(r"^APP\.RF\.DISPLAY_ORDER_(\d{2})$", item_id)
        require(match is not None, "PLAN.SCORING_GOVERNANCE_INVALID", f"Scoring item {item_id or '(missing)'} has no APP-generic display-order identity.")
        scope = " ".join(unicodedata.normalize("NFKC", str(item.get("objectType") or "")).split())
        require(re.match(r"^Application\s*/\s*all APP\s*/\s*GRA\s*/\s*IT风险评估$", scope, flags=re.IGNORECASE) is not None, "PLAN.SCORING_GOVERNANCE_INVALID", f"Scoring item {item_id} is outside the all-APP GRA scope.")
        raw = " ".join(unicodedata.normalize("NFKC", str(item.get("higherApplicable") if mode == "Higher" else item.get("lowerApplicable") or "")).split())
        applicable = raw.startswith("Y") or (raw.startswith("条件") and "applicable=true" in raw.casefold() and mode.casefold() in raw.casefold())
        require(applicable or raw.startswith("N"), "PLAN.SCORING_GOVERNANCE_INVALID", f"Scoring item {item_id} has an unsupported {mode} applicability rule.")
        if applicable:
            scoped.append({**item, "itemId": item_id, "displayOrder": int(match.group(1))})
    require(len(items) == 15 and len({str(item.get('itemId') or '') for item in items}) == 15, "PLAN.SCORING_GOVERNANCE_MISSING", "The APP-generic Risk Factor capability must contain exactly 15 governed items.")
    require(scoped, "PLAN.SCORING_GOVERNANCE_MISSING", f"APP/{mode} has no applicable governed Risk Factor scoring items.")
    scoped.sort(key=lambda item: item["displayOrder"])
    return scoped
