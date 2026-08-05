"""Governance-driven workbook parsing and isolated sidecar entry point."""

from __future__ import annotations

import os
import re
import sys
import unicodedata
from typing import Any

# Isolated mode deliberately omits the script directory. Add only this package-owned
# directory; the sidecar audit policy is installed before protocol processing below.
sys.dont_write_bytecode = True
_PYTHON_ROOT = os.path.realpath(os.path.dirname(__file__))
if _PYTHON_ROOT not in sys.path:
    sys.path.insert(0, _PYTHON_ROOT)

from canonical import canonical_bytes, semantic_digest, sha256_hex
from errors import EngineError, require
from ooxml import read_bounded, read_xlsx

PARSED_SCHEMA = "omnia.create-associate.parsed-workbook/v1"

_RELATION_SPLIT = re.compile(r"[、,，;；]")
_WHITESPACE = re.compile(r"\s+")
_ILLEGAL_NAME = re.compile(r"[\x00-\x1f\x7f<>:\"/\\|?*、，,;；]")

DEFAULT_DEFINITIONS = (
    {"kind": "APP", "id": "系统ID", "required": ["系统ID", "APP类型", "System Risk Classification", "Factors Considered", "Omnia工作区"], "relation": ""},
    {"kind": "DB", "id": "数据库ID", "required": ["数据库ID", "DB 类型", "Omnia工作区", "关联系统ID"], "relation": "关联系统ID"},
    {"kind": "OS", "id": "服务器ID", "required": ["服务器ID", "OS 类型", "Omnia工作区", "关联系统ID"], "relation": "关联系统ID"},
    {"kind": "TOOL", "id": "IT TOOL ID", "required": ["IT TOOL ID", "Tool 类型", "System Risk Classification", "Omnia工作区"], "relation": ""},
)

DEFAULT_ENUMS = {
    "System Risk Classification": ("Higher", "Lower"),
    "APP类型": ("Generic", "SAP ECC"),
    "DB 类型": ("Generic", "Oracle", "SQL"),
    "OS 类型": ("Generic", "UNIX", "WIN"),
    "Tool 类型": ("工单工具", "身份和访问管理工具"),
}


def normalize_header(value: object) -> str:
    return _WHITESPACE.sub(" ", unicodedata.normalize("NFKC", str(value or ""))).strip()


def normalize_cell(value: object, declaration: dict | None = None) -> Any:
    if isinstance(value, bool):
        return value
    text = unicodedata.normalize("NFC", str(value or "")).strip()
    declaration = declaration or {}
    normalization = declaration.get("normalization") or declaration.get("normalizationRule") or "nfc_trim"
    rules = [normalization] if isinstance(normalization, str) else normalization
    for rule in rules if isinstance(rules, list) else []:
        if rule in ("nfkc", "NFKC", "nfkc_trim", "canonical_identity"):
            text = unicodedata.normalize("NFKC", text)
        if rule in ("collapse_whitespace", "nfkc_trim", "canonical_identity"):
            text = _WHITESPACE.sub(" ", text)
        if rule in ("lower", "casefold", "canonical_identity"):
            text = text.casefold()
    value_type = str(declaration.get("valueType") or declaration.get("type") or "string").lower()
    if value_type in ("boolean", "bool") and text:
        if text.casefold() in ("true", "1", "yes", "y"):
            return True
        if text.casefold() in ("false", "0", "no", "n"):
            return False
    return text


def derive_gra_name(element_id: object) -> str:
    return f"GRA-{unicodedata.normalize('NFC', str(element_id or '')).strip()}"


def description_raw_field(kind: str) -> str:
    return "Derived Application Description" if kind == "APP" else f"Derived {kind} Description"


def description_rule_id(kind: str) -> str:
    return "v8.app-description-from-element-id.v1" if kind == "APP" else f"v4.{kind.lower()}-description-from-element-id.v1"


def parse_workbook(source: object, *, source_artifact_id: str, governance: dict) -> dict:
    require(isinstance(source_artifact_id, str) and source_artifact_id.strip(), "INPUT.SOURCE_ARTIFACT_ID_REQUIRED", "sourceArtifactId is required.")
    _validate_governance(governance)
    source_bytes = read_bounded(source)
    workbook = read_xlsx(source_bytes, allow_formula_cache=False)
    definitions = _definitions(governance)
    declarations = {str(item.get("fieldId") or item.get("field_id") or ""): item for item in governance.get("fields", [])}
    aliases = governance.get("fieldAliases", {})
    field_ids = set(governance.get("fieldIds", [])) | set(declarations)
    rows: list[dict] = []
    candidates: list[dict] = []
    issues: list[dict] = []
    governance_source = _governance_source(governance)

    for sheet in workbook.sheets:
        headers: list[tuple[int, dict, list[str]]] = []
        for row_number in sorted(sheet.rows):
            source_row = sheet.rows[row_number]
            present = {normalize_header(value) for value in source_row if normalize_header(value)}
            matches = [definition for definition in definitions if normalize_header(definition["id"]) in present]
            if len(matches) > 1:
                raise EngineError("WORKBOOK.AMBIGUOUS_SECTION", f"Multiple element section identities occur in {sheet.name} row {row_number}.")
            if matches:
                headers.append((row_number, matches[0], source_row))
        for header_index, (header_row, definition, raw_header) in enumerate(headers):
            end_row = headers[header_index + 1][0] if header_index + 1 < len(headers) else (max(sheet.rows, default=header_row) + 1)
            names = [normalize_header(value) for value in raw_header]
            present = [name for name in names if name]
            require(len(present) == len(set(present)), "WORKBOOK.AMBIGUOUS_HEADER", f"Duplicate normalized columns in {sheet.name} row {header_row}.")
            columns = {name: index for index, name in enumerate(names) if name}
            identity_header = normalize_header(definition["id"])
            require(identity_header in columns, "WORKBOOK.IDENTITY_COLUMN_MISSING", f"Identity column is absent in {sheet.name} row {header_row}.")
            for source_row_number in range(header_row + 1, end_row):
                source_row = sheet.rows.get(source_row_number, [])
                identity_column = columns[identity_header]
                element_id = unicodedata.normalize("NFC", str(source_row[identity_column] if identity_column < len(source_row) else "")).strip()
                if not element_id:
                    continue
                populated = sum(1 for column in columns.values() if column < len(source_row) and str(source_row[column]).strip())
                if populated < 2:
                    continue
                kind = str(definition["kind"])
                row_key = sha256_hex(f"{kind}|{unicodedata.normalize('NFC', sheet.name)}|{source_row_number}")
                fields: dict[str, Any] = {}
                row_candidate_by_raw: dict[str, dict] = {}
                logical = {
                    "rowKey": row_key,
                    "kind": kind,
                    "elementId": element_id,
                    "sourceSheet": sheet.name,
                    "sourceRow": source_row_number,
                    "fields": fields,
                    "relations": [],
                }
                rows.append(logical)
                for raw_name, column in columns.items():
                    raw_value = source_row[column] if column < len(source_row) else ""
                    canonical_field_id = str(aliases.get(kind, {}).get(raw_name, ""))
                    declaration = declarations.get(canonical_field_id)
                    value = normalize_cell(raw_value, declaration)
                    fields[raw_name] = value
                    field_key = f"{row_key}.{canonical_field_id}" if canonical_field_id else f"{row_key}.unmapped.{sha256_hex(raw_name)}"
                    candidate = _candidate(
                        field_key=field_key,
                        raw_field_key=raw_name,
                        canonical_field_id=canonical_field_id,
                        value=value,
                        value_kind="source",
                        status="accepted" if value not in ("", None) else "needs_input",
                        source_artifact_id=source_artifact_id,
                        source_sheet=sheet.name,
                        source_row=source_row_number,
                        row_key=row_key,
                        trace=f"input:{sha256_hex(f'{source_artifact_id}|{sheet.name}|{source_row_number}|{raw_name}')}",
                        rule="verbatim_user_workbook_cell",
                    )
                    candidates.append(candidate)
                    row_candidate_by_raw[raw_name] = candidate
                    if not canonical_field_id:
                        issues.append(_issue("parser", "PARSER.UNMAPPED_FIELD", field_key, "ambiguous", "blocking", f"原始列 {raw_name} 无法唯一映射到 canonical field_id。", "template_structure"))
                    if raw_name == "System Risk Classification" and value and value not in ("Higher", "Lower"):
                        issues.append(_issue("local", "LOCAL.INVALID_ENUM", field_key, "invalid_enum", "needs_input", f"{kind} {element_id} 的 RAIT 仅允许 Higher 或 Lower。", "valid_values"))
                relation_field = normalize_header(definition.get("relation", ""))
                logical["relations"] = [part.strip() for part in _RELATION_SPLIT.split(str(fields.get(relation_field, ""))) if part.strip()] if relation_field else []
                _add_standard_derivations(
                    logical, candidates, row_candidate_by_raw, definition, declarations, governance,
                    governance_source=governance_source,
                )
                for required_raw in definition.get("required", []):
                    required = normalize_header(required_raw)
                    if fields.get(required) in ("", None):
                        candidate = row_candidate_by_raw.get(required)
                        field_key = candidate["fieldKey"] if candidate else f"{row_key}.missing.{sha256_hex(required)}"
                        issues.append(_issue("local", "LOCAL.REQUIRED_FIELD", field_key, "missing", "needs_input" if candidate else "blocking", f"{kind} {element_id} 缺少必填字段 {required}。", "required_fields"))

    _add_cross_row_semantics(rows, candidates, issues, source_artifact_id, field_ids)
    require(rows and candidates, "PARSER.NO_SUPPORTED_ROWS", "No populated APP/DB/OS/TOOL rows were found in the workbook.")
    issue_namespace = sha256_hex(source_artifact_id)
    for item in issues:
        issue_identity = f"{issue_namespace}|{item['code']}|{item['fieldKey']}"
        item["issueId"] = f"{item['origin']}-{sha256_hex(issue_identity)[:48]}"
    parsed = {
        "schemaVersion": PARSED_SCHEMA,
        "sourceArtifactId": source_artifact_id,
        "sourceDigest": sha256_hex(source_bytes),
        "governanceDigest": str(governance.get("semanticDigest") or semantic_digest(_governance_semantics(governance))),
        "rows": rows,
        "candidates": candidates,
        "issues": issues,
        "issueNamespace": issue_namespace,
        "sheetNames": [sheet.name for sheet in workbook.sheets],
    }
    parsed["semanticDigest"] = semantic_digest({key: value for key, value in parsed.items() if key != "semanticDigest"})
    return parsed


def _definitions(governance: dict) -> tuple[dict, ...]:
    supplied = governance.get("inputDefinitions")
    if supplied is None:
        return DEFAULT_DEFINITIONS
    require(isinstance(supplied, list) and supplied, "GOVERNANCE.INPUT_DEFINITIONS_INVALID", "inputDefinitions must be a non-empty array.")
    result = []
    for item in supplied:
        require(isinstance(item, dict) and item.get("kind") in ("APP", "DB", "OS", "TOOL") and item.get("id"), "GOVERNANCE.INPUT_DEFINITION_INVALID", "Each input definition needs kind and id.")
        result.append({"kind": item["kind"], "id": normalize_header(item["id"]), "required": [normalize_header(x) for x in item.get("required", [])], "relation": normalize_header(item.get("relation", ""))})
    return tuple(result)


def _validate_governance(governance: object) -> None:
    require(isinstance(governance, dict), "GOVERNANCE.REQUIRED", "A governance JSON object is required.")
    require(isinstance(governance.get("fieldAliases"), dict), "GOVERNANCE.FIELD_ALIASES_REQUIRED", "fieldAliases is required.")
    require(isinstance(governance.get("derivationRules"), list), "GOVERNANCE.DERIVATION_RULES_REQUIRED", "derivationRules is required.")
    expected = governance.get("semanticDigest")
    if expected:
        observed = semantic_digest(_governance_semantics(governance))
        require(str(expected).lower() == observed, "GOVERNANCE.SEMANTIC_DIGEST_MISMATCH", "Governance semantic digest does not match its content.", expected=expected, observed=observed)


def _governance_semantics(governance: dict) -> dict:
    return {
        "fields": governance.get("fields", []),
        "relations": governance.get("relations", []),
        "scoringItems": governance.get("scoringItems", []),
        "derivationRules": governance.get("derivationRules", []),
    }


def _governance_source(governance: dict) -> str:
    ref = str(governance.get("sourceRef") or governance.get("managedGovernanceRef") or "governance")
    digest = str(governance.get("sourceSha256") or governance.get("semanticDigest") or "").lower()
    return f"{ref}:sha256:{digest}" if digest else ref


def _rule(governance: dict, rule_id: str) -> dict | None:
    return next((item for item in governance.get("derivationRules", []) if item.get("ruleId") == rule_id), None)


def _add_standard_derivations(logical: dict, candidates: list[dict], source_candidates: dict[str, dict], definition: dict, declarations: dict[str, dict], governance: dict, *, governance_source: str) -> None:
    kind, row_key, element_id = logical["kind"], logical["rowKey"], logical["elementId"]
    id_candidate = source_candidates.get(normalize_header(definition["id"]))
    gra_rule = _rule(governance, "v4.phase1-gra-name-from-element-id.v1")
    require(id_candidate and gra_rule and gra_rule.get("algorithm") == "prefix_literal" and gra_rule.get("prefix") == "GRA-" and gra_rule.get("targetFieldId") == "P1.RUNTIME.GRA.NAME", "GOVERNANCE.GRA_NAME_RULE_MISSING", "Signed GRA name derivation rule is unavailable.")
    _append_derived(candidates, logical, "Derived GRA Name", "P1.RUNTIME.GRA.NAME", derive_gra_name(element_id), "derived", gra_rule, governance_source, id_candidate)
    target = f"P1.{kind}.IT.DESCRIPTION"
    desc_rule = _rule(governance, description_rule_id(kind))
    require(target in declarations and desc_rule and desc_rule.get("targetFieldId") == target and desc_rule.get("algorithm") == "canonical_element_id" and desc_rule.get("dependencyFieldId") == f"P1.{kind}.IT.ELEMENT_ID", "GOVERNANCE.DESCRIPTION_RULE_MISSING", f"Signed {kind} description derivation rule is unavailable.")
    _append_derived(candidates, logical, description_raw_field(kind), target, element_id, "derived", desc_rule, governance_source, id_candidate, source_row=int(declarations[target].get("sourceRow") or 0), source_sheet="字段母版")
    if kind == "APP":
        for raw_name, target_id, rule_id, source_sheet in (
            ("Derived Application Is Relevant", "P1.APP.IT.IS_RELEVANT", "v8.app-is-relevant-false.v1", "字段母版"),
            ("Derived Application Is Data Available", "P1.APP.IT.IS_DATA_AVAILABLE", "v4.app-is-data-available-false.v1", "V4接口证据"),
        ):
            declaration, rule = declarations.get(target_id), _rule(governance, rule_id)
            require(declaration and rule and rule.get("targetFieldId") == target_id and rule.get("algorithm") == "constant_boolean_false" and rule.get("constantValue") is False, "GOVERNANCE.CONSTANT_RULE_MISSING", f"Signed constant-false rule is unavailable: {rule_id}.")
            _append_derived(candidates, logical, raw_name, target_id, False, "rule_default", rule, governance_source, None, source_row=int(declaration.get("sourceRow") or 0), source_sheet=source_sheet)


def _append_derived(candidates: list[dict], logical: dict, raw: str, canonical_id: str, value: Any, value_kind: str, rule: dict, source_artifact_id: str, dependency: dict | None, *, source_row: int = 1, source_sheet: str = "V4接口证据") -> None:
    field_key = f"{logical['rowKey']}.{canonical_id}"
    candidate = _candidate(field_key=field_key, raw_field_key=raw, canonical_field_id=canonical_id, value=value, value_kind=value_kind, status="accepted", source_artifact_id=source_artifact_id, source_sheet=source_sheet, source_row=source_row, row_key=logical["rowKey"], trace=str(rule.get("sourceTraceId") or ""), rule=str(rule.get("ruleId") or ""))
    if dependency:
        candidate["provenance"]["dependencyFieldKey"] = dependency["fieldKey"]
    candidates.append(candidate)
    logical["fields"][raw] = value


def _candidate(**values: Any) -> dict:
    return {
        "fieldKey": values["field_key"], "rawFieldKey": values["raw_field_key"], "canonicalFieldId": values["canonical_field_id"],
        "revision": 1, "valueKind": values["value_kind"], "value": values["value"], "status": values["status"],
        "provenance": {
            "sourceArtifactId": values["source_artifact_id"], "sourceSheet": values["source_sheet"], "sourceRow": values["source_row"],
            "rowKey": values["row_key"], "fieldKey": values["field_key"], "sourceTraceId": values["trace"], "derivationRule": values["rule"],
        },
    }


def _issue(origin: str, code: str, field_key: str, issue_type: str, state: str, message: str, check_id: str) -> dict:
    return {"issueId": "", "origin": origin, "code": code, "fieldKey": field_key, "issueType": issue_type, "state": state, "message": message, "checkId": check_id}


def _add_declared_value_issues(row: dict, source_candidates: dict[str, dict], declarations: dict[str, dict], aliases: dict, issues: list[dict]) -> None:
    for raw_name, canonical_id in aliases.items():
        candidate = source_candidates.get(raw_name)
        if not candidate:
            continue
        declaration = declarations.get(str(canonical_id), {})
        value = candidate["value"]
        allowed = declaration.get("allowedValues") or declaration.get("enum") or DEFAULT_ENUMS.get(raw_name)
        if value not in ("", None) and allowed and value not in allowed:
            issues.append(_issue("local", "LOCAL.INVALID_ENUM", candidate["fieldKey"], "invalid_enum", "needs_input", f"{row['kind']} {row['elementId']} 的 {raw_name} 值不在受管枚举中。", "valid_values"))
        maximum = declaration.get("maxLength")
        if maximum is not None and len(str(value)) > int(maximum):
            issues.append(_issue("local", "LOCAL.FIELD_TOO_LONG", candidate["fieldKey"], "invalid", "needs_input", f"{row['kind']} {row['elementId']} 的 {raw_name} 超过 {maximum} 字符上限。", "valid_values"))
    if _ILLEGAL_NAME.search(row["elementId"]) or set(row["elementId"]) == {"."} or len(derive_gra_name(row["elementId"])) > 200:
        identity = next(iter(source_candidates.values()))
        issues.append(_issue("local", "LOCAL.ILLEGAL_ELEMENT_NAME", identity["fieldKey"], "invalid", "needs_input", f"{row['kind']} 元素 ID 含非法字符，或派生 GRA 名超过 200 字符。", "valid_values"))


def _add_cross_row_semantics(rows: list[dict], candidates: list[dict], issues: list[dict], source_artifact_id: str, field_ids: set[str]) -> None:
    identities: dict[str, dict] = {}
    apps: dict[str, list[dict]] = {}
    for row in rows:
        workspace = next((str(value) for name, value in row["fields"].items() if "Omnia" in name), "")
        key = f"{row['kind']}|{row['elementId']}|{unicodedata.normalize('NFKC', workspace)}".casefold()
        previous = identities.get(key)
        if previous:
            same = canonical_bytes(previous["fields"]) == canonical_bytes(row["fields"])
            message = f"{row['kind']} {row['elementId']} 在同一规范身份下重复。" if same else f"{row['kind']} {row['elementId']} 存在冲突的重复行。"
            issues.append(_issue("local", "LOCAL.DUPLICATE_IDENTITY", f"{row['rowKey']}.identity", "conflict", "blocking", message, "unique_names"))
        else:
            identities[key] = row
        if row["kind"] == "APP":
            apps.setdefault(row["elementId"].casefold(), []).append(row)
    for row in (item for item in rows if item["kind"] in ("DB", "OS")):
        matched: list[dict] = []
        for relation in row["relations"]:
            app_rows = apps.get(relation.casefold(), [])
            if not app_rows:
                issues.append(_issue("local", "UNSUPPORTED.EXTERNAL_APP_REFERENCE", f"{row['rowKey']}.relationship-target-live", "contract_mismatch", "blocking", f"{row['kind']} {row['elementId']} 引用的 APP {relation} 不在当前批次；未冻结外部目标前禁止准备回传。", "relationship_targets"))
            matched.extend(app_rows)
        modes = {str(app["fields"].get("System Risk Classification", "")) for app in matched}
        if len(matched) == 1 and len(modes) == 1 and next(iter(modes)) in ("Higher", "Lower"):
            canonical_id = f"P1.{row['kind']}.GRA.RAIT_CONCLUSION"
            require(canonical_id in field_ids, "GOVERNANCE.INHERITANCE_FIELD_MISSING", f"{canonical_id} is absent from signed governance.")
            value = next(iter(modes))
            field_key = f"{row['rowKey']}.{canonical_id}"
            inheritance_identity = f"{matched[0]['rowKey']}|{row['rowKey']}|{row['relations'][0]}"
            candidate = _candidate(field_key=field_key, raw_field_key="Inherited System Risk Classification", canonical_field_id=canonical_id, value=value, value_kind="inherited", status="accepted", source_artifact_id=source_artifact_id, source_sheet=row["sourceSheet"], source_row=row["sourceRow"], row_key=row["rowKey"], trace=f"inheritance:{sha256_hex(inheritance_identity)}", rule=f"planned_db_os_rait_from_app_edge:{matched[0]['rowKey']};remote_verification_required_before_return")
            candidates.append(candidate)
            row["fields"]["Inherited System Risk Classification"] = value


if __name__ == "__main__":
    from protocol import main

    main()
