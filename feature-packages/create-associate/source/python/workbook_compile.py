"""Deterministic four-sheet runtime workbook compiler matching the Middle contract."""

from __future__ import annotations

import math
import re
import unicodedata
from typing import Any

from canonical import semantic_digest, sha256_hex
from errors import EngineError, require
from ooxml import compile_parts, read_bounded, read_xlsx, read_zip_parts

SHEET_NAMES = ("处理结果", "执行计划", "来源追踪", "问题与支持矩阵")


def derive_gra_name(element_id: object) -> str:
    return f"GRA-{unicodedata.normalize('NFC', str(element_id or '')).strip()}"


def compile_runtime_workbook(base: object, *, parsed: dict, metadata: dict) -> tuple[bytes, dict]:
    base_bytes = read_bounded(base)
    original = read_zip_parts(base_bytes)
    base_workbook = read_xlsx(base_bytes, allow_formula_cache=True)
    require(tuple(sheet.name for sheet in base_workbook.sheets) == SHEET_NAMES, "OUTPUT.BASE_STRUCTURE_INVALID", "Signed runtime-template base workbook sheet contract drifted.")
    sheets = _runtime_sheets(parsed)
    generated_sheets = {f"xl/worksheets/sheet{index}.xml": _worksheet_xml(headers, rows, options).encode("utf-8") for index, (_name, headers, rows, options) in enumerate(sheets, 1)}
    core = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">'
        f'<dc:title>Omnia Create Associate Run {_xml(metadata.get("runId", ""))}</dc:title>'
        f'<dc:subject>candidate; source={_xml(metadata.get("sourceArtifactId", ""))}; governance={_xml(metadata.get("governanceDigest", ""))}</dc:subject>'
        '</cp:coreProperties>'
    ).encode("utf-8")
    mutations = {"docProps/core.xml": core, **generated_sheets}
    for name in mutations:
        require(name in original, "OUTPUT.BASE_PART_MISSING", f"Signed runtime-template base part is missing: {name}.")
    output = compile_parts(base_bytes, mutations)
    compiled = read_zip_parts(output)
    _verify_output(output, compiled, sheets)
    base_digest = sha256_hex(base_bytes)
    patch_payload = {
        "mutableParts": list(mutations), "rows": parsed.get("rows", []), "candidates": parsed.get("candidates", []), "issues": parsed.get("issues", []),
        "metadata": {"sourceArtifactId": metadata.get("sourceArtifactId", ""), "governanceDigest": metadata.get("governanceDigest", ""), "baseDigest": base_digest},
    }
    semantic_payload = {
        "rows": parsed.get("rows", []), "candidates": parsed.get("candidates", []), "issues": parsed.get("issues", []),
        "sourceArtifactId": metadata.get("sourceArtifactId", ""), "governanceDigest": metadata.get("governanceDigest", ""), "baseDigest": base_digest,
    }
    descriptor = {
        "schemaVersion": "omnia.create-associate.compiled-workbook/v1", "sizeBytes": len(output), "sha256": sha256_hex(output),
        "baseDigest": base_digest, "patchDigest": semantic_digest(patch_payload), "semanticDigest": semantic_digest(semantic_payload),
        "declaredParts": list(mutations), "unchangedPartCount": len(original) - len(mutations), "sheetNames": list(SHEET_NAMES),
    }
    return output, descriptor


def _runtime_sheets(parsed: dict) -> list[tuple[str, list[str], list[list[Any]], dict]]:
    issues = parsed.get("issues", [])
    def blocked(row_key: str) -> bool:
        return any(str(item.get("fieldKey", "")).startswith(row_key) and item.get("state") in ("needs_input", "blocking") for item in issues)
    result_rows = [[
        row["rowKey"], row["kind"], row["elementId"], row.get("fields", {}).get("Omnia工作区", ""),
        row.get("fields", {}).get("System Risk Classification") or row.get("fields", {}).get("Inherited System Risk Classification", ""),
        "、".join(row.get("relations", [])), "needs_input" if blocked(row["rowKey"]) else "accepted",
    ] for row in parsed.get("rows", [])]
    plan_rows: list[list[Any]] = []
    for row in parsed.get("rows", []):
        row_blocked = blocked(row["rowKey"])
        disposition = "blocked_missing_input" if row_blocked else "supported_after_preflight"
        plan_rows.extend([
            [row["rowKey"], "it_element", row["kind"], row["elementId"], disposition, "object-type-aware exact identity/workspace/subtype preflight; create or exact reuse followed by mandatory readback"],
            [row["rowKey"], "gra", row["kind"], derive_gra_name(row["elementId"]), disposition, "content/workspace/identity preflight"],
            [row["rowKey"], "field_diff", row["kind"], row["elementId"], "blocked_missing_input" if row_blocked else "conditional", "signed field Operation + readback"],
        ])
        for relation in row.get("relations", []):
            plan_rows.append([row["rowKey"], "element_relation", row["kind"], relation, disposition, "only an APP in this workbook or a separately implemented exact live reference may be used; external APP reference is disabled"])
        plan_rows.append([row["rowKey"], "risk_control_multiset", row["kind"], row["elementId"], "blocked_missing_input" if row_blocked else "conditional", "governance IR + live catalog exact multiset"])
    trace_rows = [[
        field["provenance"]["sourceArtifactId"], field["provenance"]["sourceSheet"], field["provenance"]["sourceRow"], field["provenance"]["rowKey"],
        field["fieldKey"], field.get("canonicalFieldId", ""), field.get("revision", 1), field.get("valueKind", ""), field.get("value", ""), field.get("status", ""),
        field["provenance"].get("sourceTraceId", ""), field["provenance"].get("derivationRule", ""),
    ] for field in parsed.get("candidates", [])]
    issue_rows: list[list[Any]] = [[item.get("issueId", ""), item.get("issueType", ""), item.get("state", ""), item.get("fieldKey", ""), item.get("message", "")] for item in issues]
    issue_rows.insert(0, ["SUMMARY", "行数", "calculated", "parsedRows", {"formula": f"COUNTA('处理结果'!A2:A{len(result_rows) + 1})"}])
    issue_rows.extend([
        ["SUPPORT.app_create", "support", "supported_after_preflight", "APP create", "Signed exact create-only permit, mutation and mandatory authority readback."],
        ["SUPPORT.existing_reuse", "support", "supported_after_preflight", "existing exact reuse", "APP/DB/OS/Tool may reuse an exact unique live object after Workspace/type identity readback."],
        ["SUPPORT.db_os_tool_create", "support", "supported_after_preflight", "DB/OS/Tool create", "The object-type-aware create-only preflight repeats the live exact search; creation uses the recorded DB=Database, OS=OperatingSystem, Tool=Tool subtype contract and mandatory read-back."],
        ["SUPPORT.external_app_reference", "support", "blocked_not_implemented", "external APP reference", "External APP exact preflight plus verified RAIT readback is not implemented; reference is disabled."],
        ["SUPPORT.gra", "support", "supported_after_preflight", "gra", "Signed exact create/reconcile Operation; requires live content identity."],
        ["SUPPORT.field_diff", "support", "conditional", "field_diff", "Only fields with signed Operations and readback may execute."],
        ["SUPPORT.element_relation.db_os_to_app", "support", "supported_after_preflight", "element_relation", "DB/OS 关联系统ID -> in-workbook APP；执行 InfrastructureApplication 精确双向读回合同。"],
        ["SUPPORT.element_relation.tool", "support", "not_applicable_no_input_contract", "element_relation", "The current user template has no Tool relation field; Tool object/GRA/RAIT Return is supported without fabricating a relationship."],
        ["SUPPORT.risk_control", "support", "conditional", "risk_control", "Governance multiset plus live catalog/hidden-data validation required."],
        ["SUPPORT.not_applicable", "support", "not_applicable", "explicit_n_a", "Governance-declared N/A operations are omitted, never synthesized."],
        ["SUPPORT.production_return", "support", "pending_canary", "return", "In-feature explicit confirmation and exact authority canary remain mandatory."],
    ])
    return [
        (SHEET_NAMES[0], ["rowKey", "类型", "元素ID", "工作区", "RAIT", "关联APP", "状态"], result_rows, {"validation": f"G2:G{max(2, len(result_rows) + 1)}", "columnWidths": [36, 12, 24, 20, 14, 24, 20], "maxRowHeight": 72}),
        (SHEET_NAMES[1], ["rowKey", "operationKind", "对象类型", "目标身份", "disposition", "门禁"], plan_rows, {"columnWidths": [36, 22, 14, 26, 26, 48], "maxRowHeight": 90}),
        (SHEET_NAMES[2], ["sourceArtifactId", "sourceSheet", "sourceRow", "rowKey", "fieldKey", "canonicalFieldId", "revision", "valueKind", "value", "status", "sourceTraceId", "derivationRule"], trace_rows, {"columnWidths": [22, 14, 8, 26, 28, 22, 8, 12, 18, 12, 26, 30], "fitToWidth": 2, "fitToHeight": 1, "maxRowHeight": 110}),
        (SHEET_NAMES[3], ["issueId", "issueType", "state", "fieldKey", "message"], issue_rows, {"columnWidths": [34, 20, 26, 28, 64], "maxRowHeight": 110}),
    ]


def _worksheet_xml(headers: list[str], rows: list[list[Any]], options: dict) -> str:
    widths = options.get("columnWidths") or [34 if index == 0 else 24 for index in range(len(headers))]
    require(len(widths) == len(headers) and all(isinstance(width, (int, float)) and math.isfinite(width) and width >= 6 for width in widths), "OUTPUT.LAYOUT_INVALID", "Runtime workbook column layout is incomplete.")
    def cell(value: Any, row: int, column: int, style: int) -> str:
        ref = f"{_column_name(column)}{row}"
        if isinstance(value, dict) and value.get("formula"):
            return f'<c r="{ref}" s="{style}"><f>{_xml(value["formula"])}</f><v>0</v></c>'
        return f'<c r="{ref}" s="{style}" t="inlineStr"><is><t xml:space="preserve">{_xml(_js_string(value))}</t></is></c>'
    data = []
    for index, values in enumerate([headers, *rows], 1):
        height = _row_height(values, widths, options, index == 1)
        cells = "".join(cell(value, index, column, 1 if index == 1 else 2) for column, value in enumerate(values, 1))
        data.append(f'<row r="{index}" ht="{height:.2f}" customHeight="1">{cells}</row>')
    last = _column_name(len(headers))
    validation = f'<dataValidations count="1"><dataValidation type="list" allowBlank="0" sqref="{options["validation"]}"><formula1>&quot;accepted,needs_input,blocked&quot;</formula1></dataValidation></dataValidations>' if options.get("validation") else ""
    columns = "".join(f'<col min="{index}" max="{index}" width="{float(width):.2f}" customWidth="1"/>' for index, width in enumerate(widths, 1))
    return f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1" autoPageBreaks="1"/></sheetPr><dimension ref="A1:{last}{len(rows)+1}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>{columns}</cols><sheetData>{"".join(data)}</sheetData><autoFilter ref="A1:{last}{len(rows)+1}"/>{validation}<sheetProtection sheet="1" objects="1" scenarios="1"/><printOptions horizontalCentered="1"/><pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" pageOrder="overThenDown" fitToWidth="{int(options.get("fitToWidth",1))}" fitToHeight="{int(options.get("fitToHeight",0))}"/></worksheet>'


def _verify_output(output: bytes, parts: dict[str, bytes], sheets: list[tuple]) -> None:
    workbook = read_xlsx(output, allow_formula_cache=True)
    require(tuple(sheet.name for sheet in workbook.sheets) == SHEET_NAMES, "OUTPUT.STRUCTURE_INVALID", "Runtime workbook sheet contract drifted.")
    xmls = [parts[f"xl/worksheets/sheet{index}.xml"].decode("utf-8") for index in range(1, 5)]
    for source in xmls:
        require(len(re.findall(r"<row\b", source)) == len(re.findall(r'<row\b[^>]*\bht="[0-9.]+"[^>]*\bcustomHeight="1"', source)), "OUTPUT.LAYOUT_INVALID", "Every populated runtime workbook row must have a deterministic custom height.")
    require(re.search(r'fitToWidth="2"[^>]*fitToHeight="1"', xmls[2]) is not None and 'pageOrder="overThenDown"' in xmls[2] and len(re.findall(r"<col\b", xmls[2])) == 12, "OUTPUT.LAYOUT_INVALID", "Source trace print layout is incomplete.")
    combined = "".join(value.decode("utf-8", errors="ignore") for name, value in parts.items() if name.endswith(".xml"))
    require("<f>" in combined and "<dataValidations" in combined and "<sheetProtection" in combined, "OUTPUT.VALIDATION_INVALID", "Runtime workbook formula/enum/protection contract is incomplete.")


def _row_height(values: list[Any], widths: list[float], options: dict, header: bool) -> float:
    if header:
        return float(options.get("headerRowHeight", 26))
    maximum = 1
    for value, width in zip(values, widths):
        text = "0" if isinstance(value, dict) and value.get("formula") else _js_string(value)
        capacity = max(6, math.floor(float(width) - 2))
        lines = sum(max(1, math.ceil(sum(2 if ord(char) > 255 else 1 for char in line) / capacity)) for line in re.split(r"\r?\n", text))
        maximum = max(maximum, lines)
    estimated = 5 + maximum * float(options.get("lineHeight", 14.25))
    return min(float(options.get("maxRowHeight", 96)), max(float(options.get("minRowHeight", 22)), estimated))


def _column_name(index: int) -> str:
    name = ""
    while index > 0:
        index, remainder = divmod(index - 1, 26)
        name = chr(65 + remainder) + name
    return name


def _js_string(value: Any) -> str:
    if value is None:
        return ""
    if value is True:
        return "true"
    if value is False:
        return "false"
    return str(value)


def _xml(value: Any) -> str:
    return _js_string(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
