"""Feature-owned reconstruction of GRA/Risk/Control catalogs from raw read evidence."""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import parse_qs, urlparse

from recording_store import RecordingError, require


CATALOG_FORMAT = "omnia-v5-risk-control-catalog/v1"
FEATURE_PRODUCER = "omnia.recording.python-gra-reconstruction/v1"
_GUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]+")
_SPACE = re.compile(r"\s+")


def _text(value: Any, maximum: int = 500) -> str:
    result = _SPACE.sub(" ", _CONTROL.sub(" ", "" if value is None else str(value))).strip()
    return result[:maximum]


def _id(value: Any) -> str:
    result = _text(value, 200).lower()
    return "" if result == "00000000-0000-0000-0000-000000000000" else result


def _guid(value: Any) -> str:
    result = _id(value)
    return result if _GUID.fullmatch(result) else ""


def _rows(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for key in ("items", "data"):
            if isinstance(value.get(key), list):
                return value[key]
    return []


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _first(source: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = source.get(key)
        if value is not None and value != "":
            return value
    return None


def _assertions(value: Any) -> list[str]:
    found: set[str] = set()
    for item in _rows(value):
        candidate = item if isinstance(item, str) else _first(_record(item), "assertion", "assertionType", "code")
        text = _text(candidate, 80)
        if text:
            found.add(text)
    return sorted(found)


def _risk_scope_lookup(risk: dict[str, Any]) -> str:
    direct = _first(risk, "riskRiskScopeId", "riskScopeId")
    if direct:
        return _id(direct)
    nested = _record(risk.get("riskRiskScope"))
    if nested.get("id"):
        return _id(nested["id"])
    scopes = _rows(_first(risk, "riskScopes", "riskRiskScopes", "scopes"))
    if scopes:
        return _id(_first(_record(scopes[0]), "riskRiskScopeId", "id"))
    return ""


def _summarize_risk(raw_value: Any, source_endpoint: str) -> dict[str, Any]:
    raw = _record(raw_value)
    scopes: list[dict[str, Any]] = []
    for item in _rows(_first(raw, "riskScopes", "riskRiskScopes", "scopes")):
        scope = _record(item)
        scopes.append({
            "riskScopeId": _id(_first(scope, "riskScopeId", "riskRiskScopeId", "id")),
            "riskRiskScopeId": _id(_first(scope, "riskRiskScopeId", "id")),
            "assertionType": _text(scope.get("assertionType")),
            "assertions": _assertions(_first(scope, "assertions", "assertionTypes")),
            "enabled": scope.get("enabled") is not False and scope.get("isEnabled") is not False and scope.get("isDeleted") is not True,
        })
    if not scopes:
        lookup = _risk_scope_lookup(raw)
        if lookup:
            scopes.append({
                "riskScopeId": _id(raw.get("riskScopeId")),
                "riskRiskScopeId": lookup,
                "assertionType": _text(raw.get("assertionType")),
                "assertions": _assertions(raw.get("assertions")),
                "enabled": True,
            })
    count_value = raw.get("numberOfControls")
    count = count_value if isinstance(count_value, int) and not isinstance(count_value, bool) and count_value >= 0 else None
    return {
        "id": _id(_first(raw, "id", "riskId")),
        "riskNumber": _text(_first(raw, "riskNumber", "inkRiskNumber", "number")),
        "description": _text(_first(raw, "description", "riskDescription", "name"), 4_000),
        "classificationType": _text(_first(raw, "classificationType", "riskClassificationType", "raitConclusionLevel")),
        "numberOfControls": count,
        "riskScopes": scopes,
        "sourceEndpoint": source_endpoint,
    }


def _summarize_control(raw_value: Any, source_endpoint: str) -> dict[str, Any]:
    raw = _record(raw_value)
    scopes: list[dict[str, Any]] = []
    for item in _rows(_first(raw, "currentRiskScopes", "riskScopes", "controlRiskScopes")):
        scope = _record(item)
        scopes.append({
            "riskId": _id(_first(scope, "riskId", "plannedResponseRiskId")),
            "riskScopeId": _id(_first(scope, "riskScopeId", "riskRiskScopeId")),
            "assertions": _assertions(_first(scope, "assertions", "assertionTypes")),
            "enabled": scope.get("enabled") is not False and scope.get("isEnabled") is not False and scope.get("isDeleted") is not True,
        })
    return {
        "id": _id(_first(raw, "id", "controlId")),
        "controlNumber": _text(_first(raw, "controlNumber", "number")),
        "name": _text(_first(raw, "name", "controlName"), 2_000),
        "description": _text(_first(raw, "description", "controlDescription"), 4_000),
        "assertionInformation": _assertions(_first(raw, "assertions", "assertionTypes")),
        "riskScopes": scopes,
        "sourceEndpoint": source_endpoint,
    }


def _risk_factor_settings(payload_value: Any) -> dict[str, Any]:
    payload = _record(payload_value)
    factors = _rows(payload.get("riskFactors"))
    categories: dict[str, dict[str, Any]] = {}
    for item in factors:
        factor = _record(item)
        grouping = _record(factor.get("riskFactorGrouping"))
        grouping_id = _id(grouping.get("id"))
        if grouping_id and grouping_id not in categories:
            applicable = grouping.get("applicable") if isinstance(grouping.get("applicable"), bool) else None
            categories[grouping_id] = {
                "id": grouping_id,
                "name": _text(grouping.get("name"), 1_000),
                "applicable": applicable,
                "source": "live-risk-factor-settings-response",
            }
    it_category = next((item for item in categories.values() if re.search(r"it\s*risk\s*assessment|it\s*风险评估", item["name"], re.I)), None)
    projected_factors: list[dict[str, Any]] = []
    for item in factors:
        factor = _record(item)
        order = factor.get("displayOrder")
        if not isinstance(order, (int, float)) or isinstance(order, bool):
            order = None
        projected_factors.append({
            "id": _id(factor.get("id")),
            "displayOrder": order,
            "description": _text(factor.get("description"), 4_000),
            "applicable": factor.get("applicable") if isinstance(factor.get("applicable"), bool) else None,
            "riskLevel": factor.get("riskLevel"),
            "riskLevelSpectrum": factor.get("riskLevelSpectrum") if isinstance(factor.get("riskLevelSpectrum"), list) else [],
            "categoryId": _id(_record(factor.get("riskFactorGrouping")).get("id")),
        })
    return {
        "source": "live-risk-factor-settings-response",
        "categories": list(categories.values()),
        "itRiskAssessment": None if it_category is None else {
            "categoryId": it_category["id"],
            "categoryName": it_category["name"],
            "enabled": it_category["applicable"],
        },
        "factors": projected_factors,
    }


def _normalize_rait(gra: dict[str, Any], risks: list[dict[str, Any]]) -> str:
    values = [
        _first(gra, "itElementRaitConclusionLevelName", "itElementRaitConclusionLevelId", "itElementRaitConclusionLevel",
               "lastSubmittedITElementRaitConclusionLevelId", "raitConclusionLevel", "classificationType"),
        *[risk.get("classificationType") for risk in risks],
    ]
    normalized = [_text(value).lower() for value in values]
    if any(value == "higher" or re.search(r"\bhigher\b", value) for value in normalized):
        return "Higher"
    if any(value == "lower" or re.search(r"\blower\b", value) for value in normalized):
        return "Lower"
    return ""


def _it_element_id(gra: dict[str, Any]) -> str:
    direct = _first(gra, "itElementId", "entityId", "applicationId", "infrastructureId", "toolId")
    if direct:
        return _id(direct)
    for item in _rows(gra.get("riskScopes")):
        candidate = _id(_record(item).get("entityId"))
        if candidate:
            return candidate
    return ""


def _read_evidence(catalog: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], list[str]]:
    evidence = catalog.get("evidence")
    require(isinstance(evidence, list) and len(evidence) <= 2_000,
            "RECORDING.GRA_EVIDENCE_INVALID", "Catalog raw read evidence is missing or exceeds the bounded Feature parser limit.")
    indexed: dict[str, dict[str, Any]] = {}
    missing: list[str] = []
    for value in evidence:
        item = _record(value)
        key = _text(item.get("key"), 240)
        require(bool(key) and key not in indexed, "RECORDING.GRA_EVIDENCE_INVALID", "Catalog raw read evidence key is missing or duplicated.")
        require(item.get("method") == "GET", "RECORDING.GRA_EVIDENCE_MUTATION", "Catalog reconstruction accepts read-only GET evidence only.")
        indexed[key] = item
        if item.get("ok") is not True or item.get("responseCaptured") is not True or not isinstance(item.get("response"), (dict, list)):
            missing.append(f"{key}: {_text(item.get('error'), 300) or 'raw response was not captured'}")
    return indexed, missing


def rebuild_catalog(record: dict[str, Any], recording_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """Rebuild one canonical catalog without trusting Connector business projections."""

    transport_catalog = record.get("catalog")
    require(isinstance(transport_catalog, dict), "RECORDING.GRA_EVIDENCE_INVALID", "Catalog transport record is invalid.")
    stable_id = _guid(record.get("stableId"))
    require(bool(stable_id), "RECORDING.GRA_IDENTITY_INVALID", "Catalog transport record lacks a canonical GRA identity.")
    evidence, missing_reasons = _read_evidence(transport_catalog)

    def response(key: str) -> Any:
        item = evidence.get(key)
        return item.get("response") if item and item.get("ok") is True and item.get("responseCaptured") is True else None

    gra = _record(response("gra-detail"))
    raw_risks = _rows(response("risk-list"))
    raw_controls = _rows(response("control-list"))
    risk_factor_payload = response("risk-factor-settings")
    it_element = _record(response("it-element-detail"))
    gra_identity = _guid(_first(gra, "id", "riskAssessmentId"))
    if gra_identity and gra_identity != stable_id:
        raise RecordingError("RECORDING.GRA_IDENTITY_DRIFT", "Raw GRA detail does not match the catalog transport identity.")
    if not gra_identity:
        missing_reasons.append("gra-detail: raw response did not expose the expected GRA identity")

    risk_list_endpoint = _text(_record(evidence.get("risk-list")).get("url"), 4_096)
    control_list_endpoint = _text(_record(evidence.get("control-list")).get("url"), 4_096)
    risks: list[dict[str, Any]] = []
    risk_details: dict[str, dict[str, Any]] = {}
    for raw_value in raw_risks:
        raw = _record(raw_value)
        summary = _summarize_risk(raw, risk_list_endpoint)
        risk_id = summary["id"]
        lookup_id = _risk_scope_lookup(raw)
        detail_key = f"risk-scope-detail:{risk_id}"
        detail = _record(response(detail_key))
        if not risk_id or not summary["riskNumber"]:
            missing_reasons.append("risk-list: a Risk is missing immutable ID or riskNumber")
        if not lookup_id:
            missing_reasons.append(f"risk-scope-detail:{risk_id or summary['riskNumber'] or '(unknown)'}: no riskRiskScopeId")
        elif not detail:
            missing_reasons.append(f"{detail_key}: raw detail response was not captured")
        if detail:
            risk_details[risk_id] = detail
            detailed = next((_record(item) for item in _rows(detail.get("planResponseRisk")) if _id(_record(item).get("id")) == risk_id), raw)
            detail_endpoint = _text(_record(evidence.get(detail_key)).get("url"), 4_096)
            summary = _summarize_risk({**raw, **detailed}, detail_endpoint)
            summary["directorySourceEndpoint"] = risk_list_endpoint
            summary["detailSourceEndpoint"] = detail_endpoint
        risks.append(summary)

    controls: list[dict[str, Any]] = []
    control_details: dict[str, dict[str, Any]] = {}
    for raw_value in raw_controls:
        raw = _record(raw_value)
        control_id = _guid(_first(raw, "id", "controlId"))
        detail_key = f"control-detail:{control_id}"
        detail = _record(response(detail_key))
        if not control_id:
            missing_reasons.append("control-list: a Control is missing immutable ID")
        elif not detail:
            missing_reasons.append(f"{detail_key}: raw detail response was not captured")
        if detail:
            control_details[control_id] = detail
            detail_endpoint = _text(_record(evidence.get(detail_key)).get("url"), 4_096)
            summary = _summarize_control(detail, detail_endpoint)
            summary["directorySourceEndpoint"] = control_list_endpoint
            summary["detailSourceEndpoint"] = detail_endpoint
        else:
            summary = _summarize_control(raw, control_list_endpoint)
        controls.append(summary)

    relations: dict[str, dict[str, Any]] = {}

    def add_relation(risk_id_value: Any, control_id_value: Any, scope_value: Any, endpoint: str, source: str) -> bool:
        scope = _record(scope_value)
        risk_id = _id(risk_id_value or _first(scope, "riskId", "plannedResponseRiskId"))
        control_id = _id(control_id_value or scope.get("controlId"))
        risk_scope_id = _id(_first(scope, "riskScopeId", "riskRiskScopeId"))
        if not risk_id or not control_id or not risk_scope_id:
            return False
        relation = {
            "relationType": "observed_control_risk_scope",
            "riskAssessmentId": stable_id,
            "riskId": risk_id,
            "controlId": control_id,
            "riskScopeId": risk_scope_id,
            "assertions": _assertions(_first(scope, "assertions", "assertionTypes")),
            "enabled": scope.get("enabled") is not False and scope.get("isEnabled") is not False and scope.get("isDeleted") is not True,
            "observed": True,
            "sourceEndpoint": endpoint,
            "responseSource": source,
            "catalogPresenceDoesNotImplyTemplateLink": True,
        }
        key = f"{risk_id}:{control_id}:{risk_scope_id}:{','.join(relation['assertions'])}"
        previous = relations.get(key)
        if previous:
            relation["enabled"] = previous["enabled"] or relation["enabled"]
        relations[key] = relation
        return True

    for control in controls:
        endpoint = _text(control.get("detailSourceEndpoint") or control.get("sourceEndpoint"), 4_096)
        for scope in control["riskScopes"]:
            add_relation(scope.get("riskId"), control["id"], scope, endpoint, "live-control-detail-response")
    for risk_id, detail in risk_details.items():
        risk = next((item for item in risks if item["id"] == risk_id), {})
        endpoint = _text(risk.get("detailSourceEndpoint"), 4_096)
        for control_value in _rows(detail.get("planResponseControl")):
            control = _record(control_value)
            control_id = _id(_first(control, "id", "controlId"))
            scopes = [scope for scope in _rows(_first(control, "currentRiskScopes", "riskScopes", "controlRiskScopes"))
                      if not _id(_first(_record(scope), "riskId", "plannedResponseRiskId"))
                      or _id(_first(_record(scope), "riskId", "plannedResponseRiskId")) == risk_id]
            if not scopes:
                missing_reasons.append(f"risk-control-relation:{risk_id}:{control_id or '(unknown)'}: no stable risk scope")
            for scope in scopes:
                add_relation(risk_id, control_id, scope, endpoint, "live-risk-scope-detail-response")
    for control_id, detail in control_details.items():
        control = next((item for item in controls if item["id"] == control_id), {})
        endpoint = _text(control.get("detailSourceEndpoint"), 4_096)
        for scope in _rows(_first(detail, "currentRiskScopes", "riskScopes", "controlRiskScopes")):
            add_relation(_first(_record(scope), "riskId", "plannedResponseRiskId"), control_id, scope, endpoint, "live-control-detail-response")

    relation_rows = sorted(relations.values(), key=lambda item: f"{item['riskId']}:{item['controlId']}:{item['riskScopeId']}")
    settings = _risk_factor_settings(risk_factor_payload) if isinstance(risk_factor_payload, dict) else None
    element_type = _text(_first(it_element, "elementType", "itElementType", "type") or gra.get("type"))
    requires_it_risk_assessment = element_type.casefold() == "application"
    if not settings or (requires_it_risk_assessment and not settings.get("itRiskAssessment")):
        missing_reasons.append("risk-factor-settings: authoritative IT Risk Assessment category was not returned")
    for control in controls:
        if not any(item["controlId"] == control["id"] for item in relation_rows):
            missing_reasons.append(f"risk-control-relation:{control['id'] or control['controlNumber']}: no stable relation edge")
    for risk in risks:
        observed = len({item["controlId"] for item in relation_rows if item["riskId"] == risk["id"] and item["enabled"]})
        expected = risk.get("numberOfControls")
        if isinstance(expected, int) and observed != expected:
            missing_reasons.append(f"risk-control-relation:{risk['id']}: expected {expected} Controls but observed {observed} stable enabled edges")
        if not any(scope.get("riskScopeId") or scope.get("riskRiskScopeId") for scope in risk["riskScopes"]):
            missing_reasons.append(f"risk-scope-detail:{risk['id'] or risk['riskNumber']}: no stable scope identity")

    captured_rait = _normalize_rait(gra, risks)
    if not captured_rait:
        missing_reasons.append("rait: raw GRA/Risk responses did not provide Higher or Lower")
    it_element_id = _it_element_id(gra)
    if not it_element_id:
        missing_reasons.append("it-element-detail: raw GRA response did not expose a unique IT Element ID")
    workspace_id = _id(_first(gra, "workspaceId", "workspaceFacetId"))
    gra_content = _text(_first(gra, "graContentName", "contentName", "riskAssessmentContentName"))
    gra_content_id = _id(_first(gra, "inkContentId", "contentId", "riskAssessmentContentId"))
    if not workspace_id:
        missing_reasons.append("identity: raw GRA response did not provide a stable Workspace ID")
    if not _text(_first(gra, "name", "displayName")):
        missing_reasons.append("identity: raw GRA response did not provide a stable name")
    if not gra_content and not gra_content_id:
        missing_reasons.append("identity: raw GRA response did not provide a stable GRA content identity")
    if not element_type:
        missing_reasons.append("identity: raw IT Element/GRA response did not provide element type")

    missing_reasons = list(dict.fromkeys(_text(item, 500) for item in missing_reasons if _text(item, 500)))
    required_keys = {"gra-detail", "risk-list", "control-list", "risk-factor-settings", "it-element-detail"}
    required_reads_complete = not missing_reasons and required_keys.issubset(evidence) and all(
        evidence[key].get("ok") is True and evidence[key].get("responseCaptured") is True for key in required_keys
    )
    endpoint_evidence = [{key: value for key, value in item.items() if key != "response"} for item in evidence.values()]
    endpoint_evidence.sort(key=lambda item: _text(item.get("key")))
    transport_identity = _record(transport_catalog.get("identity"))
    transport_engagement = _record(transport_identity.get("engagement"))
    transport_pack = _record(transport_identity.get("pack"))
    rebuilt = {
        "schemaVersion": CATALOG_FORMAT,
        "producer": FEATURE_PRODUCER,
        "capturedAt": _text(transport_catalog.get("capturedAt"), 100),
        "status": "complete" if required_reads_complete else "incomplete",
        "readOnly": True,
        "identity": {
            "engagement": {"id": _id(_first(gra, "engagementId") or transport_engagement.get("id")), "name": "", "clientName": ""},
            "pack": {"id": _id(_first(gra, "engagementId") or transport_pack.get("id")), "name": ""},
            "workspace": {"id": workspace_id, "name": _text(gra.get("workspaceName"))},
            "gra": {"id": stable_id, "workItemId": _id(gra.get("workItemId")), "name": _text(_first(gra, "name", "displayName")), "referenceNumber": _text(gra.get("referenceNumber")), "content": gra_content, "contentId": gra_content_id},
            "itElement": {"id": it_element_id, "workItemId": _id(_first(it_element, "workItemId", "applicationWorkItemId", "itToolWorkItemId")), "number": _text(_first(it_element, "number", "referenceNumber")), "name": _text(_first(it_element, "name", "displayName")), "elementType": element_type, "subtype": _text(_first(it_element, "subtype", "infrastructureType", "databaseType", "category", "typeId"))},
            "capturedRait": captured_rait,
        },
        "applicability": {"capturedRait": captured_rait, "inferredOtherRait": False, "linkRequired": None, "note": "Catalog presence does not imply a template link; no unrecorded RAIT was inferred."},
        "settings": {
            "source": "live-omnia-read-only-api",
            "gra": {
                "status": gra.get("status"),
                "itElementRaitConclusionLevelId": gra.get("itElementRaitConclusionLevelId"),
                "lastSubmittedITElementRaitConclusionLevelId": gra.get("lastSubmittedITElementRaitConclusionLevelId"),
            },
            "riskFactorEvaluation": settings,
        },
        "risks": risks,
        "controls": controls,
        "observedRelations": relation_rows,
        "completeness": {
            "status": "complete" if required_reads_complete else "incomplete",
            "requiredReadsComplete": required_reads_complete,
            "riskCount": len(risks),
            "controlCount": len(controls),
            "riskDetailCovered": sum(1 for item in risks if item.get("detailSourceEndpoint")),
            "controlDetailCovered": sum(1 for item in controls if item.get("detailSourceEndpoint")),
            "riskFactorSettingsCaptured": settings is not None,
            "relationCount": len(relation_rows),
            "missingReasons": missing_reasons,
            "endpoints": endpoint_evidence,
            "capturedAt": _text(transport_catalog.get("capturedAt"), 100),
            "reconstructedBy": FEATURE_PRODUCER,
        },
        "evidence": list(evidence.values()),
    }
    metadata = {
        "riskAssessmentId": stable_id,
        "status": rebuilt["status"],
        "riskCount": len(risks),
        "controlCount": len(controls),
        "missingReasons": missing_reasons[:100],
        "capturedAt": rebuilt["capturedAt"],
        "producer": FEATURE_PRODUCER,
        "transportRecordingId": recording_id,
    }
    return metadata, rebuilt


def rebuild_catalogs_from_observation_evidence(
    responses: list[dict[str, Any]], recording_id: str
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    """Route generic GET response evidence into Feature-owned GRA reconstruction.

    URL classification lives here rather than in Connector. The observation host
    only emits redacted, bounded read evidence; this Feature decides which reads
    form a recording catalog and fails closed when required responses are absent.
    """

    require(isinstance(responses, list) and len(responses) <= 2_000,
            "RECORDING.RESPONSE_LIMIT", "Page observation response evidence exceeds the bounded parser limit.")
    parsed_rows: list[tuple[dict[str, Any], str, dict[str, list[str]]]] = []
    for value in responses:
        row = _record(value)
        require(row.get("method") == "GET", "RECORDING.GRA_EVIDENCE_MUTATION", "Catalog reconstruction accepts read-only GET evidence only.")
        url = _text(row.get("url"), 4_096)
        try:
            parsed = urlparse(url)
        except ValueError:
            continue
        path = parsed.path.rstrip("/").lower()
        query = {key.lower(): values for key, values in parse_qs(parsed.query).items()}
        parsed_rows.append((row, path, query))

    bases: dict[str, dict[str, dict[str, Any]]] = {}
    risk_details: dict[str, dict[str, Any]] = {}
    control_details: dict[str, dict[str, Any]] = {}
    element_details: dict[str, dict[str, Any]] = {}

    def path_guid(path: str) -> str:
        return _guid(path.rsplit("/", 1)[-1])

    def query_guid(query: dict[str, list[str]], key: str) -> str:
        values = query.get(key.lower()) or []
        return _guid(values[0]) if values else ""

    def remember_base(risk_assessment_id: str, key: str, row: dict[str, Any]) -> None:
        if risk_assessment_id:
            bases.setdefault(risk_assessment_id, {})[key] = row

    for row, path, query in parsed_rows:
        if re.search(r"/riskassessments/[0-9a-f-]{36}$", path):
            remember_base(path_guid(path), "gra-detail", row)
        elif "/plannedresponse/byriskassessmentid" in path:
            remember_base(query_guid(query, "riskassessmentid"), "risk-list", row)
        elif re.search(r"/controls/byriskassessmentid/[0-9a-f-]{36}$", path):
            remember_base(path_guid(path), "control-list", row)
        elif re.search(r"/risk-factors/byriskassessmentid/[0-9a-f-]{36}$", path):
            remember_base(path_guid(path), "risk-factor-settings", row)
        elif "/plannedresponse/getplanresponsedetailbyriskriskscopeid" in path:
            scope_id = query_guid(query, "riskriskscopeid")
            if scope_id:
                risk_details[scope_id] = row
        elif re.search(r"/controls/[0-9a-f-]{36}$", path) and "/byriskassessmentid/" not in path:
            control_id = path_guid(path)
            if control_id:
                control_details[control_id] = row
        elif re.search(r"/itelement/[0-9a-f-]{36}$", path):
            element_id = path_guid(path)
            if element_id:
                element_details[element_id] = row

    def evidence(key: str, row: dict[str, Any] | None) -> dict[str, Any]:
        source = row or {}
        captured = source.get("responseCaptured") is True and isinstance(source.get("response"), (dict, list))
        status = source.get("status")
        ok = captured and isinstance(status, int) and not isinstance(status, bool) and 200 <= status < 300
        result = {
            "key": key,
            "method": "GET",
            "url": _text(source.get("url"), 4_096),
            "required": True,
            "ok": ok,
            "status": status if isinstance(status, int) and not isinstance(status, bool) else 0,
            "responseCaptured": captured,
            "responseMediaType": _text(source.get("contentType"), 200),
            "responseSource": "page-observation-managed-stream",
            "error": "" if ok else _text(source.get("error"), 300) or "required observed GET response was unavailable",
            "response": source.get("response") if captured else None,
        }
        return result

    catalogs: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for risk_assessment_id in sorted(bases):
        base = bases[risk_assessment_id]
        gra_row = base.get("gra-detail")
        gra = _record(gra_row.get("response") if gra_row else None)
        risk_row = base.get("risk-list")
        control_row = base.get("control-list")
        raw_risks = _rows(risk_row.get("response") if risk_row else None)
        raw_controls = _rows(control_row.get("response") if control_row else None)
        evidence_rows = [evidence(key, base.get(key)) for key in (
            "gra-detail", "risk-list", "control-list", "risk-factor-settings"
        )]
        it_element_id = _guid(_it_element_id(gra))
        evidence_rows.append(evidence("it-element-detail", element_details.get(it_element_id)))
        for raw_value in raw_risks:
            raw = _record(raw_value)
            risk_id = _id(_first(raw, "id", "riskId"))
            scope_id = _guid(_risk_scope_lookup(raw))
            if risk_id:
                evidence_rows.append(evidence(f"risk-scope-detail:{risk_id}", risk_details.get(scope_id)))
        for raw_value in raw_controls:
            raw = _record(raw_value)
            control_id = _guid(_first(raw, "id", "controlId"))
            if control_id:
                evidence_rows.append(evidence(f"control-detail:{control_id}", control_details.get(control_id)))
        record = {
            "stableId": risk_assessment_id,
            "catalog": {
                "capturedAt": _text(gra_row.get("occurredAt") if gra_row else "", 100),
                "identity": {"engagement": {"id": ""}, "pack": {"id": ""}},
                "evidence": evidence_rows,
            },
        }
        catalogs.append(rebuild_catalog(record, recording_id))
    return catalogs
