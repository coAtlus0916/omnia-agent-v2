#!/usr/bin/env python3
"""Add Oracle EBS V8 governance and remove the conflicting V5 APP validation.

This is a bounded, standard-library-only OOXML transform.  It is intentionally
parameterized by the governed Higher/Lower workbook, uses compare-and-swap for
every write, and is idempotent.  Runtime Risk/Control UUIDs are never inferred:
the generated governance resolves current catalog numbers dynamically, while
the live relation-readback registry remains explicitly pending.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import sys
import tempfile
from collections import Counter


ROOT = pathlib.Path(__file__).resolve().parents[1]
PYTHON_SOURCE = ROOT / "feature-packages" / "create-associate" / "source" / "python"
sys.path.insert(0, str(PYTHON_SOURCE))

from ooxml import compile_parts, read_xlsx  # noqa: E402


DEFAULT_V8 = ROOT / "feature-packages" / "create-associate" / "source" / "managed" / "phase1-system-information-v8.xlsx"
DEFAULT_IT_RISK = ROOT / "source_files" / "it risk模板.xlsx"
DEFAULT_V5_SOURCE = ROOT / "source_files" / "Phase1-用户填写模板V5.xlsx"
DEFAULT_V5_MANAGED = ROOT / "feature-packages" / "create-associate" / "source" / "managed" / "Phase1-用户填写模板V5.xlsx"

FIELD_SHEET = "字段母版"
RELATION_SHEET = "Risk-Control关系"
EVIDENCE_SHEET = "V4接口证据"
QUALITY_SHEET = "覆盖与质检"
TRACE_SHEET = "原始字段追溯"
HIGHER_SHEET = "RAIT-APP-OracleEBS-higher模板"
LOWER_SHEET = "RAIT-APP-OracleEBS-lower模板"

RECORDING_ID = "1df21175-b43f-4f25-99a5-3385e3c77097"
OBSERVATION_ID = "observation_ad284531b087a64302be45a901df6eaa"
STREAM_ID = "stream_0115c29335935b6d7ae2e374a16b1bb8"
STREAM_SHA256 = "e7f92684575bd411f091cad4cf7af5e9084364b9d5c68a918c66c8e02915243e"
ARTIFACT_ID = "1c864692-7b02-498c-be5f-bf38adcab14f"
ARTIFACT_SHA256 = "b143e180ed8a59fdbf78e7d6170503739f0f3e320cc9632eb9af1383018d9801"

CONTROL_RISK = {
    "OEBS.01": "RAITCOR001", "OEBS.02": "RAITCOR001", "OEBS.03": "RAITCOR001",
    "OEBS.04": "RAITCOR001", "OEBS.06": "RAITCOR001", "OEBS.07": "RAITCOR002",
    "OEBS.05": "RAITCOR003", "OEBS.10": "RAITCOR004", "OEBS.13": "RAITCOR004",
    "OEBS.15": "RAITCOR011", "OEBS.16": "RAITCOR011", "OEBS.14": "RAITCOR007",
}
EXPECTED_CONTROL_ORDER = list(CONTROL_RISK)
EXTRA_CONTROL_ZH = {
    "OEBS.04": "监控职责分离，并移除冲突访问权限或将其映射至已记录并测试的缓解性控制。",
    "OEBS.07": "适当实施诊断配置文件，以限制 Oracle EBS 账户在未通过数据库层身份验证的情况下从 Oracle EBS 应用访问 Oracle 数据库。",
    "OEBS.14": "管理层批准从旧应用系统或数据结构向新应用系统或数据结构转换数据的结果（例如平衡与对账活动），并监督数据转换按照既定政策和程序执行。",
}


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"[augment-oracle-ebs-v8] {message}")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def xml_escape(value: object) -> str:
    return (str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&apos;"))


def column_name(index: int) -> str:
    value, result = index + 1, ""
    while value:
        value, remainder = divmod(value - 1, 26)
        result = chr(65 + remainder) + result
    return result


def table_rows(sheet) -> tuple[list[str], list[dict[str, object]]]:
    headers = list(sheet.rows.get(4, []))
    rows: list[dict[str, object]] = []
    for row_number, raw in sorted(sheet.rows.items()):
        if row_number <= 4 or not any(str(value).strip() for value in raw):
            continue
        values = list(raw) + [""] * max(0, len(headers) - len(raw))
        rows.append({"row": row_number, "values": {header: values[index] for index, header in enumerate(headers)}})
    return headers, rows


def find_row_xml(xml: str, row_number: int) -> str:
    match = re.search(
        rf'<(?:[A-Za-z_][\w.-]*:)?row\b[^>]*\br="{row_number}"[^>]*>[\s\S]*?</(?:[A-Za-z_][\w.-]*:)?row>',
        xml,
    )
    if not match:
        fail(f"template row {row_number} is missing")
    return match.group(0)


def row_style_map(row_xml: str) -> tuple[str, dict[int, str]]:
    open_tag = re.match(r'<(?:[A-Za-z_][\w.-]*:)?row\b([^>]*)>', row_xml)
    attrs = open_tag.group(1) if open_tag else ""
    attrs = re.sub(r'\s+r="\d+"', "", attrs)
    styles: dict[int, str] = {}
    for match in re.finditer(r'<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*?)(?:/>|>[\s\S]*?</(?:[A-Za-z_][\w.-]*:)?c>)', row_xml):
        ref = re.search(r'\br="([A-Z]+)\d+"', match.group(1))
        if not ref:
            continue
        index = 0
        for letter in ref.group(1):
            index = index * 26 + ord(letter) - 64
        style = re.search(r'\bs="(\d+)"', match.group(1))
        if style:
            styles[index - 1] = style.group(1)
    return attrs, styles


def inline_row(row_number: int, values: list[object], template_row: str) -> str:
    attrs, styles = row_style_map(template_row)
    attrs = re.sub(r'\s+spans="[^"]*"', "", attrs)
    cells = []
    for index, value in enumerate(values):
        style = f' s="{styles[index]}"' if index in styles else ""
        ref = f"{column_name(index)}{row_number}"
        cells.append(f'<c r="{ref}"{style} t="inlineStr"><is><t xml:space="preserve">{xml_escape(value)}</t></is></c>')
    return f'<row r="{row_number}"{attrs}>{"".join(cells)}</row>'


def formula_cell(reference: str, formula: str, cached: object, style: str = "24") -> str:
    return f'<c r="{reference}" s="{style}"><f>{xml_escape(formula)}</f><v>{xml_escape(cached)}</v></c>'


def string_cell(reference: str, value: object, style: str = "24") -> str:
    return f'<c r="{reference}" s="{style}" t="inlineStr"><is><t xml:space="preserve">{xml_escape(value)}</t></is></c>'


def append_rows(xml: str, rows: list[str], last_row: int, end_column: str) -> str:
    if not re.search(r'</(?:[A-Za-z_][\w.-]*:)?sheetData>', xml):
        fail("worksheet sheetData closing tag is missing")
    updated = re.sub(r'</(?:[A-Za-z_][\w.-]*:)?sheetData>', "".join(rows) + r'</sheetData>', xml, count=1)
    updated = re.sub(r'(<(?:[A-Za-z_][\w.-]*:)?dimension\b[^>]*\bref=")([^"]+)(")',
                     lambda match: f'{match.group(1)}{match.group(2).split(":")[0]}:{end_column}{last_row}{match.group(3)}', updated, count=1)
    updated = re.sub(r'(<(?:[A-Za-z_][\w.-]*:)?autoFilter\b[^>]*\bref=")([^"]+)(")',
                     lambda match: f'{match.group(1)}{match.group(2).split(":")[0]}:{end_column}{last_row}{match.group(3)}', updated)
    return updated


def update_table_ref(xml: bytes, last_row: int) -> bytes:
    text = xml.decode("utf-8")
    text = re.sub(r'(\bref="[A-Z]+\d+:[A-Z]+)\d+(")', rf'\g<1>{last_row}\2', text)
    return text.encode("utf-8")


def replace_formula_cache(xml: str, reference: str, value: object) -> str:
    pattern = re.compile(rf'(<(?:[A-Za-z_][\w.-]*:)?c\b[^>]*\br="{reference}"[^>]*>[\s\S]*?<v>)[\s\S]*?(</v>[\s\S]*?</(?:[A-Za-z_][\w.-]*:)?c>)')
    updated, count = pattern.subn(lambda match: f"{match.group(1)}{xml_escape(value)}{match.group(2)}", xml, count=1)
    if count != 1:
        fail(f"quality cache cell {reference} is missing")
    return updated


def atomic_write(path: pathlib.Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def parse_scope_workbook(path: pathlib.Path) -> tuple[list[dict[str, str]], str]:
    data = path.read_bytes()
    workbook = read_xlsx(data, allow_formula_cache=True)
    sheets = {sheet.name: sheet for sheet in workbook.sheets}
    if HIGHER_SHEET not in sheets or LOWER_SHEET not in sheets:
        fail("Oracle EBS Higher/Lower source sheets are missing")
    modes: dict[str, dict[str, dict[str, str]]] = {}
    for mode, sheet_name in (("higher", HIGHER_SHEET), ("lower", LOWER_SHEET)):
        sheet = sheets[sheet_name]
        headers = sheet.rows.get(1, [])
        required = ["IT Risk", "Control ID", "Control Description", "Scoped In?"]
        if any(header not in headers for header in required):
            fail(f"{sheet_name} headers drifted")
        indexes = {header: headers.index(header) for header in required}
        observed: dict[str, dict[str, str]] = {}
        risk_text = ""
        for row_number, row in sorted(sheet.rows.items()):
            if row_number <= 1:
                continue
            values = list(row) + [""] * len(headers)
            if str(values[indexes["IT Risk"]]).strip():
                risk_text = str(values[indexes["IT Risk"]]).strip()
            control = str(values[indexes["Control ID"]]).strip()
            if not control:
                continue
            observed[control] = {
                "row": str(row_number), "riskEnglish": risk_text,
                "controlEnglish": str(values[indexes["Control Description"]]).strip(),
                "link": "Y" if str(values[indexes["Scoped In?"]]).strip().upper() == "Y" else "N",
            }
        if list(observed) != EXPECTED_CONTROL_ORDER:
            fail(f"{sheet_name} Oracle EBS Control inventory/order drifted: {list(observed)}")
        modes[mode] = observed
    rows = []
    for control in EXPECTED_CONTROL_ORDER:
        higher, lower = modes["higher"][control], modes["lower"][control]
        if higher["controlEnglish"] != lower["controlEnglish"] or higher["riskEnglish"] != lower["riskEnglish"]:
            fail(f"Higher/Lower semantic drift for {control}")
        rows.append({"control": control, "risk": CONTROL_RISK[control], "riskEnglish": higher["riskEnglish"],
                     "controlEnglish": higher["controlEnglish"], "higherRow": higher["row"], "lowerRow": lower["row"],
                     "higher": higher["link"], "lower": lower["link"]})
    if sum(row["higher"] == "Y" for row in rows) != 11 or sum(row["lower"] == "Y" for row in rows) != 7:
        fail("Oracle EBS Scoped In counts must be Higher=11 and Lower=7")
    if next(row for row in rows if row["control"] == "OEBS.04")["higher"] != "N" or next(row for row in rows if row["control"] == "OEBS.04")["lower"] != "N":
        fail("OEBS.04 must remain unlinked in Higher and Lower")
    return rows, digest(data)


def clean_v5(source: bytes) -> bytes:
    workbook = read_xlsx(source, allow_formula_cache=True)
    if len(workbook.sheets) != 1:
        fail("V5 user template must contain one worksheet")
    part = workbook.sheets[0].part_name
    xml = workbook.parts[part].decode("utf-8")
    validation_pattern = re.compile(r'<(?:[A-Za-z_][\w.-]*:)?dataValidation\b[^>]*>[\s\S]*?</(?:[A-Za-z_][\w.-]*:)?dataValidation>')
    validations = validation_pattern.findall(xml)
    overlapping = [item for item in validations if re.search(r'\bsqref="C23:C24"', item)]
    desired = [item for item in overlapping if "Oracle EBS" in item and "SAP S/4 HANA" in item]
    stale = [item for item in overlapping if "Oracle EBS" not in item]
    if len(desired) != 1:
        fail("V5 must have exactly one Oracle-capable C23:C24 validation")
    if not stale:
        if len(overlapping) != 1:
            fail("V5 C23:C24 validation remains ambiguous")
        return source
    if len(stale) != 1 or len(overlapping) != 2:
        fail("V5 contains an unexpected overlapping APP validation inventory")
    updated = xml.replace(stale[0], "", 1)
    count_match = re.search(r'(<(?:[A-Za-z_][\w.-]*:)?dataValidations\b[^>]*\bcount=")(\d+)(")', updated)
    if not count_match:
        fail("V5 dataValidations count is missing")
    updated = updated[:count_match.start(2)] + str(int(count_match.group(2)) - 1) + updated[count_match.end(2):]
    result = compile_parts(source, {part: updated.encode("utf-8")})
    check = read_xlsx(result, allow_formula_cache=True)
    check_xml = check.parts[check.sheets[0].part_name].decode("utf-8")
    remaining = [item for item in validation_pattern.findall(check_xml) if re.search(r'\bsqref="C23:C24"', item)]
    if len(remaining) != 1 or "Oracle EBS" not in remaining[0]:
        fail("generated V5 did not retain one unique Oracle-capable validation")
    return result


def build_v8(source: bytes, scope_rows: list[dict[str, str]], template_sha: str) -> bytes:
    workbook = read_xlsx(source, allow_formula_cache=True)
    sheets = {sheet.name: sheet for sheet in workbook.sheets}
    for name in (FIELD_SHEET, RELATION_SHEET, EVIDENCE_SHEET, QUALITY_SHEET, TRACE_SHEET):
        if name not in sheets:
            fail(f"V8 worksheet is missing: {name}")
    field_headers, fields = table_rows(sheets[FIELD_SHEET])
    relation_headers, relations = table_rows(sheets[RELATION_SHEET])
    evidence_headers, evidence = table_rows(sheets[EVIDENCE_SHEET])
    trace_headers, traces = table_rows(sheets[TRACE_SHEET])
    oracle_fields = [row for row in fields if ".APP.ORACLE_EBS." in str(row["values"].get("field_id", ""))]
    oracle_relations = [row for row in relations if str(row["values"].get("relation_id", "")).startswith("REL.APP.ORACLE_EBS.")]
    if oracle_fields or oracle_relations:
        if len(fields) == 257 and len(relations) == 118 and len(oracle_fields) == 18 and len(oracle_relations) == 12:
            return source
        fail("partial Oracle EBS governance already exists")
    if len(fields) != 239 or len(relations) != 106 or len(evidence) != 21 or len(traces) != 251:
        fail(f"V8 base counts drifted: fields={len(fields)}, relations={len(relations)}, evidence={len(evidence)}, traces={len(traces)}")

    field_by_id = {str(row["values"]["field_id"]): row for row in fields}
    generic_risks = {code: field_by_id[f"P1.RISK.APP.GENERIC.{code}"] for code in sorted(set(CONTROL_RISK.values()))}
    generic_controls = {}
    for control in EXPECTED_CONTROL_ORDER:
        ordinal = control.split(".")[1]
        generic = field_by_id.get(f"P1.CONTROL.APP.GENERIC.APP_{ordinal}")
        if generic:
            generic_controls[control] = generic
    if set(generic_risks) != set(CONTROL_RISK.values()):
        fail("Generic APP Risk semantic templates are incomplete")

    classifications: dict[str, dict[str, str]] = {}
    for risk in sorted(set(CONTROL_RISK.values())):
        subset = [row for row in scope_rows if row["risk"] == risk]
        classifications[risk] = {
            "higher": "Higher" if any(row["higher"] == "Y" for row in subset) else "ClassificationNA",
            "lower": "Lower" if any(row["lower"] == "Y" for row in subset) else "ClassificationNA",
        }

    risk_names = {}
    for risk, source_row in generic_risks.items():
        source_label = str(source_row["values"]["Omnia UI标准字段名"])
        risk_names[risk] = source_label.replace("通用应用程序", "Oracle EBS")

    control_names = {}
    for row in scope_rows:
        control = row["control"]
        if control in generic_controls:
            generic_label = str(generic_controls[control]["values"]["Omnia UI标准字段名"])
            description = generic_label.split("｜", 1)[1] if "｜" in generic_label else generic_label
        else:
            description = EXTRA_CONTROL_ZH[control]
        control_names[control] = f"{control}｜{description}"

    field_values: list[list[object]] = []
    trace_values: list[list[object]] = []
    emitted_risks: set[str] = set()
    field_templates: list[str] = []
    field_xml = workbook.parts[sheets[FIELD_SHEET].part_name].decode("utf-8")
    trace_xml = workbook.parts[sheets[TRACE_SHEET].part_name].decode("utf-8")
    risk_template_xml = find_row_xml(field_xml, int(generic_risks["RAITCOR001"]["row"]))
    control_template_xml = find_row_xml(field_xml, int(next(iter(generic_controls.values()))["row"]))
    trace_template_xml = find_row_xml(trace_xml, int(traces[-1]["row"]))

    for scoped in scope_rows:
        risk, control = scoped["risk"], scoped["control"]
        if risk not in emitted_risks:
            source_values = dict(generic_risks[risk]["values"])
            field_id = f"P1.RISK.APP.ORACLE_EBS.{risk}"
            trace_id = f"SRC.ORACLE_EBS.IT_RISK.{risk}.RISK"
            source_values.update({
                "field_id": field_id, "对象子类型/区段": "Application / Oracle EBS", "Higher适用": "Y", "Lower适用": "Y",
                "Omnia UI标准字段名": risk_names[risk], "evidence_type": "template+runtime-authority",
                "v4证据路径+行号": f"source_files/it risk模板.xlsx#{HIGHER_SHEET}/{LOWER_SHEET}",
                "证据状态/置信度": "模板规则已确认；live Risk/Control 关系读回待恢复（非执行门禁）",
                "校验规则": f"Higher={classifications[risk]['higher']}; Lower={classifications[risk]['lower']}; riskNumber 必须由当前目录唯一精确匹配",
                "source_trace_id": trace_id,
                "备注": "Higher/Lower 分类由同一 Risk 下 link_required 是否至少存在一项确定；不固化运行时 Risk UUID。",
            })
            field_values.append([source_values.get(header, "") for header in field_headers])
            field_templates.append(risk_template_xml)
            first = next(item for item in scope_rows if item["risk"] == risk)
            trace = {
                "trace_item_id": trace_id, "source_file": "it risk模板.xlsx", "source_sheet": f"{HIGHER_SHEET} + {LOWER_SHEET}",
                "source_row": f"Higher {first['higherRow']} / Lower {first['lowerRow']}", "行角色": "字段", "源对象类型": "Application",
                "源区段/子类型": "Oracle EBS", "源字段/编号": risk, "原始描述/汇总": first["riskEnglish"],
                "原始填写方式/评估": "由 Scoped In 子项确定分类", "原始示例/关系": "Risk -> OEBS Control",
                "原始Higher/非AI校验": classifications[risk]["higher"], "原始Lower/AI校验": classifications[risk]["lower"],
                "master_field_id": field_id, "追溯状态": "已映射", "备注": "中文标准名由模板英文与现有 Generic APP 语义参数化生成。",
            }
            trace_values.append([trace.get(header, "") for header in trace_headers])
            emitted_risks.add(risk)

        template_values = dict((generic_controls.get(control) or next(iter(generic_controls.values())))["values"])
        control_key = control.replace(".", "_")
        field_id = f"P1.CONTROL.APP.ORACLE_EBS.{control_key}"
        trace_id = f"SRC.ORACLE_EBS.IT_RISK.{control_key}.CONTROL"
        template_values.update({
            "field_id": field_id, "对象子类型/区段": "Application / Oracle EBS", "Higher适用": scoped["higher"], "Lower适用": scoped["lower"],
            "Omnia UI标准字段名": control_names[control], "evidence_type": "template+runtime-authority",
            "v4证据路径+行号": f"source_files/it risk模板.xlsx#{HIGHER_SHEET}!{scoped['higherRow']}; {LOWER_SHEET}!{scoped['lowerRow']}",
            "证据状态/置信度": "模板规则已确认；live Control UUID/最终关系读回待恢复（非执行门禁）",
            "校验规则": "controlNumber 必须由当前目录唯一精确匹配；禁止按序号、翻译或描述猜测；运行时 UUID 不固化",
            "source_trace_id": trace_id,
            "备注": "catalog_present Higher/Lower 均为 Y；是否关联仅由 link_required_higher/link_required_lower 决定。",
        })
        field_values.append([template_values.get(header, "") for header in field_headers])
        field_templates.append(control_template_xml)
        trace = {
            "trace_item_id": trace_id, "source_file": "it risk模板.xlsx", "source_sheet": f"{HIGHER_SHEET} + {LOWER_SHEET}",
            "source_row": f"Higher {scoped['higherRow']} / Lower {scoped['lowerRow']}", "行角色": "字段", "源对象类型": "Application",
            "源区段/子类型": "Oracle EBS", "源字段/编号": control, "原始描述/汇总": scoped["controlEnglish"],
            "原始填写方式/评估": "Scoped In?", "原始示例/关系": f"关联 Risk={risk}",
            "原始Higher/非AI校验": scoped["higher"], "原始Lower/AI校验": scoped["lower"],
            "master_field_id": field_id, "追溯状态": "已映射", "备注": "Higher/Lower 目录身份共享；Scoped In 仅决定是否建立关系。",
        }
        trace_values.append([trace.get(header, "") for header in trace_headers])

    relation_values: list[list[object]] = []
    relation_template_xml = find_row_xml(workbook.parts[sheets[RELATION_SHEET].part_name].decode("utf-8"), int(relations[0]["row"]))
    for scoped in scope_rows:
        risk, control = scoped["risk"], scoped["control"]
        control_key = control.replace(".", "_")
        application = {("Y", "Y"): "两者", ("Y", "N"): "Higher", ("N", "Y"): "Lower", ("N", "N"): "不建立关联"}[(scoped["higher"], scoped["lower"])]
        required = "N" if application == "不建立关联" else "条件必需" if application == "两者" else f"条件必需（{application}）"
        trace_id = f"SRC.ORACLE_EBS.IT_RISK.{control_key}.CONTROL"
        values = {
            "relation_id": f"REL.APP.ORACLE_EBS.{risk}.{control_key}", "risk_field_id": f"P1.RISK.APP.ORACLE_EBS.{risk}",
            "Risk标准名": risk_names[risk], "control_field_id": f"P1.CONTROL.APP.ORACLE_EBS.{control_key}", "Control标准名": control_names[control],
            "关系类型/方向": "Risk -> Control", "catalog_present_higher": "Y", "catalog_present_lower": "Y",
            "link_required_higher": scoped["higher"], "link_required_lower": scoped["lower"],
            "classification_higher": classifications[risk]["higher"], "classification_lower": classifications[risk]["lower"],
            "执行适用层级": application, "适用场景/对象类型": "Application / Oracle EBS", "是否必需": required,
            "无资料时策略": "按元素 RAIT 筛选；当前目录编号零/多匹配则明确失败，不猜测、不因缺历史录制阻断",
            "v4 evidence_type": "template+runtime-authority",
            "v4 JSON/API/DOM/connector路径": "GET plannedresponse + GET controls + POST validateHiddenDataForRiskAssociation + POST controls/controlrisks/associate；统一 APP 参数化 Operation",
            "证据文件+行号": f"source_files/it risk模板.xlsx#{HIGHER_SHEET}!{scoped['higherRow']}; {LOWER_SHEET}!{scoped['lowerRow']}; templateSha256={template_sha}",
            "确认状态": "Scoped In 已确认；live最终关系读回待恢复（非执行门禁）", "source_trace_id": trace_id,
            "备注": "不固化 Risk/Control UUID；当前目录按 riskNumber/classification 与 controlNumber 唯一解析，0/2 项均失败关闭。",
        }
        relation_values.append([values.get(header, "") for header in relation_headers])

    creation_evidence = f"recording:{RECORDING_ID}/{OBSERVATION_ID}/{STREAM_ID}#sha256={STREAM_SHA256}; artifact:{ARTIFACT_ID}#sha256={ARTIFACT_SHA256}"
    evidence_values = [
        ["EV.P1.ORACLE_EBS.CONTENT_RECORDING", "Oracle EBS 内容身份", "recording+artifact", "Page Observation frozen stream + Core Artifact",
         "StandardizedAccount_Oracle eBusiness Suite; key=66176468; Application category key=66175343",
         "统一 APP authority resolver 动态读取当前 Standardized Accounts List", creation_evidence, "Oracle EBS Application/GRA content", "已确认-强",
         "证明精确内容显示名与目录 key；运行时仍按当前目录唯一解析，不固化 publication UUID", "第二条 Risk-Control 录制固化失败不影响此内容身份 Artifact"],
        ["EV.P1.ORACLE_EBS.SCOPE_TEMPLATE", "Oracle EBS Higher/Lower Scoped In", "governed-workbook",
         f"{HIGHER_SHEET} + {LOWER_SHEET}", "12 个 OEBS Control；catalog 两模式同一目录；Higher=11, Lower=7",
         "统一 APP Risk-Control family 参数化计划", f"source_files/it risk模板.xlsx#sha256={template_sha}", "Oracle EBS Risk/Control 计划", "已确认-强",
         "Scoped In 决定 link_required；每个 Risk 无 required Control 时 ClassificationNA", "live Risk/Control UUID 与最终关系读回仍为 blocked_pending_live_relation_readback 证据状态，非主动 Return 门禁"],
    ]

    mutations: dict[str, bytes] = {}
    field_start = max(int(row["row"]) for row in fields) + 1
    new_field_rows = [inline_row(field_start + index, values, field_templates[index]) for index, values in enumerate(field_values)]
    mutations[sheets[FIELD_SHEET].part_name] = append_rows(field_xml, new_field_rows, field_start + len(new_field_rows) - 1, "V").encode("utf-8")

    relation_xml = workbook.parts[sheets[RELATION_SHEET].part_name].decode("utf-8")
    relation_start = max(int(row["row"]) for row in relations) + 1
    new_relation_rows = [inline_row(relation_start + index, values, relation_template_xml) for index, values in enumerate(relation_values)]
    mutations[sheets[RELATION_SHEET].part_name] = append_rows(relation_xml, new_relation_rows, relation_start + len(new_relation_rows) - 1, "V").encode("utf-8")

    evidence_xml = workbook.parts[sheets[EVIDENCE_SHEET].part_name].decode("utf-8")
    evidence_template_xml = find_row_xml(evidence_xml, int(evidence[-1]["row"]))
    evidence_start = max(int(row["row"]) for row in evidence) + 1
    new_evidence_rows = [inline_row(evidence_start + index, values, evidence_template_xml) for index, values in enumerate(evidence_values)]
    mutations[sheets[EVIDENCE_SHEET].part_name] = append_rows(evidence_xml, new_evidence_rows, evidence_start + len(new_evidence_rows) - 1, "K").encode("utf-8")

    trace_start = max(int(row["row"]) for row in traces) + 1
    new_trace_rows = [inline_row(trace_start + index, values, trace_template_xml) for index, values in enumerate(trace_values)]
    mutations[sheets[TRACE_SHEET].part_name] = append_rows(trace_xml, new_trace_rows, trace_start + len(new_trace_rows) - 1, "P").encode("utf-8")

    for table_part, last_row in (("xl/tables/table1.xml", 261), ("xl/tables/table2.xml", 122),
                                 ("xl/tables/table3.xml", 27), ("xl/tables/table5.xml", 273)):
        if table_part not in workbook.parts:
            fail(f"required table part is missing: {table_part}")
        mutations[table_part] = update_table_ref(workbook.parts[table_part], last_row)

    quality_xml = workbook.parts[sheets[QUALITY_SHEET].part_name].decode("utf-8")
    replacements = {
        "$E$5:$E$255": "$E$5:$E$273", "$N$5:$N$255": "$N$5:$N$273",
        "$S$5:$S$191": "$S$5:$S$261", "$A$5:$A$191": "$A$5:$A$261",
        "$A$5:$A$72": "$A$5:$A$122", "$B$5:$B$72": "$B$5:$B$122", "$D$5:$D$72": "$D$5:$D$122",
        "$I$5:$I$25": "$I$5:$I$27",
    }
    for old, new in replacements.items():
        quality_xml = quality_xml.replace(old, new)
    final_fields = fields + [{"values": dict(zip(field_headers, values, strict=True))} for values in field_values]
    statuses = Counter(str(row["values"].get("证据状态/置信度", "")) for row in final_fields)
    caches = {"B5": 198, "B6": 198, "B7": 1, "B8": 257, "B9": 118, "B10": 23,
              "B11": statuses["v4未发现/待确认"] + statuses["部分确认"] + statuses["执行阻断"]}
    for row, status in zip(range(5, 12), ("已确认-强", "已确认-中", "已确认-弱", "部分确认", "执行阻断", "v4未发现/待确认", "不适用"), strict=True):
        caches[f"E{row}"] = statuses[status]
    for reference, value in caches.items():
        quality_xml = replace_formula_cache(quality_xml, reference, value)

    quality_start = 1109
    quality_rows = [
        f'<row r="{quality_start}">{string_cell(f"A{quality_start}", "Oracle EBS 增量质检", "87")}</row>',
        f'<row r="{quality_start + 1}">{string_cell(f"A{quality_start + 1}", "relation_id", "22")}{string_cell(f"B{quality_start + 1}", "端点与模式", "22")}{string_cell(f"C{quality_start + 1}", "追溯", "22")}{string_cell(f"D{quality_start + 1}", "结果", "22")}</row>',
        f'<row r="{quality_start + 2}">{string_cell(f"A{quality_start + 2}", "Oracle EBS 汇总")}'
        f'{formula_cell(f"B{quality_start + 2}", "COUNTIF(字段母版!$A$5:$A$261,\"P1.*.APP.ORACLE_EBS.*\")", 18)}'
        f'{formula_cell(f"C{quality_start + 2}", "COUNTIF(\'Risk-Control关系\'!$A$5:$A$122,\"REL.APP.ORACLE_EBS.*\")", 12)}'
        f'{formula_cell(f"D{quality_start + 2}", "IF(AND(B1111=18,C1111=12),\"通过\",\"问题\")", "通过")}</row>',
    ]
    for index, values in enumerate(relation_values):
        row_number = quality_start + 3 + index
        relation = dict(zip(relation_headers, values, strict=True))
        relation_source_row = relation_start + index
        quality_rows.append(
            f'<row r="{row_number}">{string_cell(f"A{row_number}", relation["relation_id"])}'
            f'{formula_cell(f"B{row_number}", f"IF(AND(\'Risk-Control关系\'!B{relation_source_row}<>\"\",\'Risk-Control关系\'!D{relation_source_row}<>\"\",\'Risk-Control关系\'!G{relation_source_row}=\"Y\",\'Risk-Control关系\'!H{relation_source_row}=\"Y\"),\"端点/目录通过\",\"问题\")", "端点/目录通过")}'
            f'{formula_cell(f"C{row_number}", f"IF(COUNTIF(原始字段追溯!$A$5:$A$273,\'Risk-Control关系\'!U{relation_source_row})=1,\"追溯通过\",\"问题\")", "追溯通过")}'
            f'{formula_cell(f"D{row_number}", f"IF(AND(B{row_number}=\"端点/目录通过\",C{row_number}=\"追溯通过\"),\"通过\",\"问题\")", "通过")}</row>'
        )
    quality_xml = append_rows(quality_xml, quality_rows, quality_start + len(quality_rows) - 1, "G")
    quality_xml = quality_xml.replace('<mergeCells count="9">', '<mergeCells count="10">', 1)
    quality_xml = quality_xml.replace('</mergeCells>', f'<mergeCell ref="A{quality_start}:G{quality_start}"/></mergeCells>', 1)
    quality_xml = re.sub(r'(conditionalFormatting\b[^>]*\bsqref="A14:G)\d+(")', rf'\g<1>{quality_start + len(quality_rows) - 1}\2', quality_xml)
    mutations[sheets[QUALITY_SHEET].part_name] = quality_xml.encode("utf-8")

    workbook_xml = workbook.parts["xl/workbook.xml"].decode("utf-8")
    workbook_xml = re.sub(r'<calcPr\b[^>]*/>', '<calcPr calcId="191029" calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>', workbook_xml)
    mutations["xl/workbook.xml"] = workbook_xml.encode("utf-8")

    output = compile_parts(source, mutations)
    check = read_xlsx(output, allow_formula_cache=True)
    check_sheets = {sheet.name: sheet for sheet in check.sheets}
    _, check_fields = table_rows(check_sheets[FIELD_SHEET])
    _, check_relations = table_rows(check_sheets[RELATION_SHEET])
    _, check_evidence = table_rows(check_sheets[EVIDENCE_SHEET])
    _, check_traces = table_rows(check_sheets[TRACE_SHEET])
    oracle_check = [row["values"] for row in check_relations if str(row["values"]["relation_id"]).startswith("REL.APP.ORACLE_EBS.")]
    if (len(check_fields), len(check_relations), len(check_evidence), len(check_traces), len(oracle_check)) != (257, 118, 23, 269, 12):
        fail("generated V8 counts drifted")
    if sum(row["link_required_higher"] == "Y" for row in oracle_check) != 11 or sum(row["link_required_lower"] == "Y" for row in oracle_check) != 7:
        fail("generated Oracle EBS link counts drifted")
    if any(row["catalog_present_higher"] != "Y" or row["catalog_present_lower"] != "Y" for row in oracle_check):
        fail("generated Oracle EBS catalog parity drifted")
    lower_na = {row["risk_field_id"] for row in oracle_check if row["classification_lower"] == "ClassificationNA"}
    if lower_na != {"P1.RISK.APP.ORACLE_EBS.RAITCOR002", "P1.RISK.APP.ORACLE_EBS.RAITCOR011"}:
        fail(f"generated Oracle EBS Lower ClassificationNA drifted: {sorted(lower_na)}")
    return output


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--v8", type=pathlib.Path, default=DEFAULT_V8)
    parser.add_argument("--it-risk", type=pathlib.Path, default=DEFAULT_IT_RISK)
    parser.add_argument("--v5-source", type=pathlib.Path, default=DEFAULT_V5_SOURCE)
    parser.add_argument("--v5-managed", type=pathlib.Path, default=DEFAULT_V5_MANAGED)
    parser.add_argument("--expected-v8-sha256", default="")
    parser.add_argument("--expected-v5-sha256", default="")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    if sys.version_info[:3] != (3, 13, 14):
        fail(f"release CPython 3.13.14 is required, got {sys.version.split()[0]}")
    v8_path, v5_source_path, v5_managed_path = args.v8.resolve(), args.v5_source.resolve(), args.v5_managed.resolve()
    v8_source = v8_path.read_bytes()
    v5_source, v5_managed = v5_source_path.read_bytes(), v5_managed_path.read_bytes()
    if v5_source != v5_managed:
        fail("source_files and managed V5 bytes differ before governance")
    if args.apply:
        if not args.expected_v8_sha256 or not args.expected_v5_sha256:
            fail("--apply requires both expected SHA-256 CAS values")
        if digest(v8_source) != args.expected_v8_sha256.upper():
            fail(f"V8 CAS mismatch: expected {args.expected_v8_sha256.upper()}, got {digest(v8_source)}")
        if digest(v5_source) != args.expected_v5_sha256.upper():
            fail(f"V5 CAS mismatch: expected {args.expected_v5_sha256.upper()}, got {digest(v5_source)}")

    scope_rows, template_sha = parse_scope_workbook(args.it_risk.resolve())
    v5_output = clean_v5(v5_source)
    v8_output = build_v8(v8_source, scope_rows, template_sha)
    if args.apply:
        if v5_output != v5_source:
            atomic_write(v5_source_path, v5_output)
            atomic_write(v5_managed_path, v5_output)
        if v8_output != v8_source:
            atomic_write(v8_path, v8_output)
    report = {
        "schemaVersion": "omnia.oracle-ebs-governance-transform-report/v1", "applied": args.apply,
        "python": sys.version.split()[0], "v8InputSha256": digest(v8_source), "v8OutputSha256": digest(v8_output),
        "v5InputSha256": digest(v5_source), "v5OutputSha256": digest(v5_output), "itRiskSha256": template_sha,
        "fields": 257, "relations": 118, "evidence": 23, "traces": 269,
        "oracle": {"fields": 18, "relations": 12, "higherRequired": 11, "lowerRequired": 7,
                   "liveRelationReadback": "blocked_pending_live_relation_readback_non_execution_metadata"},
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
