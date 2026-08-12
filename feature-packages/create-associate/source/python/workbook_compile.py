"""Deterministic four-sheet runtime workbook compiler matching the Middle contract."""

from __future__ import annotations

import io
import math
import re
import unicodedata
import zipfile
from typing import Any

from canonical import semantic_digest, sha256_hex
from errors import EngineError, require
from ooxml import compile_parts, read_bounded, read_xlsx, read_zip_parts

SHEET_NAMES = ("处理结果", "执行计划", "来源追踪", "问题与支持矩阵")


def derive_gra_name(element_id: object) -> str:
    return f"GRA-{unicodedata.normalize('NFC', str(element_id or '')).strip()}"


def build_runtime_base(*, kind_registry: dict, metadata: dict) -> tuple[bytes, dict]:
    """Create the immutable four-sheet base used by the runtime patch compiler."""

    parsed = {"rows": [], "candidates": [], "issues": [], "kindRegistry": kind_registry}
    sheets = _runtime_sheets(parsed)
    workbook_sheets = "".join(f'<sheet name="{_xml(sheet[0])}" sheetId="{index}" r:id="rId{index}"/>' for index, sheet in enumerate(sheets, 1))
    relationships = "".join(f'<Relationship Id="rId{index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{index}.xml"/>' for index in range(1, len(sheets) + 1))
    overrides = "".join(f'<Override PartName="/xl/worksheets/sheet{index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for index in range(1, len(sheets) + 1))
    parts: dict[str, bytes] = {
        "[Content_Types].xml": f'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>{overrides}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>'.encode("utf-8"),
        "_rels/.rels": b'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
        "xl/workbook.xml": f'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr/><bookViews><workbookView/></bookViews><sheets>{workbook_sheets}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>'.encode("utf-8"),
        "xl/_rels/workbook.xml.rels": f'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{relationships}<Relationship Id="rId{len(sheets)+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'.encode("utf-8"),
        "xl/styles.xml": b'<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="10"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Aptos"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf xfId="0"/><xf xfId="0" fontId="1" fillId="2" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf><xf xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs></styleSheet>',
        "docProps/core.xml": f'<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Omnia Create Associate Run {_xml(metadata.get("runId", ""))}</dc:title><dc:subject>candidate; source={_xml(metadata.get("sourceArtifactId", ""))}; governance={_xml(metadata.get("governanceDigest", ""))}</dc:subject></cp:coreProperties>'.encode("utf-8"),
    }
    for index, (_name, headers, rows, options) in enumerate(sheets, 1):
        parts[f"xl/worksheets/sheet{index}.xml"] = _worksheet_xml(headers, rows, options).encode("utf-8")
    output = _deterministic_zip(parts)
    verified = read_zip_parts(output)
    _verify_output(output, verified, sheets)
    return output, {
        "schemaVersion": "omnia.create-associate.runtime-workbook-base/v1",
        "sizeBytes": len(output),
        "sha256": sha256_hex(output),
        "sheetNames": list(SHEET_NAMES),
    }


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
        spec = parsed.get("kindRegistry", {}).get(row["kind"], {})
        capabilities = spec.get("capabilities", {})
        row_blocked = blocked(row["rowKey"])
        supported = spec.get("returnSupport") == "supported"
        disposition = "blocked_missing_input" if row_blocked else "supported_after_preflight" if supported else str(spec.get("returnSupport") or "unsupported")
        if capabilities.get("object"):
            plan_rows.append([row["rowKey"], "it_element", row["kind"], row["elementId"], disposition, "object-type-aware exact identity/workspace/subtype preflight; create or exact reuse followed by mandatory readback"])
        if capabilities.get("gra"):
            plan_rows.append([row["rowKey"], "gra", row["kind"], derive_gra_name(row["elementId"]), disposition, "content/workspace/identity preflight"])
        if capabilities.get("settings") or capabilities.get("directRait") or capabilities.get("inheritedRait"):
            plan_rows.append([row["rowKey"], "field_diff", row["kind"], row["elementId"], disposition if not supported else "blocked_missing_input" if row_blocked else "conditional", "signed field Operation + readback"])
        for relation in row.get("relations", []) if capabilities.get("relation") else []:
            plan_rows.append([row["rowKey"], "element_relation", row["kind"], relation, disposition, "only an APP in this workbook or a separately implemented exact live reference may be used; external APP reference is disabled"])
        if capabilities.get("appScoring"):
            plan_rows.append([row["rowKey"], "app_scoring", row["kind"], row["elementId"], "blocked_missing_input" if row_blocked else "conditional", "one APP-generic governed scoring inventory; product content never selects another scoring engine"])
        if capabilities.get("riskControl"):
            plan_rows.append([row["rowKey"], "risk_control_multiset", row["kind"], row["elementId"], "blocked_missing_input" if row_blocked else "conditional", "governance family + live catalog exact multiset"])
        if not supported:
            plan_rows.append([row["rowKey"], "return_gate", row["kind"], row["elementId"], disposition, "no Operation query or mutation intent is permitted"])
    trace_rows = [[
        field["provenance"]["sourceArtifactId"], field["provenance"]["sourceSheet"], field["provenance"]["sourceRow"], field["provenance"]["rowKey"],
        field["fieldKey"], field.get("canonicalFieldId", ""), field.get("revision", 1), field.get("valueKind", ""), field.get("value", ""), field.get("status", ""),
        field["provenance"].get("sourceTraceId", ""), field["provenance"].get("derivationRule", ""),
    ] for field in parsed.get("candidates", [])]
    issue_rows: list[list[Any]] = [[item.get("issueId", ""), item.get("issueType", ""), item.get("state", ""), item.get("fieldKey", ""), item.get("message", "")] for item in issues]
    issue_rows.insert(0, ["SUMMARY", "行数", "calculated", "parsedRows", {"formula": f"COUNTA('处理结果'!A2:A{len(result_rows) + 1})"}])
    for kind, spec in sorted(parsed.get("kindRegistry", {}).items()):
        policy = spec.get("relationPolicy") or {}
        issue_rows.append([f"SUPPORT.kind.{kind.lower()}", "support", spec.get("returnSupport", "unsupported"), kind,
            f"object={bool(spec.get('capabilities', {}).get('object'))}; gra={bool(spec.get('capabilities', {}).get('gra'))}; relation={policy.get('relationType') or 'N/A'}; scoring={bool(spec.get('capabilities', {}).get('appScoring'))}; risk-control={bool(spec.get('capabilities', {}).get('riskControl'))}"])
        for pending in spec.get("pendingRecordingContentValues") or []:
            if not isinstance(pending, dict):
                continue
            input_value = str(pending.get("inputValue") or "")
            expected = str(pending.get("expectedOmniaContentName") or "")
            issue_rows.append([f"SUPPORT.pending_recording.{kind.lower()}.{input_value}", "support", "blocked_pending_recording", kind,
                f"V5 accepts {input_value}; exact Omnia content={expected or 'pending'}; recording evidence is required before Return."])
    issue_rows.extend([
        ["SUPPORT.existing_reuse", "support", "supported_after_preflight", "existing exact reuse", "APP/Infrastructure/Tool may reuse an exact unique live object only with current binding-scoped Agent ownership proof."],
        ["SUPPORT.external_app_reference", "support", "blocked_not_implemented", "external APP reference", "External APP exact preflight plus verified RAIT readback is not implemented; reference is disabled."],
        ["SUPPORT.gra", "support", "supported_after_preflight", "gra", "Signed exact create/reconcile Operation; requires live content identity."],
        ["SUPPORT.field_diff", "support", "conditional", "field_diff", "Only fields with signed Operations and readback may execute."],
        ["SUPPORT.element_relation", "support", "supported_after_preflight", "element_relation", "DB/OS/DCNO use InfrastructureApplication and Tool uses ItToolApplication from the signed registry; DCNO Higher/Lower share the exact catalog while retaining mode-specific link rules."],
        ["SUPPORT.risk_control", "support", "conditional", "risk_control", "Governance multiset plus live catalog/hidden-data validation required."],
        ["SUPPORT.not_applicable", "support", "supported_after_preflight", "explicit_n_a", "A generated Risk with zero required Control links in the selected RAIT mode is explicitly patched to ClassificationNA and verified."],
        ["SUPPORT.production_return", "support", "pending_canary", "return", "In-feature explicit confirmation and exact authority canary remain mandatory."],
    ])
    return [
        (SHEET_NAMES[0], ["rowKey", "类型", "元素ID", "工作区", "类别/RAIT", "关联APP", "状态"], result_rows, {"validation": f"G2:G{max(2, len(result_rows) + 1)}", "columnWidths": [36, 12, 24, 20, 18, 24, 28], "maxRowHeight": 72}),
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


def _deterministic_zip(parts: dict[str, bytes]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9, strict_timestamps=True) as archive:
        for name in sorted(parts):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            info.create_system = 3
            archive.writestr(info, parts[name], compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    result = output.getvalue()
    require(len(result) <= 64 * 1024 * 1024, "COMPILE.OUTPUT_SIZE_EXCEEDED", "Compiled workbook exceeds 64 MiB.")
    return result


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
