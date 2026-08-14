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
from ooxml import read_workpaper_xlsx

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


def _worksheet_xml(headers: list[str], rows: list[list[Any]], *, hidden: bool,
                   editable_columns: frozenset[int] = frozenset()) -> str:
    require(len(headers) <= MAX_HEADERS, "WORKBOOK.HEADERS_TOO_MANY", "Workbook header count exceeds the signed bound.")
    widths = [34 if index == 0 else 24 for index in range(len(headers))]
    data: list[str] = []
    for index, values in enumerate([headers, *rows], 1):
        cells = "".join(_cell(f"{_col_name(column)}{index}", value,
                              1 if index == 1 else 3 if column - 1 in editable_columns else 2)
                        for column, value in enumerate(values, 1))
        data.append(f'<row r="{index}" ht="22" customHeight="1">{cells}</row>')
    last = _col_name(len(headers))
    columns = "".join(f'<col min="{index}" max="{index}" width="{float(width):.2f}" customWidth="1"/>' for index, width in enumerate(widths, 1))
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<worksheet xmlns="{_NS_MAIN}"><sheetPr><pageSetUpPr fitToPage="1" autoPageBreaks="1"/></sheetPr>'
        f'<dimension ref="A1:{last}{len(rows) + 1}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
        f'<sheetFormatPr defaultRowHeight="15"/><cols>{columns}</cols><sheetData>{"".join(data)}</sheetData>'
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
            '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE2F0D9"/><bgColor indexed="64"/></patternFill></fill></fills>'
            '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs>'
            '<cellXfs count="4"><xf xfId="0"/><xf xfId="0" fontId="1" fillId="2" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf><xf xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf xfId="0" fillId="3" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs>'
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
    controls_xml = _worksheet_xml(headers, [[_cell_text(v) for v in row] for row in rows], hidden=False,
                                  editable_columns=frozenset(range(1, len(headers))))
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
    workbook = read_workpaper_xlsx(output, allow_formula_cache=True)
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
    xlsx_path = payload.get("xlsxPath")
    require(bool(isinstance(encoded, str) and encoded) != bool(isinstance(xlsx_path, str) and xlsx_path),
            "WORKBOOK.XLSX_REQUIRED", "Exactly one uploaded workbook byte source is required.")
    if isinstance(xlsx_path, str) and xlsx_path:
        try:
            with open(xlsx_path, "rb") as source:
                raw = source.read(64 * 1024 * 1024 + 1)
        except OSError as exc:
            raise EngineError("WORKBOOK.XLSX_READ_FAILED", "Uploaded workbook handle could not be read.") from exc
        require(0 < len(raw) <= 64 * 1024 * 1024, "WORKBOOK.XLSX_SIZE_INVALID", "Uploaded workbook size is invalid.")
    else:
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as exc:
            raise EngineError("WORKBOOK.XLSX_BASE64_INVALID", "Uploaded workbook is not valid base64.") from exc

    workbook = read_workpaper_xlsx(raw, allow_formula_cache=False)
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
    """Generate an editable Phase 2 template.

    The user may fill both 替换字段!E:E and the pre-populated Controls body.
    Scope remains hidden and is verified on upload. No visible sheet is
    protected; green cells are the intended editable inputs.
    """
    require(isinstance(payload, dict) and payload.get("schemaVersion") == WORKBOOK_SCHEMA, "WORKBOOK.INPUT_INVALID", "Template build input schema is invalid.")
    systems = payload.get("systems")
    directory = payload.get("directory")
    headers = payload.get("headers")
    controls = payload.get("controls")
    scope = payload.get("scope")
    require(isinstance(systems, list) and 0 < len(systems) <= 50, "WORKBOOK.SYSTEMS_INVALID", "Template requires 1..50 APP systems.")
    require(all(isinstance(s, str) and s.strip() for s in systems), "WORKBOOK.SYSTEMS_INVALID", "Template APP system names must be non-empty.")
    require(isinstance(directory, list) and directory, "WORKBOOK.DIRECTORY_INVALID", "Template placeholder directory is empty.")
    require(isinstance(headers, list) and 0 < len(headers) <= MAX_HEADERS
            and all(isinstance(header, str) and header.strip() for header in headers),
            "WORKBOOK.HEADERS_INVALID", "Template Controls headers are invalid.")
    require(isinstance(controls, list) and 0 < len(controls) <= MAX_ROWS,
            "WORKBOOK.ROWS_INVALID", "Template Controls rows are invalid.")
    for control in controls:
        require(isinstance(control, dict) and isinstance(control.get("values"), list)
                and len(control["values"]) == len(headers),
                "WORKBOOK.ROWS_INVALID", "Template Control row shape does not match headers.")
        require(str(control.get("controlNumber") or "").strip(),
                "WORKBOOK.CONTROL_IDENTITY_INVALID", "Template Control number is missing.")
    require(isinstance(scope, dict), "WORKBOOK.SCOPE_INVALID", "Template scope is invalid.")

    # 替换字段 sheet: placeholder directory per system. Columns match v4:
    # 编号 / 系统 / 测试点 / 替换项目 / 替换内容(E列用户填) / 替换内容示例.
    repl_headers = ["编号", "系统", "测试点", "替换项目", "替换内容", "替换内容示例"]
    repl_rows: list[list[Any]] = [["请仅填写 E 列绿色单元格；无法确认的内容可以留空。", "", "", "", "", ""]]
    for system in systems:
        for item in directory:
            if item.get("active") is False:
                continue
            repl_rows.append([item.get("code", ""), system, item.get("controlPoint", ""),
                              item.get("placeholder", ""), "", item.get("example", "")])

    control_rows: list[list[Any]] = []
    for system in systems:
        for control in controls:
            control_rows.append([str(value if value is not None else "").replace("系统ID", system)
                                 for value in control["values"]])
    scope_headers = ["key", "value"]
    scope_rows = [[key, _scope_text(value)] for key, value in scope.items()]

    sheet_names = ["替换字段", "Controls", "Scope"]
    parts = _container_parts(3, sheet_names, active_tab=0, hidden_sheets=(3,))
    parts["xl/worksheets/sheet1.xml"] = _worksheet_xml(repl_headers, repl_rows, hidden=False,
        editable_columns=frozenset({_REPLACEMENT_VALUE_COLUMN})).encode("utf-8")
    parts["xl/worksheets/sheet2.xml"] = _worksheet_xml(headers, control_rows, hidden=False,
        editable_columns=frozenset(range(1, len(headers)))).encode("utf-8")
    parts["xl/worksheets/sheet3.xml"] = _worksheet_xml(scope_headers, scope_rows, hidden=True).encode("utf-8")

    output = _deterministic_zip(parts)
    workbook = read_workpaper_xlsx(output, allow_formula_cache=True)
    require(tuple(sheet.name for sheet in workbook.sheets) == tuple(sheet_names), "WORKBOOK.ROUNDTRIP_STRUCTURE", "Generated template sheet contract drifted.")
    require(workbook.sheets[0].rows.get(1, []) == list(repl_headers), "WORKBOOK.ROUNDTRIP_HEADERS", "Generated template replacement headers drifted.")
    require(workbook.sheets[1].rows.get(1, []) == list(headers), "WORKBOOK.ROUNDTRIP_HEADERS", "Generated template Controls headers drifted.")

    return {
        "schemaVersion": "omnia.workpaper-phase2-template-result/v1",
        "xlsxBase64": base64.b64encode(output).decode("ascii"),
        "sizeBytes": len(output),
        "sha256": sha256_hex(output),
        "semanticDigest": semantic_digest({"systems": systems, "directory": directory,
                                            "headers": headers, "controls": controls, "scope": scope}),
        "sheetNames": sheet_names,
        "applicationCount": len(systems),
        "replacementRowCount": len(repl_rows),
        "controlRowCount": len(control_rows),
    }


def _cell_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _scope_text(value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(",", ":"))


REPLACEMENT_INPUT_SCHEMA = "omnia.workpaper-replacement-input/v1"
REPLACEMENT_OUTPUT_SCHEMA = "omnia.workpaper-replacement/v1"
_LEGACY_REPLACEMENT_SHEET_NAMES = ("替换字段",)
_EDITABLE_TEMPLATE_SHEET_NAMES = ("替换字段", "Controls", "Scope")
_REPLACEMENT_HEADERS = ("编号", "系统", "测试点", "替换项目", "替换内容", "替换内容示例")
_REPLACEMENT_VALUE_COLUMN = 4  # E column (0-based): 替换内容


def apply_replacement_fields(payload: Any) -> dict[str, Any]:
    """Parse replacement values and optional user-edited Controls rows.

    Legacy one-sheet templates remain readable. New templates must retain the
    exact Controls row identities and frozen Scope, while every non-identity
    Controls cell may be edited by the user.
    """
    require(isinstance(payload, dict) and payload.get("schemaVersion") == REPLACEMENT_INPUT_SCHEMA,
            "WORKBOOK.INPUT_INVALID", "Replacement input schema is invalid.")
    encoded = payload.get("xlsxBase64")
    xlsx_path = payload.get("xlsxPath")
    require(bool(isinstance(encoded, str) and encoded) != bool(isinstance(xlsx_path, str) and xlsx_path),
            "WORKBOOK.XLSX_REQUIRED", "Exactly one uploaded workbook byte source is required.")
    if isinstance(xlsx_path, str) and xlsx_path:
        try:
            with open(xlsx_path, "rb") as source:
                raw = source.read(64 * 1024 * 1024 + 1)
        except OSError as exc:
            raise EngineError("WORKBOOK.XLSX_READ_FAILED", "Uploaded workbook handle could not be read.") from exc
        require(0 < len(raw) <= 64 * 1024 * 1024, "WORKBOOK.XLSX_SIZE_INVALID", "Uploaded workbook size is invalid.")
    else:
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as exc:
            raise EngineError("WORKBOOK.XLSX_BASE64_INVALID", "Uploaded workbook is not valid base64.") from exc

    workbook = read_workpaper_xlsx(raw, allow_formula_cache=False)
    sheet_names = tuple(sheet.name for sheet in workbook.sheets)
    require(sheet_names in (_LEGACY_REPLACEMENT_SHEET_NAMES, _EDITABLE_TEMPLATE_SHEET_NAMES),
            "WORKBOOK.ROUNDTRIP_STRUCTURE", "Uploaded template sheet contract drifted.")

    replacement_sheet = workbook.sheets[0]
    actual_headers = replacement_sheet.rows.get(1, [])
    require(actual_headers == list(_REPLACEMENT_HEADERS),
            "WORKBOOK.HEADERS_DRIFT", "Uploaded template replacement headers drifted.")
    replacements: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    systems: list[str] = []
    seen_systems: set[str] = set()
    directory_rows: list[dict[str, str]] = []
    for row_number in sorted(r for r in replacement_sheet.rows if r > 1):
        values = replacement_sheet.rows[row_number]
        while len(values) <= _REPLACEMENT_VALUE_COLUMN:
            values.append("")
        code = str(values[0] or "").strip()
        system = str(values[1] or "").strip()
        control_point = str(values[2] or "").strip()
        placeholder = str(values[3] or "").strip()
        value = str(values[_REPLACEMENT_VALUE_COLUMN] or "").strip()
        if not system and not control_point and not placeholder and not value:
            continue  # the instruction row (请仅填写 E 列绿色单元格…)
        require(code and system and control_point and placeholder,
                "WORKBOOK.REPLACEMENT_DIRECTORY_DRIFT",
                "Uploaded replacement row identity is incomplete.")
        if system and system not in seen_systems:
            seen_systems.add(system)
            systems.append(system)
        key = (system, code)
        require(key not in seen, "WORKBOOK.REPLACEMENT_DUPLICATE", f"Uploaded replacement duplicates {system} / {code}.")
        seen.add(key)
        directory_rows.append({"system": system, "code": code, "controlPoint": control_point,
                               "placeholder": placeholder, "value": value})
        if not value:
            continue
        replacements.append({"system": system, "code": code, "controlPoint": control_point,
                             "placeholder": placeholder, "value": value})

    expected_directory = payload.get("expectedDirectory")
    require(isinstance(expected_directory, list) and expected_directory,
            "WORKBOOK.DIRECTORY_INVALID", "Expected replacement directory is required.")
    expected_by_code: dict[str, dict[str, Any]] = {}
    for item in expected_directory:
        require(isinstance(item, dict), "WORKBOOK.DIRECTORY_INVALID",
                "Expected replacement directory item is invalid.")
        code = str(item.get("code") or "").strip()
        control_point = str(item.get("controlPoint") or "").strip()
        placeholder = str(item.get("placeholder") or "").strip()
        require(code and control_point and placeholder and code not in expected_by_code,
                "WORKBOOK.DIRECTORY_INVALID", "Expected replacement directory identity is invalid or duplicated.")
        expected_by_code[code] = {"controlPoint": control_point, "placeholder": placeholder,
                                  "active": item.get("active") is not False}
    active_codes = {code for code, item in expected_by_code.items() if item["active"]}
    actual_active_codes: dict[str, set[str]] = {system: set() for system in systems}
    for row in directory_rows:
        expected = expected_by_code.get(row["code"])
        require(expected is not None
                and row["controlPoint"] == expected["controlPoint"]
                and row["placeholder"] == expected["placeholder"],
                "WORKBOOK.REPLACEMENT_DIRECTORY_DRIFT",
                f"Uploaded replacement row {row['system']} / {row['code']} differs from the authoritative directory.")
        if expected["active"]:
            actual_active_codes[row["system"]].add(row["code"])
        else:
            require(not row["value"], "WORKBOOK.REPLACEMENT_INACTIVE",
                    f"Uploaded replacement {row['system']} / {row['code']} has no supported master destination.")
    require(all(codes == active_codes for codes in actual_active_codes.values()),
            "WORKBOOK.REPLACEMENT_DIRECTORY_DRIFT",
            "Uploaded replacement rows differ from the authoritative active directory.")

    parsed_controls: list[dict[str, Any]] = []
    control_headers: list[str] = []
    if sheet_names == _EDITABLE_TEMPLATE_SHEET_NAMES:
        expected_headers = payload.get("expectedHeaders")
        control_templates = payload.get("controlTemplates")
        expected_scope = payload.get("expectedScope")
        require(isinstance(expected_headers, list) and expected_headers,
                "WORKBOOK.HEADERS_INVALID", "Expected Controls headers are required.")
        require(isinstance(control_templates, list) and control_templates,
                "WORKBOOK.ROWS_INVALID", "Expected Control templates are required.")
        require(isinstance(expected_scope, dict), "WORKBOOK.SCOPE_INVALID", "Expected template Scope is required.")

        controls_sheet = workbook.sheets[1]
        control_headers = controls_sheet.rows.get(1, [])
        require(control_headers == list(expected_headers),
                "WORKBOOK.HEADERS_DRIFT", "Uploaded template Controls headers drifted.")
        expected_rows: dict[str, tuple[str, list[str]]] = {}
        expected_order: list[str] = []
        for system in systems:
            for template in control_templates:
                require(isinstance(template, dict) and isinstance(template.get("values"), list)
                        and len(template["values"]) == len(control_headers),
                        "WORKBOOK.ROWS_INVALID", "Expected Control template shape is invalid.")
                expected_values = [str(value if value is not None else "").replace("系统ID", system)
                                   for value in template["values"]]
                control_number = expected_values[0].strip()
                require(control_number and control_number not in expected_rows,
                        "WORKBOOK.CONTROL_IDENTITY_INVALID", "Expected Control row identity is empty or duplicated.")
                expected_rows[control_number] = (system, expected_values)
                expected_order.append(control_number)
        actual_rows: dict[str, list[str]] = {}
        for row_number in sorted(row for row in controls_sheet.rows if row > 1):
            values = list(controls_sheet.rows[row_number])
            require(not any(str(value or "").strip() for value in values[len(control_headers):]),
                    "WORKBOOK.ROWS_INVALID", "Uploaded Controls row has cells beyond the signed headers.")
            values = values[:len(control_headers)]
            values.extend([""] * (len(control_headers) - len(values)))
            control_number = str(values[0] or "").strip()
            require(control_number in expected_rows and control_number not in actual_rows,
                    "WORKBOOK.CONTROL_IDENTITY_DRIFT", "Uploaded Controls identity is unknown or duplicated.")
            actual_rows[control_number] = [str(value or "") for value in values]
        require(set(actual_rows) == set(expected_rows),
                "WORKBOOK.CONTROL_SCOPE_DRIFT", "Uploaded Controls rows differ from the generated template scope.")
        parsed_controls = [{"system": expected_rows[control_number][0], "controlNumber": control_number,
                            "values": actual_rows[control_number]} for control_number in expected_order]

        actual_scope: dict[str, str] = {}
        for row_number in sorted(row for row in workbook.sheets[2].rows if row > 1):
            values = workbook.sheets[2].rows[row_number]
            if len(values) >= 2 and values[0]:
                require(values[0] not in actual_scope, "WORKBOOK.SCOPE_INVALID", "Uploaded template Scope key is duplicated.")
                actual_scope[values[0]] = values[1]
        frozen_scope = {str(key): _scope_text(value) for key, value in expected_scope.items()}
        require(actual_scope == frozen_scope, "WORKBOOK.SCOPE_DRIFT", "Uploaded template Scope differs from the frozen plan.")

    return {
        "schemaVersion": REPLACEMENT_OUTPUT_SCHEMA,
        "systems": systems,
        "replacements": replacements,
        "replacementCount": len(replacements),
        "controlHeaders": control_headers,
        "controls": parsed_controls,
        "templateMode": "editable_controls" if parsed_controls else "legacy_replacements_only",
    }
