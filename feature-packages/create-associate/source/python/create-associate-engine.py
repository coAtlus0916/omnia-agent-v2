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
_SUSPICIOUS_NAME_PATTERNS = (
    (re.compile(r"^普通", re.IGNORECASE), "命名过于通用，建议使用具体业务标识。"),
    (re.compile(r"^XX+$", re.IGNORECASE), "疑似占位符命名，需替换为正式名称。"),
    (re.compile(r"^随便", re.IGNORECASE), "命名不规范，疑似测试或临时命名。"),
    (re.compile(r"^测试", re.IGNORECASE), "疑似测试命名，生产环境需规范化。"),
    (re.compile(r"^(?:temp|test|demo|sample|tmp)", re.IGNORECASE), "疑似测试、示例或临时命名，需替换为正式名称。"),
    (re.compile(r"^(?:new|old|backup)", re.IGNORECASE), "疑似临时、废弃或备份命名，需确认这是正式 ID。"),
)

def normalize_header(value: object) -> str:
    return _WHITESPACE.sub(" ", unicodedata.normalize("NFKC", str(value or ""))).strip()


def normalize_cell(value: object, declaration: dict | None = None) -> Any:
    if isinstance(value, bool):
        return value
    text = unicodedata.normalize("NFC", str("" if value is None else value)).strip()
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


def _has_user_content(value: object) -> bool:
    return value is not None and (not isinstance(value, str) or bool(value.strip()))


def _row_in_ranges(row_number: int, ranges: tuple[tuple[int, int], ...]) -> bool:
    return any(start <= row_number <= end for start, end in ranges)


def _is_candidate_data_row(sheet: object, row_number: int, source_row: list[str], declared_columns: set[int], populated_declared: int) -> bool:
    if _row_in_ranges(row_number, sheet.data_entry_row_ranges):
        return True
    # Section/title bands in the governed workbook are sometimes emitted as
    # the same label copied across every styled column instead of one merged
    # cell.  They are presentation structure, not user rows.  Keep genuinely
    # partial rows (including one-cell rows) so they receive explicit issues;
    # only suppress this repeated-label structure outside declared entry
    # ranges.
    populated_values = [
        normalize_header(value)
        for index, value in enumerate(source_row)
        if index in declared_columns and _has_user_content(value)
    ]
    if len(populated_values) >= 2 and len(set(populated_values)) == 1:
        return False
    if populated_declared >= 2:
        return True
    if _row_in_ranges(row_number, sheet.merged_row_ranges):
        return False
    bordered = sheet.bordered_cells.get(row_number, frozenset())
    return any(index in bordered and _has_user_content(value) for index, value in enumerate(source_row) if index in declared_columns)


def derive_gra_name(element_id: object) -> str:
    return f"GRA-{unicodedata.normalize('NFC', str(element_id or '')).strip()}"


def suspicious_name_message(element_id: object) -> str:
    value = unicodedata.normalize("NFC", str(element_id or "")).strip()
    return next((message for pattern, message in _SUSPICIOUS_NAME_PATTERNS if pattern.search(value)), "")


def parse_workbook(source: object, *, source_artifact_id: str, governance: dict) -> dict:
    require(isinstance(source_artifact_id, str) and source_artifact_id.strip(), "INPUT.SOURCE_ARTIFACT_ID_REQUIRED", "sourceArtifactId is required.")
    _validate_governance(governance)
    source_bytes = read_bounded(source)
    workbook = read_xlsx(source_bytes, allow_formula_cache=False)
    kind_registry = _kind_registry(governance)
    definitions = _definitions(kind_registry)
    declarations = {str(item.get("fieldId") or item.get("field_id") or ""): item for item in governance.get("fields", [])}
    app_content_allowed_values = _declared_allowed_values(declarations.get("P1.APP.GRA.GRA_CONTENT"))
    require(app_content_allowed_values, "GOVERNANCE.APP_CONTENT_VALUES_MISSING", "Signed governance does not declare any Application GRA content values.")
    aliases = {kind: spec["aliases"] for kind, spec in kind_registry.items()}
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
                if not any(_has_user_content(value) for value in source_row):
                    continue
                identity_column = columns[identity_header]
                identity_value = source_row[identity_column] if identity_column < len(source_row) else ""
                element_id = unicodedata.normalize("NFC", str("" if identity_value is None else identity_value)).strip()
                populated = sum(1 for column in columns.values() if column < len(source_row) and _has_user_content(source_row[column]))
                if not _is_candidate_data_row(sheet, source_row_number, source_row, set(columns.values()), populated):
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
                identity_candidate = row_candidate_by_raw.get(identity_header)
                if not element_id:
                    field_key = identity_candidate["fieldKey"] if identity_candidate else f"{row_key}.identity"
                    issues.append(_issue("parser", "PARSER.IDENTITY_VALUE_MISSING", field_key, "missing", "blocking", f"{sheet.name} 第 {source_row_number} 行包含用户内容，但 {identity_header} 为空；该候选行不能被静默忽略。", "template_structure"))
                if populated < 2:
                    issues.append(_issue("parser", "PARSER.INCOMPLETE_CANDIDATE_ROW", f"{row_key}.template-structure", "missing", "blocking", f"{sheet.name} 第 {source_row_number} 行包含用户内容，但已填写的声明列少于 2 个；请补齐必填字段或清空整行。", "template_structure"))
                relation_field = normalize_header(definition.get("relation", ""))
                logical["relations"] = [part.strip() for part in _RELATION_SPLIT.split(str(fields.get(relation_field, ""))) if part.strip()] if relation_field else []
                _add_standard_derivations(
                    logical, candidates, row_candidate_by_raw, kind_registry[kind], declarations, governance,
                    governance_source=governance_source,
                )
                for required_raw in definition.get("required", []):
                    required = normalize_header(required_raw)
                    if fields.get(required) in ("", None):
                        candidate = row_candidate_by_raw.get(required)
                        field_key = candidate["fieldKey"] if candidate else f"{row_key}.missing.{sha256_hex(required)}"
                        issues.append(_issue("local", "LOCAL.REQUIRED_FIELD", field_key, "missing", "needs_input" if candidate else "blocking", f"{kind} {element_id} 缺少必填字段 {required}。", "required_fields"))

    _add_cross_row_semantics(rows, candidates, issues, source_artifact_id, field_ids, kind_registry)
    require(rows and candidates, "PARSER.NO_SUPPORTED_ROWS", "No populated APP/DB/OS/TOOL/DCNO rows were found in the workbook.")
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
        "appContentAllowedValues": list(app_content_allowed_values),
        "kindRegistry": kind_registry,
    }
    _recompute_local_issues(parsed)
    parsed["semanticDigest"] = semantic_digest({key: value for key, value in parsed.items() if key != "semanticDigest"})
    return parsed


def validate_ir(parsed: dict) -> dict:
    """Recompute the one authoritative local-review projection for an edited IR."""
    require(isinstance(parsed, dict) and parsed.get("schemaVersion") == PARSED_SCHEMA, "IR.SCHEMA_INVALID", "Edited IR schemaVersion is invalid.")
    require(isinstance(parsed.get("rows"), list) and isinstance(parsed.get("candidates"), list), "IR.CONTENT_INVALID", "Edited IR rows/candidates are invalid.")
    _recompute_local_issues(parsed)
    parsed["semanticDigest"] = semantic_digest({key: value for key, value in parsed.items() if key != "semanticDigest"})
    return parsed


def _kind_registry(governance: dict) -> dict:
    supplied = governance.get("kindRegistry")
    require(isinstance(supplied, dict) and supplied, "GOVERNANCE.KIND_REGISTRY_MISSING", "kindRegistry must be a non-empty object.")
    for kind, spec in supplied.items():
        require(
            isinstance(spec, dict)
            and spec.get("id")
            and isinstance(spec.get("aliases"), dict)
            and isinstance(spec.get("reviewFields"), list)
            and spec.get("reviewFields")
            and isinstance(spec.get("capabilities"), dict)
            and isinstance(spec.get("stageNodes"), list)
            and isinstance(spec.get("derivations"), list),
            "GOVERNANCE.KIND_REGISTRY_INVALID",
            f"Kind capability is invalid: {kind}.",
        )
        relation = str(spec.get("relation") or "")
        policy = spec.get("relationPolicy")
        require(
            (not relation and policy in (None, {}))
            or (
                relation
                and isinstance(policy, dict)
                and policy.get("targetKind") == "APP"
                and isinstance(policy.get("min"), int)
                and isinstance(policy.get("max"), int)
                and 0 <= policy["min"] <= policy["max"]
                and policy.get("relationType") in ("InfrastructureApplication", "ItToolApplication")
            ),
            "GOVERNANCE.RELATION_POLICY_INVALID",
            f"Relation policy is invalid: {kind}.",
        )
    return supplied


def _definitions(registry: dict) -> tuple[dict, ...]:
    result = []
    for kind, spec in registry.items():
        required = [field["rawFieldKey"] for field in spec["reviewFields"] if field.get("required")]
        result.append({"kind": kind, "id": normalize_header(spec["id"]), "required": [normalize_header(x) for x in required], "relation": normalize_header(spec.get("relation", ""))})
    return tuple(result)


def _validate_governance(governance: object) -> None:
    require(isinstance(governance, dict), "GOVERNANCE.REQUIRED", "A governance JSON object is required.")
    _kind_registry(governance)
    require(isinstance(governance.get("derivationRules"), list), "GOVERNANCE.DERIVATION_RULES_REQUIRED", "derivationRules is required.")
    expected = governance.get("semanticDigest")
    if expected:
        observed = semantic_digest(_governance_semantics(governance))
        require(str(expected).lower() == observed, "GOVERNANCE.SEMANTIC_DIGEST_MISMATCH", "Governance semantic digest does not match its content.", expected=expected, observed=observed)


def _governance_semantics(governance: dict) -> dict:
    return {
        "kindRegistry": governance.get("kindRegistry", {}),
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


def _add_standard_derivations(logical: dict, candidates: list[dict], source_candidates: dict[str, dict], kind_spec: dict, declarations: dict[str, dict], governance: dict, *, governance_source: str) -> None:
    element_id = logical["elementId"]
    id_candidate = source_candidates.get(normalize_header(kind_spec["id"]))
    gra_rule = _rule(governance, "v4.phase1-gra-name-from-element-id.v1")
    require(id_candidate and gra_rule and gra_rule.get("algorithm") == "prefix_literal" and gra_rule.get("prefix") == "GRA-" and gra_rule.get("targetFieldId") == "P1.RUNTIME.GRA.NAME", "GOVERNANCE.GRA_NAME_RULE_MISSING", "Signed GRA name derivation rule is unavailable.")
    _append_derived(candidates, logical, "Derived GRA Name", "P1.RUNTIME.GRA.NAME", derive_gra_name(element_id), "derived", gra_rule, governance_source, id_candidate)
    for derivation in kind_spec["derivations"]:
        raw_name = str(derivation.get("rawFieldKey") or "")
        target_id = str(derivation.get("fieldId") or "")
        rule_id = str(derivation.get("ruleId") or "")
        value_source = str(derivation.get("valueSource") or "")
        declaration, rule = declarations.get(target_id), _rule(governance, rule_id)
        require(raw_name and declaration and rule and rule.get("targetFieldId") == target_id, "GOVERNANCE.DERIVATION_RULE_MISSING", f"Signed derivation is unavailable: {rule_id}.")
        if value_source == "element_id":
            require(rule.get("algorithm") == "canonical_element_id", "GOVERNANCE.DERIVATION_RULE_INVALID", f"Element-ID derivation is invalid: {rule_id}.")
            value, value_kind, dependency = element_id, "derived", id_candidate
        elif value_source in ("constant_false", "constant_true"):
            expected = value_source == "constant_true"
            require(rule.get("algorithm") == f"constant_boolean_{str(expected).lower()}" and rule.get("constantValue") is expected and declaration.get("defaultRuleId") == rule_id and declaration.get("defaultValue") is expected, "GOVERNANCE.DERIVATION_RULE_INVALID", f"Constant-{str(expected).lower()} derivation is invalid: {rule_id}.")
            value, value_kind, dependency = expected, "rule_default", None
        else:
            raise EngineError("GOVERNANCE.DERIVATION_VALUE_SOURCE_INVALID", f"Unsupported signed derivation value source: {value_source}.")
        _append_derived(
            candidates, logical, raw_name, target_id, value, value_kind, rule, governance_source, dependency,
            source_row=int(declaration.get("sourceRow") or 0), source_sheet=str(derivation.get("sourceSheet") or "字段母版"),
        )


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


def _add_cross_row_semantics(rows: list[dict], candidates: list[dict], issues: list[dict], source_artifact_id: str, field_ids: set[str], registry: dict) -> None:
    identities: dict[str, dict] = {}
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
    _resolve_app_relations(rows, candidates, issues, field_ids, registry, source_artifact_id=source_artifact_id)


def _workspace(row: dict) -> str:
    return unicodedata.normalize("NFKC", str(row.get("fields", {}).get("Omnia工作区", ""))).strip()


def _app_relation_issue(row: dict, code: str, issue_type: str, message: str, *, check_id: str = "relationship_targets") -> dict:
    return _issue("local", code, f"{row['rowKey']}.relations", issue_type, "blocking", message, check_id)


def _resolve_app_relations(rows: list[dict], candidates: list[dict], issues: list[dict], field_ids: set[str], registry: dict, *, source_artifact_id: str) -> None:
    """Resolve every registry-declared APP edge once and derive RAIT when requested."""
    apps_by_id: dict[str, list[dict]] = {}
    identities_by_id: dict[str, list[dict]] = {}
    for candidate in rows:
        key = str(candidate.get("elementId", "")).casefold()
        identities_by_id.setdefault(key, []).append(candidate)
        if candidate.get("kind") == "APP":
            apps_by_id.setdefault(key, []).append(candidate)

    for row in rows:
        spec = registry.get(row.get("kind"), {})
        raw_relation_field = normalize_header(spec.get("relation", ""))
        if not raw_relation_field:
            row["relations"] = []
            continue
        policy = spec["relationPolicy"]
        relation_values = [part.strip() for part in _RELATION_SPLIT.split(str(row["fields"].get(raw_relation_field, ""))) if part.strip()]
        row["relations"] = relation_values
        minimum, maximum = int(policy["min"]), int(policy["max"])
        if not minimum <= len(relation_values) <= maximum:
            code = "LOCAL.TOOL_EXACTLY_ONE_APP_REQUIRED" if minimum == maximum == 1 else "LOCAL.APP_REFERENCE_CARDINALITY"
            expected = "恰好一个" if minimum == maximum == 1 else f"{minimum} 至 {maximum} 个"
            check_id = "infrastructure_links" if spec.get("inheritRait") is True else "relationship_targets"
            issues.append(_app_relation_issue(row, code, "missing" if not relation_values else "ambiguous", f"{row['kind']} {row['elementId']} 必须关联{expected}批内 APP；不允许默认或猜测关系。", check_id=check_id))
            _clear_inheritance(row, candidates, spec)
            continue
        seen: set[str] = set()
        sources: list[dict] = []
        valid = True
        row_workspace = _workspace(row)
        for external_id in relation_values:
            reference_key = unicodedata.normalize("NFKC", external_id).casefold()
            if reference_key in seen:
                issues.append(_app_relation_issue(row, "LOCAL.DUPLICATE_APP_REFERENCE", "ambiguous", f"{row['kind']} {row['elementId']} 重复引用 APP {external_id}；每个 APP 只能出现一次。"))
                valid = False
                continue
            seen.add(reference_key)
            app_matches = apps_by_id.get(reference_key, [])
            same_workspace = [app for app in app_matches if _workspace(app) == row_workspace]
            if len(same_workspace) == 1:
                sources.append(same_workspace[0])
                continue
            valid = False
            if len(same_workspace) > 1:
                issues.append(_app_relation_issue(row, "LOCAL.AMBIGUOUS_APP_REFERENCE", "ambiguous", f"{row['kind']} {row['elementId']} 对 APP {external_id} 的批内精确匹配不唯一。"))
            elif app_matches:
                issues.append(_app_relation_issue(row, "LOCAL.CROSS_WORKSPACE_APP_REFERENCE", "contract_mismatch", f"{row['kind']} {row['elementId']} 与 APP {external_id} 不在同一 Omnia 工作区。"))
            elif identities_by_id.get(reference_key):
                issues.append(_app_relation_issue(row, "LOCAL.NON_APP_REFERENCE", "contract_mismatch", f"{row['kind']} {row['elementId']} 的关联目标 {external_id} 不是 APP 类型。"))
            else:
                issues.append(_app_relation_issue(row, "UNSUPPORTED.EXTERNAL_APP_REFERENCE", "contract_mismatch", f"{row['kind']} {row['elementId']} 引用的 APP {external_id} 不在当前批次；未冻结外部目标前禁止准备回传。"))
        if not valid or len(sources) != len(relation_values) or spec.get("inheritRait") is not True:
            if spec.get("inheritRait") is True:
                _clear_inheritance(row, candidates, spec)
            continue
        modes = [str(source["fields"].get("System Risk Classification", "")) for source in sources]
        if any(mode not in ("Higher", "Lower") for mode in modes):
            issues.append(_issue("local", "LOCAL.RAIT_INHERITANCE_INVALID", f"{row['rowKey']}.inheritance", "conflict", "blocking", f"{row['kind']} {row['elementId']} 的关联 APP RAIT 必须全部为 Higher 或 Lower。", "infrastructure_rait"))
            valid = False
        if not valid:
            _clear_inheritance(row, candidates, spec)
            continue
        canonical_id = f"P1.{row['kind']}.GRA.RAIT_CONCLUSION"
        require(canonical_id in field_ids, "GOVERNANCE.INHERITANCE_FIELD_MISSING", f"{canonical_id} is absent from signed governance.")
        value = "Higher" if "Higher" in modes else "Lower"
        source_refs = [{"rowKey": source["rowKey"], "elementId": source["elementId"]} for source in sources]
        row["inheritance"] = {
            "schemaVersion": "omnia.create-associate.infrastructure-app-inheritance/v1",
            "rait": value,
            "sourceApps": source_refs,
            "relationType": policy["relationType"],
        }
        mixed_sources = len(set(modes)) > 1
        row["inheritanceDecision"] = {
            "schemaVersion": "omnia.create-associate.infrastructure-rait-decision/v1",
            "policy": "any_higher_else_all_lower",
            "sourceModes": [
                {"rowKey": source["rowKey"], "elementId": source["elementId"], "rait": mode}
                for source, mode in zip(sources, modes)
            ],
            "mixedSources": mixed_sources,
            "result": value,
            "message": "基础设施将按 Higher 优先设置为 Higher" if mixed_sources else f"基础设施将继承 {value}",
        }
        row["fields"]["Inherited System Risk Classification"] = value
        _sync_inheritance_candidate(row, candidates, canonical_id, value, source_refs, source_artifact_id)


def _clear_inheritance(row: dict, candidates: list[dict], spec: dict) -> None:
    if spec.get("inheritRait") is not True:
        return
    row["fields"].pop("Inherited System Risk Classification", None)
    row.pop("inheritance", None)
    row.pop("inheritanceDecision", None)
    canonical_id = f"P1.{row['kind']}.GRA.RAIT_CONCLUSION"
    existing = next((item for item in candidates if item.get("canonicalFieldId") == canonical_id and item.get("provenance", {}).get("rowKey") == row["rowKey"]), None)
    if existing and (existing.get("value") != "" or existing.get("status") != "needs_input"):
        existing["value"] = ""
        existing["status"] = "needs_input"
        existing["revision"] = int(existing.get("revision") or 0) + 1
        existing["provenance"].pop("sourceApps", None)


def _sync_inheritance_candidate(row: dict, candidates: list[dict], canonical_id: str, value: str, source_refs: list[dict], source_artifact_id: str) -> None:
    field_key = f"{row['rowKey']}.{canonical_id}"
    inheritance_identity = "|".join([row["rowKey"], *[source["rowKey"] for source in source_refs], value])
    trace = f"inheritance:{sha256_hex(inheritance_identity)}"
    existing = next((item for item in candidates if item.get("fieldKey") == field_key), None)
    if existing is None:
        existing = _candidate(field_key=field_key, raw_field_key="Inherited System Risk Classification", canonical_field_id=canonical_id, value=value, value_kind="inherited", status="accepted", source_artifact_id=source_artifact_id, source_sheet=row["sourceSheet"], source_row=row["sourceRow"], row_key=row["rowKey"], trace=trace, rule="planned_infrastructure_rait_from_app_edges:v1;remote_verification_required_before_return")
        candidates.append(existing)
    elif existing.get("value") != value or existing.get("status") != "accepted" or existing.get("provenance", {}).get("sourceApps") != source_refs:
        existing["value"] = value
        existing["status"] = "accepted"
        existing["revision"] = int(existing.get("revision") or 0) + 1
        existing["provenance"]["sourceTraceId"] = trace
    existing["provenance"]["sourceApps"] = source_refs


def _review_fields(parsed: dict, kind: str) -> tuple[dict, ...]:
    registry = parsed.get("kindRegistry")
    require(isinstance(registry, dict) and isinstance(registry.get(kind), dict), "GOVERNANCE.KIND_UNDECLARED", f"Element kind is not declared: {kind}.")
    fields = registry[kind].get("reviewFields")
    require(isinstance(fields, list) and fields, "GOVERNANCE.KIND_REVIEW_FIELDS_MISSING", f"Review fields are missing for {kind}.")
    return tuple(fields)


def _recompute_local_issues(parsed: dict) -> None:
    rows = parsed.get("rows", [])
    issues = [item for item in parsed.get("issues", []) if item.get("origin") == "parser"]
    namespace = str(parsed.get("issueNamespace") or "legacy")
    registry = parsed.get("kindRegistry") or {}
    by_row_raw: dict[tuple[str, str], dict] = {}
    for candidate in parsed.get("candidates", []):
        key = (str(candidate.get("provenance", {}).get("rowKey", "")), str(candidate.get("rawFieldKey", "")))
        by_row_raw.setdefault(key, candidate)

    def add(row: dict, code: str, field_key: str, issue_type: str, state: str, message: str, check_id: str) -> None:
        effective_key = field_key or f"{row.get('rowKey', 'global')}.{issue_type}"
        created = _issue("local", code, effective_key, issue_type, state, message, check_id)
        created["issueId"] = f"local-{sha256_hex(f'{namespace}|{code}|{effective_key}')[:48]}"
        issues.append(created)

    for row in rows:
        matrix = _review_fields(parsed, row["kind"])
        for field in matrix:
            raw, label = str(field.get("rawFieldKey") or ""), str(field.get("label") or "")
            required, maximum = bool(field.get("required")), int(field.get("maxLength") or 0)
            value = unicodedata.normalize("NFC", _js_string(row.get("fields", {}).get(raw, ""))).strip()
            candidate = by_row_raw.get((row["rowKey"], raw))
            field_key = str(candidate.get("fieldKey", "")) if candidate else ""
            if required and not value:
                add(row, "LOCAL.REQUIRED_FIELD", field_key or f"{row['rowKey']}.missing.{sha256_hex(raw)}", "missing", "needs_input", f"{row['kind']} {row['elementId']} 缺少必填字段 {label}。", "required_fields")
            if len(value) > maximum:
                add(row, "LOCAL.FIELD_TOO_LONG", field_key, "invalid_enum", "needs_input", f"{row['kind']} {row['elementId']} 的 {label} 超过 {maximum} 字符上限。", "valid_values")
            allowed = tuple(field.get("allowedValues") or ())
            if value and allowed and value not in allowed:
                add(row, "LOCAL.INVALID_ENUM", field_key, "invalid_enum", "needs_input", f"{row['kind']} {row['elementId']} 的 {label} 仅允许 {' / '.join(allowed)}。", "valid_values")
            if raw == str(matrix[0].get("rawFieldKey") or ""):
                row["elementId"] = value
                invalid_length = len(derive_gra_name(value)) > 200
                if _ILLEGAL_NAME.search(value) or (value and set(value) == {"."}) or invalid_length:
                    add(row, "LOCAL.ILLEGAL_ELEMENT_NAME", field_key, "invalid_enum", "needs_input", f"{row['kind']} 元素 ID 含非法字符，或派生 GRA 名超过 200 字符。", "valid_values")
                naming_message = suspicious_name_message(value)
                if naming_message:
                    add(row, "LOCAL.SUSPICIOUS_ELEMENT_NAME", field_key, "quality_warning", "waived", f"{row['kind']} {value}：{naming_message}", "valid_values")
    reserved_names: dict[str, tuple[dict, str]] = {}
    for row in rows:
        names = ((row["elementId"], "element"), (derive_gra_name(row["elementId"]), "gra"))
        for raw_name, role in names:
            normalized = unicodedata.normalize("NFKC", raw_name).casefold()
            previous = reserved_names.get(normalized)
            if previous:
                previous_row, previous_role = previous
                add(row, "LOCAL.DUPLICATE_IDENTITY", f"{row['rowKey']}.identity", "conflict", "blocking", f"{row['kind']} {row['elementId']} 的 {role} 名称与 {previous_row['kind']} {previous_row['elementId']} 的 {previous_role} 名称冲突。", "unique_names")
            elif normalized:
                reserved_names[normalized] = (row, role)
    derived_issues: list[dict] = []
    infrastructure_kinds = {kind for kind, spec in registry.items() if isinstance(spec, dict) and spec.get("inheritRait") is True}
    inheritance_field_ids = {f"P1.{kind}.GRA.RAIT_CONCLUSION" for kind in infrastructure_kinds}
    _resolve_app_relations(rows, parsed.get("candidates", []), derived_issues, inheritance_field_ids, registry, source_artifact_id=str(parsed.get("sourceArtifactId") or "review"))
    for derived in derived_issues:
        row_key = str(derived.get("fieldKey", "")).split(".", 1)[0]
        row = next((candidate for candidate in rows if candidate["rowKey"] == row_key), None)
        if row:
            add(row, str(derived["code"]), str(derived["fieldKey"]), str(derived["issueType"]), str(derived["state"]), str(derived["message"]), str(derived["checkId"]))
        else:
            issues.append(derived)
    parsed["issues"] = issues


def _declared_allowed_values(declaration: object) -> tuple[str, ...]:
    """Project display values from one signed field declaration.

    The governed workbook commonly stores a pipe-delimited label followed by a
    parenthesized explanation.  Only the display label is accepted as user
    input; values are never inferred from another APP family.
    """
    if not isinstance(declaration, dict):
        return ()
    raw = declaration.get("allowedValues") or declaration.get("enum")
    values = raw if isinstance(raw, (list, tuple)) else str(raw or "").split("|")
    projected: list[str] = []
    for candidate in values:
        label = re.split(r"[（(]", unicodedata.normalize("NFKC", str(candidate or "")), maxsplit=1)[0].strip()
        if label and label not in projected:
            projected.append(label)
    return tuple(projected)


def _js_string(value: Any) -> str:
    if value is None:
        return ""
    if value is True:
        return "true"
    if value is False:
        return "false"
    return str(value)


if __name__ == "__main__":
    from protocol import main

    main()
