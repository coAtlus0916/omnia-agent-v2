"""Offline integration fixtures for the registry-driven create/associate engine.

The runner consumes the exact signed-governance projection and managed source
template through stdin.  Every workbook case edits real OOXML bytes in memory,
then calls the production parser, validator, and capability-plan compiler.
"""

from __future__ import annotations

import base64
import importlib.util
import io
import json
import os
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
PYTHON_ROOT = ROOT / "python"
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))
sys.dont_write_bytecode = True

ENGINE_PATH = PYTHON_ROOT / 'create-associate-engine.py'
ENGINE_SPEC = importlib.util.spec_from_file_location('create_associate_feature_engine', ENGINE_PATH)
if ENGINE_SPEC is None or ENGINE_SPEC.loader is None:
    raise ImportError('Create/associate Feature engine entry is unavailable.')
ENGINE = importlib.util.module_from_spec(ENGINE_SPEC)
ENGINE_SPEC.loader.exec_module(ENGINE)
_is_candidate_data_row = ENGINE._is_candidate_data_row
parse_workbook = ENGINE.parse_workbook
validate_ir = ENGINE.validate_ir
from plan_ir import build_plan_ir  # noqa: E402
from canonical import semantic_digest  # noqa: E402

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
XML_NS = "http://www.w3.org/XML/1998/namespace"
ET.register_namespace("", MAIN_NS)


def require(condition: object, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def patched_workbook(source: bytes, cells: dict[str, object]) -> bytes:
    input_buffer = io.BytesIO(source)
    output_buffer = io.BytesIO()
    patched: set[str] = set()
    with zipfile.ZipFile(input_buffer, "r") as archive, zipfile.ZipFile(output_buffer, "w", zipfile.ZIP_DEFLATED) as output:
        for info in archive.infolist():
            data = archive.read(info.filename)
            if info.filename.startswith("xl/worksheets/") and info.filename.endswith(".xml"):
                root = ET.fromstring(data)
                present = {cell.get("r") for cell in root.findall(f".//{{{MAIN_NS}}}c")}
                relevant = set(cells).intersection(present)
                if relevant:
                    for address in relevant:
                        cell = root.find(f".//{{{MAIN_NS}}}c[@r='{address}']")
                        require(cell is not None, f"Managed template cell is absent: {address}")
                        for child in list(cell):
                            cell.remove(child)
                        cell.set("t", "inlineStr")
                        inline = ET.SubElement(cell, f"{{{MAIN_NS}}}is")
                        text = ET.SubElement(inline, f"{{{MAIN_NS}}}t")
                        value = str(cells[address])
                        if value != value.strip():
                            text.set(f"{{{XML_NS}}}space", "preserve")
                        text.text = value
                        patched.add(address)
                    data = ET.tostring(root, encoding="utf-8", xml_declaration=True)
            output.writestr(info, data)
    require(patched == set(cells), f"Managed template did not expose fixture cells: {sorted(set(cells) - patched)}")
    return output_buffer.getvalue()


def issue_from_fixture(spec: dict, parsed: dict) -> dict:
    field_key = str(spec.get("fieldKey") or "")
    if spec.get("elementId"):
        matches = [row for row in parsed["rows"] if row["elementId"] == spec["elementId"]]
        require(len(matches) == 1, f"Fixture issue element is not unique: {spec['elementId']}")
        field_key = f"{matches[0]['rowKey']}.{spec.get('fieldSuffix') or 'fixture'}"
    return {
        "issueId": f"fixture-{spec['code'].lower().replace('.', '-')}",
        "origin": "parser",
        "code": spec["code"],
        "fieldKey": field_key,
        "issueType": "contract_mismatch",
        "state": spec.get("state", "blocking"),
        "message": f"Fixture blocker {spec['code']}",
        "checkId": "template_structure",
    }


def assert_registry(case: dict, governance: dict) -> None:
    registry = governance["kindRegistry"]
    require(sorted(registry) == case["expectedKinds"], "Signed kind registry inventory drifted.")
    for kind, spec in registry.items():
        require(spec.get("id") and spec.get("objectType") and spec.get("objectSubtype"), f"{kind} identity binding is incomplete.")
        require(isinstance(spec.get("aliases"), dict) and isinstance(spec.get("capabilities"), dict), f"{kind} registry shape is incomplete.")
        require(isinstance(spec.get("stageNodes"), list) and spec["stageNodes"], f"{kind} has no parameterized stage plan.")
    app_content = next(field for field in registry["APP"]["reviewFields"] if field["canonicalFieldId"] == "P1.APP.GRA.GRA_CONTENT")
    require(app_content["allowedValues"] == ["Generic", "SAP ECC", "SAP S/4 HANA", "Oracle EBS"], "APP content-family contract drifted.")
    os_content = next(field for field in registry["OS"]["reviewFields"] if field["canonicalFieldId"] == "P1.OS.GRA.GRA_CONTENT")
    tool_content = next(field for field in registry["TOOL"]["reviewFields"] if field["canonicalFieldId"] == "P1.TOOL.GRA.GRA_CONTENT")
    require(os_content["allowedValues"] == ["Generic", "UNIX", "WIN", "AD"], "OS V5 content-family contract drifted.")
    require(tool_content["allowedValues"] == ["工单工具", "身份和访问管理工具", "代码迁移工具"], "Tool V5 content-family contract drifted.")
    require(registry["APP"].get("pendingRecordingContentValues") == [{
        "inputValue": "Oracle EBS", "expectedOmniaContentName": "Oracle eBusiness Suite",
        "status": "recorded_exact_content_live_relation_readback_pending",
        "evidenceRef": "artifact:1c864692-7b02-498c-be5f-bf38adcab14f#sha256=b143e180ed8a59fdbf78e7d6170503739f0f3e320cc9632eb9af1383018d9801",
    }], "Oracle EBS exact content authority/provenance drifted.")
    require(registry["OS"].get("pendingRecordingContentValues") == [{
        "inputValue": "AD", "expectedOmniaContentName": "通用操作系统", "status": "recorded_exact_content_and_relations",
        "evidenceRef": "artifact:7695dde4-5e93-4a10-acae-fc8a67087a35#sha256=e307939bf33a066e1218cded0e22955ce9cb47322d8f57a334011e84fb56045c",
    }], "AD recorded content/relations boundary drifted.")
    require(registry["TOOL"].get("pendingRecordingContentValues") == [{
        "inputValue": "代码迁移工具", "expectedOmniaContentName": "代码迁移工具", "status": "recorded_exact_content_and_relations",
        "evidenceRef": "artifact:04a5e0aa-bdcd-4b0c-8e6d-469425300633#sha256=6b65ff2db328bc72b7970a43dcfea40d90fa27a6af162fd9adaf8ef53e8f2597",
    }], "Code-migration Tool recorded content/relations boundary drifted.")
    require(registry["DB"]["relationPolicy"]["relationType"] == "InfrastructureApplication", "DB relation family drifted.")
    require(registry["OS"]["relationPolicy"]["relationType"] == "InfrastructureApplication", "OS relation family drifted.")
    require(registry["TOOL"]["relationPolicy"] == {"targetKind": "APP", "min": 1, "max": 1, "relationType": "ItToolApplication", "concurrencyTabId": 802}, "TOOL exact-one APP contract drifted.")
    dcno = registry["DCNO"]
    require(dcno["returnSupport"] == "supported", "DCNO signed Network lifecycle support drifted.")
    require(dcno.get("riskControlSupportedRaitValues") == ["Higher", "Lower"], "DCNO Higher/Lower catalog parity drifted.")
    require(dcno["stageNodes"] == ["object", "relation", "gra", "inherited_rait", "risk_classification", "risk_control", "evaluation"], "DCNO must reuse the parameterized Infrastructure lifecycle stages.")
    for capability in ("object", "gra", "relation", "inheritedRait", "riskControl", "evaluation"):
        require(dcno["capabilities"].get(capability) is True, f"DCNO recorded capability is disabled: {capability}.")
    for capability in ("settings", "directRait", "appScoring", "aiReview"):
        require(dcno["capabilities"].get(capability) is False, f"DCNO borrowed an inapplicable APP capability: {capability}.")
    oracle = governance.get("oracleEbs") or {}
    require(oracle.get("contentName") == "Oracle eBusiness Suite"
            and oracle.get("recordedEvidenceCatalogKey") == "66176468"
            and oracle.get("recordedAppCategoryKey") == "66175343"
            and oracle.get("recordedContentType") == 3
            and oracle.get("higherRelations") == 11
            and oracle.get("lowerRelations") == 7 and oracle.get("catalogRelations") == 12,
            "Oracle EBS governed alias/key/category or scope counts drifted.")
    oracle_relations = [relation for relation in governance.get("relations", [])
                        if relation.get("relationId", "").startswith("REL.APP.ORACLE_EBS.")]
    require(len(oracle_relations) == 12
            and sum(relation.get("linkRequiredHigher") == "Y" for relation in oracle_relations) == 11
            and sum(relation.get("linkRequiredLower") == "Y" for relation in oracle_relations) == 7,
            "Oracle EBS Higher/Lower relation inventory drifted.")
    oebs_04 = next((relation for relation in oracle_relations
                    if relation.get("relationId") == "REL.APP.ORACLE_EBS.RAITCOR001.OEBS_04"), None)
    require(isinstance(oebs_04, dict) and oebs_04.get("linkRequiredHigher") == "N"
            and oebs_04.get("linkRequiredLower") == "N",
            "Oracle EBS OEBS.04 must remain unlinked in both modes.")
    oracle_family = next((family for family in governance.get("catalogIdentityRegistry", {}).get("families", [])
                          if family.get("relationIdPrefix") == "REL.APP.ORACLE_EBS."), None)
    require(isinstance(oracle_family, dict) and oracle_family.get("requiresExplicitCatalogControlNumber") is True
            and oracle_family.get("status") == "blocked_pending_live_relation_readback"
            and oracle_family.get("identities") == []
            and oracle_family.get("evidenceMetadata", {}).get("executionGate") is False,
            "Oracle EBS live relation-readback boundary must remain explicit non-execution metadata.")
    ad_relations = [relation for relation in governance.get("relations", [])
                    if relation.get("relationId", "").startswith("REL.OS.AD.")]
    require([relation.get("relationId") for relation in ad_relations] == [
        "REL.OS.AD.RAITCOR001.OS_02", "REL.OS.AD.RAITCOR001.OS_06",
        "REL.OS.AD.RAITCOR003.OS_05", "REL.OS.AD.RAITCOR006.OS_10",
    ] and all(relation.get("linkRequiredHigher") == "Y" and relation.get("linkRequiredLower") == "Y" for relation in ad_relations),
            "AD exact Higher/Lower Risk-Control relations drifted.")
    migration_relations = [relation for relation in governance.get("relations", [])
                           if relation.get("relationId", "").startswith("REL.TOOL.MIGRATION.")]
    require([relation.get("relationId") for relation in migration_relations] == [
        "REL.TOOL.MIGRATION.RAITTOOL002.TOOL_05", "REL.TOOL.MIGRATION.RAITTOOL002.TOOL_06",
        "REL.TOOL.MIGRATION.RAITTOOL003.TOOL_10",
    ] and all(relation.get("linkRequiredHigher") == "Y" and relation.get("linkRequiredLower") == "Y" for relation in migration_relations),
            "Code-migration exact Higher/Lower Risk-Control relations drifted.")


def assert_workbook_case(case: dict, governance: dict, template: bytes) -> None:
    workbook = patched_workbook(template, case["cells"])
    parsed = parse_workbook(workbook, source_artifact_id=f"fixture:{case['testId']}", governance=governance)
    for element_id in case.get("excludeElementIds", []):
        matches = [row["rowKey"] for row in parsed["rows"] if row["elementId"] == element_id]
        require(len(matches) == 1, f"Excluded fixture row is not unique: {element_id}")
        parsed.setdefault("excludedRowKeys", []).extend(matches)
    parsed.setdefault("issues", []).extend(issue_from_fixture(spec, parsed) for spec in case.get("addIssues", []))
    parsed = validate_ir(parsed)
    issue_codes = {issue["code"] for issue in parsed["issues"] if issue.get("state") in ("blocking", "needs_input")}
    require(set(case.get("expectedIssueCodes", [])).issubset(issue_codes), f"Expected validation issues are absent: {case['testId']} / {sorted(issue_codes)}")
    require(not set(case.get("forbiddenIssueCodes", [])).intersection(issue_codes), f"Forbidden validation issue remains active: {case['testId']} / {sorted(issue_codes)}")
    plan = build_plan_ir(parsed=parsed, governance=governance)
    require(plan.get("globalBlockerCodes", []) == case.get("expectedGlobalBlockerCodes", []), f"Global blocker projection drifted: {case['testId']}")
    parsed_by_key = {row["rowKey"]: row for row in parsed["rows"]}
    plan_by_element = {row["object"]["externalId"]: row for row in plan["rows"]}
    for expected in case.get("expectedRows", []):
        actual = plan_by_element.get(expected["elementId"])
        require(actual is not None, f"Expected plan row is absent: {case['testId']} / {expected['elementId']}")
        for key in ("kind", "status", "returnSupport"):
            if key in expected:
                require(actual.get(key) == expected[key], f"{case['testId']} / {expected['elementId']} {key} drifted: {actual.get(key)}")
        if "rait" in expected:
            require(actual["rait"]["value"] == expected["rait"], f"{case['testId']} / {expected['elementId']} RAIT drifted.")
        if "appScoring" in expected:
            require(actual["capabilities"]["appScoring"] is expected["appScoring"], f"{case['testId']} / {expected['elementId']} scoring capability drifted.")
        if "isRelevant" in expected:
            parsed_row = parsed_by_key[actual["rowKey"]]
            require(parsed_row["fields"].get("Derived Application Is Relevant") is expected["isRelevant"], f"{case['testId']} / {expected['elementId']} APP relevance derivation drifted.")
            relevance_candidate = next((candidate for candidate in parsed["candidates"] if candidate.get("canonicalFieldId") == "P1.APP.IT.IS_RELEVANT" and candidate.get("provenance", {}).get("rowKey") == actual["rowKey"]), None)
            require(isinstance(relevance_candidate, dict) and relevance_candidate.get("valueKind") == "rule_default" and relevance_candidate.get("value") is True and relevance_candidate.get("provenance", {}).get("derivationRule") == "phase1.app-is-relevant-true.v2", f"{case['testId']} / {expected['elementId']} APP relevance signed rule-default revision drifted.")
        if "dependencies" in expected:
            dependencies = sorted(parsed_by_key[key]["elementId"] for key in actual["dependencyRowKeys"])
            require(dependencies == sorted(expected["dependencies"]), f"{case['testId']} / {expected['elementId']} dependency plan drifted: {dependencies}")
        if "blockerCodes" in expected:
            require(actual["blockerCodes"] == expected["blockerCodes"], f"{case['testId']} / {expected['elementId']} blockers drifted.")
        intents = actual.get("returnIntents")
        require(isinstance(intents, dict) and intents.get("schemaVersion") == "omnia.create-associate.deterministic-return-intents/v1", f"{case['testId']} / {expected['elementId']} has no frozen Python Return intents.")
        intent_body = {key: value for key, value in intents.items() if key != "semanticDigest"}
        require(intents.get("semanticDigest") == semantic_digest(intent_body), f"{case['testId']} / {expected['elementId']} Return-intent digest drifted.")
        if "scoringItems" in expected:
            require(len(intents["scoringItems"]) == expected["scoringItems"], f"{case['testId']} / {expected['elementId']} scoring intent inventory drifted.")
        if "riskControlCatalog" in expected:
            require(len(intents["riskControlCatalogRelations"]) == expected["riskControlCatalog"], f"{case['testId']} / {expected['elementId']} Risk-Control catalog intent inventory drifted.")
        if "riskControlRequired" in expected:
            require(len(intents["riskControlRelations"]) == expected["riskControlRequired"], f"{case['testId']} / {expected['elementId']} required Risk-Control intent inventory drifted.")
        if "riskClassifications" in expected:
            classifications = {item["riskNumber"]: item["classification"] for item in intents["riskClassifications"]}
            require(classifications == expected["riskClassifications"], f"{case['testId']} / {expected['elementId']} Risk classification intents drifted: {classifications}")
        if "blockedPendingRecording" in expected:
            require(intents["blockedPendingRecording"] is expected["blockedPendingRecording"], f"{case['testId']} / {expected['elementId']} recording evidence became a Return permission gate.")
    excluded = set(case.get("excludeElementIds", []))
    require(not excluded.intersection(plan_by_element), f"Excluded rows leaked into the frozen plan: {case['testId']}")


def main() -> None:
    payload = json.load(sys.stdin)
    governance = payload["governance"]
    fixtures = payload["fixtures"]
    template = base64.b64decode(payload["templateBase64"])
    results = []
    for case in fixtures["pythonCases"]:
        if case["kind"] == "registry":
            assert_registry(case, governance)
        elif case["kind"] == "workbook":
            assert_workbook_case(case, governance, template)
        elif case["kind"] == "parser-unbounded-row-policy":
            sheet = SimpleNamespace(data_entry_row_ranges=(), merged_row_ranges=(), bordered_cells={})
            require(_is_candidate_data_row(sheet, 10_000, ["", "ScaleApp", "Generic"], {1, 2}, 2), "Parser silently reintroduced a fixed template-row cap.")
            require(not _is_candidate_data_row(sheet, 10_000, ["", "Section", "Section"], {1, 2}, 2), "Repeated section labels must not become data rows.")
        else:
            raise AssertionError(f"Unsupported Python fixture kind: {case['kind']}")
        results.append({"testId": case["testId"], "status": "passed"})
    json.dump({"schemaVersion": "omnia.create-associate.fixture-results/v1", "results": results}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
