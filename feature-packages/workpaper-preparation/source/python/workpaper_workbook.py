"""Deterministic Phase 2 workpaper workbook generator and parser.

Pure standard-library XLSX/OOXML bytes. The field contract (headers) is passed
in by the worker; this module only turns structured rows into a bounded XLSX
container and parses one back, so no Phase 2 business rules live here.
"""

from __future__ import annotations

import base64
import io
import json
import zipfile
from typing import Any

from canonical import semantic_digest, sha256_hex
from errors import EngineError, require
from ooxml import read_xlsx

WORKBOOK_SCHEMA = "omnia.workpaper-phase2-workbook/v1"
MAX_ROWS = 2000
MAX_HEADERS = 64
MAX_CELL_CHARS = 32767

_NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_NS_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
_NS_DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_NS_CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types"


def _xml(value: Any) -> str:
    return str(value if value is not None else "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _col_name(index: int) -> str:
    name = ""
    while index > 0:
        index, remainder = divmod(index - 1, 26)
        name = chr(65 + remainder) + name
    return name


def _cell(ref: str, value: Any, style: int) -> str:
    text = "" if value is None else (str(value) if not isinstance(value, bool) else ("true" if value else "false"))
    require(len(text) <= MAX_CELL_CHARS, "WORKBOOK.CELL_TOO_LONG", f"Cell {ref} exceeds {MAX_CELL_CHARS} characters.")
    return f'<c r="{ref}" s="{style}" t="inlineStr"><is><t xml:space="preserve">{_xml(text)}</t></is></c>'


def _worksheet_xml(headers: list[str], rows: list[list[Any]], *, hidden: bool) -> str:
    require(len(headers) <= MAX_HEADERS, "WORKBOOK.HEADERS_TOO_MANY", "Workbook header count exceeds the signed bound.")
    widths = [34 if index == 0 else 24 for index in range(len(headers))]
    data: list[str] = []
    for index, values in enumerate([headers, *rows], 1):
        cells = "".join(_cell(f"{_col_name(column)}{index}", value, 1 if index == 1 else 2) for column, value in enumerate(values, 1))
        data.append(f'<row r="{index}" ht="22" customHeight="1">{cells}</row>')
    last = _col_name(len(headers))
    columns = "".join(f'<col min="{index}" max="{index}" width="{float(width):.2f}" customWidth="1"/>' for index, width in enumerate(widths, 1))
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<worksheet xmlns="{_NS_MAIN}"><sheetPr><pageSetUpPr fitToPage="1" autoPageBreaks="1"/></sheetPr>'
        f'<dimension ref="A1:{last}{len(rows) + 1}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
        f'<sheetFormatPr defaultRowHeight="15"/><cols>{columns}</cols><sheetData>{"".join(data)}</sheetData>'
        f'<sheetProtection sheet="1" objects="1" scenarios="1"/>'
        f'<autoFilter ref="A1:{last}{len(rows) + 1}"/>'
        f'<pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>'
        f'<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>'
    ) if not hidden else (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<worksheet xmlns="{_NS_MAIN}"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'
        f'<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>'
        f'<sheetFormatPr defaultRowHeight="15"/><sheetData>{"".join(data)}</sheetData></worksheet>'
    )


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
    require(len(result) <= 64 * 1024 * 1024, "WORKBOOK.OUTPUT_SIZE_EXCEEDED", "Generated workpaper workbook exceeds 64 MiB.")
    return result


def _container_parts(sheet_count: int, sheet_names: list[str], active_tab: int = 0, hidden_sheets: tuple[int, ...] = ()) -> dict[str, bytes]:
    hidden = set(hidden_sheets)
    workbook_sheets = "".join(
        f'<sheet name="{_xml(name)}" sheetId="{index}" state="hidden" r:id="rId{index}"/>' if index in hidden
        else f'<sheet name="{_xml(name)}" sheetId="{index}" r:id="rId{index}"/>'
        for index, name in enumerate(sheet_names, 1)
    )
    relationships = "".join(f'<Relationship Id="rId{index}" Type="{_NS_DOC_REL}/worksheet" Target="worksheets/sheet{index}.xml"/>' for index in range(1, sheet_count + 1))
    overrides = "".join(f'<Override PartName="/xl/worksheets/sheet{index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for index in range(1, sheet_count + 1))
    return {
        "[Content_Types].xml": (
            f'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="{_NS_CONTENT_TYPES}">'
            f'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            f'<Default Extension="xml" ContentType="application/xml"/>'
            f'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            f'<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            f'{overrides}'
            f'<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
            f'</Types>'
        ).encode("utf-8"),
        "_rels/.rels": (
            f'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{_NS_REL}">'
            f'<Relationship Id="rId1" Type="{_NS_DOC_REL}/officeDocument" Target="xl/workbook.xml"/>'
            f'<Relationship Id="rId2" Type="{_NS_REL}/metadata/core-properties" Target="docProps/core.xml"/>'
            f'</Relationships>'
        ).encode("utf-8"),
        "xl/workbook.xml": (
            f'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="{_NS_MAIN}" xmlns:r="{_NS_DOC_REL}"><workbookPr/><bookViews><workbookView activeTab="{active_tab}"/></bookViews><sheets>{workbook_sheets}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>'
        ).encode("utf-8"),
        "xl/_rels/workbook.xml.rels": (
            f'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{_NS_REL}">{relationships}<Relationship Id="rId{sheet_count + 1}" Type="{_NS_DOC_REL}/styles" Target="styles.xml"/></Relationships>'
        ).encode("utf-8"),
        "xl/styles.xml": (
            '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="' + _NS_MAIN + '">'
            '<fonts count="2"><font><sz val="10"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Aptos"/></font></fonts>'
            '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill></fills>'
            '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs>'
            '<cellXfs count="3"><xf xfId="0"/><xf xfId="0" fontId="1" fillId="2" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf><xf xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs>'
            '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
        ).encode("utf-8"),
        "docProps/core.xml": (
            '<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Omnia Workpaper Phase 2</dc:title></cp:coreProperties>'
        ).encode("utf-8"),
    }


def build_phase2_workbook(payload: Any) -> dict[str, Any]:
    """Generate a workpaper workbook from structured headers/rows/scope.

    Expected payload keys: headers (list[str]), rows (list[list]), scope (dict).
    """
    require(isinstance(payload, dict) and payload.get("schemaVersion") == WORKBOOK_SCHEMA, "WORKBOOK.INPUT_INVALID", "Workbook build input schema is invalid.")
    headers = payload.get("headers")
    rows = payload.get("rows")
    scope = payload.get("scope")
    require(isinstance(headers, list) and 0 < len(headers) <= MAX_HEADERS, "WORKBOOK.HEADERS_INVALID", "Workbook headers are invalid.")
    require(all(isinstance(h, str) and h.strip() for h in headers), "WORKBOOK.HEADERS_INVALID", "Workbook headers must be non-empty strings.")
    require(isinstance(rows, list) and len(rows) <= MAX_ROWS, "WORKBOOK.ROWS_INVALID", "Workbook rows exceed the signed bound.")
    require(all(isinstance(r, list) and len(r) == len(headers) for r in rows), "WORKBOOK.ROWS_INVALID", "Workbook row shape does not match headers.")
    require(isinstance(scope, dict), "WORKBOOK.SCOPE_INVALID", "Workbook scope is invalid.")
    for row in rows:
        for value in row:
            require(value is None or isinstance(value, (str, int, float, bool)), "WORKBOOK.CELL_TYPE_INVALID", "Workbook cells must be scalar.")

    # Visible Controls sheet (headers + one row per Control).
    controls_xml = _worksheet_xml(headers, [[_cell_text(v) for v in row] for row in rows], hidden=False)
    # Hidden Scope sheet: one row per scope entry (key/value), carrying the
    # frozen four-tuple identity and the generation-input digest for tamper
    # detection on re-upload.
    scope_headers = ["key", "value"]
    scope_rows = [[key, json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value] for key, value in scope.items()]
    scope_xml = _worksheet_xml(scope_headers, scope_rows, hidden=True)

    sheet_names = ["Controls", "Scope"]
    parts = _container_parts(2, sheet_names, active_tab=0, hidden_sheets=(2,))
    parts["xl/worksheets/sheet1.xml"] = controls_xml.encode("utf-8")
    parts["xl/worksheets/sheet2.xml"] = scope_xml.encode("utf-8")
    output = _deterministic_zip(parts)

    # Verify the generated container is readable and round-trips the header row.
    workbook = read_xlsx(output, allow_formula_cache=True)
    require(tuple(sheet.name for sheet in workbook.sheets) == ("Controls", "Scope"), "WORKBOOK.ROUNDTRIP_STRUCTURE", "Generated workbook sheet contract drifted.")
    require(workbook.sheets[0].rows.get(1, []) == headers, "WORKBOOK.ROUNDTRIP_HEADERS", "Generated workbook header row drifted.")

    return {
        "schemaVersion": "omnia.workpaper-phase2-workbook-result/v1",
        "xlsxBase64": base64.b64encode(output).decode("ascii"),
        "sizeBytes": len(output),
        "sha256": sha256_hex(output),
        "semanticDigest": semantic_digest({"headers": headers, "rows": rows, "scope": scope}),
        "sheetNames": sheet_names,
        "rowCount": len(rows),
    }


def parse_uploaded_workbook(payload: Any) -> dict[str, Any]:
    """Parse an uploaded workpaper workbook back into headers/rows/scope.

    Expected payload keys: xlsxBase64, expectedHeaders, expectedScopeKeys.
    """
    require(isinstance(payload, dict) and payload.get("schemaVersion") == WORKBOOK_SCHEMA, "WORKBOOK.INPUT_INVALID", "Workbook parse input schema is invalid.")
    encoded = payload.get("xlsxBase64")
    require(isinstance(encoded, str) and encoded, "WORKBOOK.XLSX_REQUIRED", "Uploaded workbook bytes are required.")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as exc:
        raise EngineError("WORKBOOK.XLSX_BASE64_INVALID", "Uploaded workbook is not valid base64.") from exc

    workbook = read_xlsx(raw, allow_formula_cache=False)
    require(tuple(sheet.name for sheet in workbook.sheets) == ("Controls", "Scope"), "WORKBOOK.ROUNDTRIP_STRUCTURE", "Uploaded workbook sheet contract drifted.")

    controls = workbook.sheets[0]
    expected_headers = payload.get("expectedHeaders")
    require(isinstance(expected_headers, list) and expected_headers, "WORKBOOK.HEADERS_INVALID", "Expected headers are required for matching.")
    actual_headers = controls.rows.get(1, [])
    require(actual_headers == list(expected_headers), "WORKBOOK.HEADERS_DRIFT", "Uploaded workbook headers drifted from the frozen contract.")

    rows = [controls.rows[row_number] for row_number in sorted(r for r in controls.rows if r > 1)]
    require(len(rows) <= MAX_ROWS, "WORKBOOK.ROWS_INVALID", "Uploaded workbook rows exceed the signed bound.")

    scope_sheet = workbook.sheets[1]
    scope: dict[str, str] = {}
    for row_number in sorted(r for r in scope_sheet.rows if r > 1):
        values = scope_sheet.rows[row_number]
        if len(values) >= 2 and values[0]:
            scope[values[0]] = values[1]

    return {
        "schemaVersion": "omnia.workpaper-phase2-workbook-parse-result/v1",
        "headers": actual_headers,
        "rows": rows,
        "scope": scope,
        "rowCount": len(rows),
    }


def build_phase2_template(payload: Any) -> dict[str, Any]:
    """Generate the v4-semantics Phase 2 pre-filled template.

    One sheet only: 替换字段 (placeholder directory; the user fills the E
    column). The directory and control-point text are Feature business data
    carried in the payload.
    """
    require(isinstance(payload, dict) and payload.get("schemaVersion") == WORKBOOK_SCHEMA, "WORKBOOK.INPUT_INVALID", "Template build input schema is invalid.")
    systems = payload.get("systems")
    directory = payload.get("directory")
    scope = payload.get("scope")
    require(isinstance(systems, list) and 0 < len(systems) <= 50, "WORKBOOK.SYSTEMS_INVALID", "Template requires 1..50 APP systems.")
    require(all(isinstance(s, str) and s.strip() for s in systems), "WORKBOOK.SYSTEMS_INVALID", "Template APP system names must be non-empty.")
    require(isinstance(directory, list) and directory, "WORKBOOK.DIRECTORY_INVALID", "Template placeholder directory is empty.")
    require(isinstance(scope, dict), "WORKBOOK.SCOPE_INVALID", "Template scope is invalid.")

    # 替换字段 sheet: placeholder directory per system. Columns match v4:
    # 编号 / 系统 / 测试点 / 替换项目 / 替换内容(E列用户填) / 替换内容示例.
    repl_headers = ["编号", "系统", "测试点", "替换项目", "替换内容", "替换内容示例"]
    repl_rows: list[list[Any]] = [["请仅填写 E 列绿色单元格；无法确认的内容可以留空。", "", "", "", "", ""]]
    for system in systems:
        for item in directory:
            repl_rows.append([item.get("code", ""), system, item.get("controlPoint", ""),
                              item.get("placeholder", ""), "", item.get("example", "")])

    sheet_names = ["替换字段"]
    parts = _container_parts(1, sheet_names, active_tab=0, hidden_sheets=())
    parts["xl/worksheets/sheet1.xml"] = _worksheet_xml(repl_headers, repl_rows, hidden=False).encode("utf-8")

    output = _deterministic_zip(parts)
    workbook = read_xlsx(output, allow_formula_cache=True)
    require(tuple(sheet.name for sheet in workbook.sheets) == tuple(sheet_names), "WORKBOOK.ROUNDTRIP_STRUCTURE", "Generated template sheet contract drifted.")
    require(workbook.sheets[0].rows.get(1, []) == list(repl_headers), "WORKBOOK.ROUNDTRIP_HEADERS", "Generated template replacement headers drifted.")

    return {
        "schemaVersion": "omnia.workpaper-phase2-template-result/v1",
        "xlsxBase64": base64.b64encode(output).decode("ascii"),
        "sizeBytes": len(output),
        "sha256": sha256_hex(output),
        "semanticDigest": semantic_digest({"systems": systems, "directory": directory, "scope": scope}),
        "sheetNames": sheet_names,
        "applicationCount": len(systems),
        "replacementRowCount": len(repl_rows),
    }


def _cell_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


REPLACEMENT_INPUT_SCHEMA = "omnia.workpaper-replacement-input/v1"
REPLACEMENT_OUTPUT_SCHEMA = "omnia.workpaper-replacement/v1"
_REPLACEMENT_SHEET_NAMES = ("替换字段",)
_REPLACEMENT_HEADERS = ("编号", "系统", "测试点", "替换项目", "替换内容", "替换内容示例")
_REPLACEMENT_VALUE_COLUMN = 4  # E column (0-based): 替换内容


def apply_replacement_fields(payload: Any) -> dict[str, Any]:
    """Parse the user-filled pre-filled template back into replacement values.

    Reads the single 替换字段 sheet's E column (替换内容) plus its row identity
    (编号 / 系统 / 测试点 / 替换项目). Rows with an empty value are skipped. The
    locked system list is derived from the non-empty 系统 column so the worker
    can prove the uploaded template still matches the frozen system scope.
    """
    require(isinstance(payload, dict) and payload.get("schemaVersion") == REPLACEMENT_INPUT_SCHEMA,
            "WORKBOOK.INPUT_INVALID", "Replacement input schema is invalid.")
    encoded = payload.get("xlsxBase64")
    require(isinstance(encoded, str) and encoded, "WORKBOOK.XLSX_REQUIRED", "Uploaded workbook bytes are required.")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as exc:
        raise EngineError("WORKBOOK.XLSX_BASE64_INVALID", "Uploaded workbook is not valid base64.") from exc

    workbook = read_xlsx(raw, allow_formula_cache=False)
    require(tuple(sheet.name for sheet in workbook.sheets) == _REPLACEMENT_SHEET_NAMES,
            "WORKBOOK.ROUNDTRIP_STRUCTURE", "Uploaded template sheet contract drifted.")

    replacement_sheet = workbook.sheets[0]
    actual_headers = replacement_sheet.rows.get(1, [])
    require(actual_headers == list(_REPLACEMENT_HEADERS),
            "WORKBOOK.HEADERS_DRIFT", "Uploaded template replacement headers drifted.")
    replacements: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    systems: list[str] = []
    seen_systems: set[str] = set()
    for row_number in sorted(r for r in replacement_sheet.rows if r > 1):
        values = replacement_sheet.rows[row_number]
        while len(values) <= _REPLACEMENT_VALUE_COLUMN:
            values.append("")
        code = str(values[0] or "").strip()
        system = str(values[1] or "").strip()
        control_point = str(values[2] or "").strip()
        placeholder = str(values[3] or "").strip()
        value = str(values[_REPLACEMENT_VALUE_COLUMN] or "").strip()
        if not code and not system and not placeholder and not value:
            continue  # the instruction row (请仅填写 E 列绿色单元格…)
        if system and system not in seen_systems:
            seen_systems.add(system)
            systems.append(system)
        if not value:
            continue
        key = (system, code)
        require(key not in seen, "WORKBOOK.REPLACEMENT_DUPLICATE", f"Uploaded replacement duplicates {system} / {code}.")
        seen.add(key)
        replacements.append({"system": system, "code": code, "controlPoint": control_point,
                             "placeholder": placeholder, "value": value})

    return {
        "schemaVersion": REPLACEMENT_OUTPUT_SCHEMA,
        "systems": systems,
        "replacements": replacements,
        "replacementCount": len(replacements),
    }
