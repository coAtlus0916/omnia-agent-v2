#!/usr/bin/env python3
"""Append recorded AD and code-migration-tool governance to the V8 master.

The transform is intentionally bounded to four OOXML table parts.  It keeps all
unmodified package parts byte-identical, verifies the exact pre-transform
digest, and refuses partial/id-colliding inputs.
"""

from __future__ import annotations

import hashlib
import os
import pathlib
import re
import sys
import tempfile


ROOT = pathlib.Path(__file__).resolve().parents[1]
PYTHON_SOURCE = ROOT / "feature-packages" / "create-associate" / "source" / "python"
sys.path.insert(0, str(PYTHON_SOURCE))

from ooxml import compile_parts, read_xlsx  # noqa: E402


WORKBOOK = ROOT / "feature-packages" / "create-associate" / "source" / "managed" / "phase1-system-information-v8.xlsx"
BASE_SHA256 = "CB44EE079D045564454F9A11015E6D2F91CF1C663608C9291CD00F0B1CF76F70"

AD_ARTIFACT = "artifact:7695dde4-5e93-4a10-acae-fc8a67087a35#sha256=e307939bf33a066e1218cded0e22955ce9cb47322d8f57a334011e84fb56045c"
AD_RECORDING = "recording:be62fb35-b396-400e-b63c-d0d258618c9b/observation_31d0257eb861887e764c496f3c95f38e/stream_49b60dadc15c17e583d371c19cae7e44#sha256=1d5177655e6642b17f6ff54b8c6ebcb5216f2b8f91d423055bf36c04b36598f7"
TOOL_ARTIFACT = "artifact:04a5e0aa-bdcd-4b0c-8e6d-469425300633#sha256=6b65ff2db328bc72b7970a43dcfea40d90fa27a6af162fd9adaf8ef53e8f2597"
TOOL_RECORDING = "recording:8f74355b-c1f4-4b1c-a235-e34a06cd9704/observation_0dbdc3ee7ece7749a3066aa213cc8438/stream_29ca9a8b299813b4596e33b7cf2d445e#sha256=208a4dcbbb6311d318e1deaf910f958137e87e18555faf4bff4cfb8e583854fd"


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"[augment-ad-code-migration-v8] {message}")


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


def append_rows(xml: str, rows: list[str], last_row: int, end_column: str) -> str:
    if not re.search(r'</(?:[A-Za-z_][\w.-]*:)?sheetData>', xml):
        fail("worksheet sheetData closing tag is missing")
    updated = re.sub(r'</(?:[A-Za-z_][\w.-]*:)?sheetData>', "".join(rows) + r'</sheetData>', xml, count=1)
    updated = re.sub(
        r'(<(?:[A-Za-z_][\w.-]*:)?dimension\b[^>]*\bref=")([^"]+)(")',
        lambda match: f'{match.group(1)}{match.group(2).split(":")[0]}:{end_column}{last_row}{match.group(3)}',
        updated,
        count=1,
    )
    return updated


def update_table_ref(data: bytes, last_row: int) -> bytes:
    text = data.decode("utf-8")
    text = re.sub(r'(\bref="[A-Z]+\d+:[A-Z]+)\d+(")', rf'\g<1>{last_row}\2', text)
    return text.encode("utf-8")


def atomic_write(path: pathlib.Path, data: bytes) -> None:
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


def copy_values(headers: list[str], source: dict[str, object], overrides: dict[str, object]) -> list[object]:
    values = dict(source)
    values.update(overrides)
    return [values.get(header, "") for header in headers]


def build(source: bytes) -> bytes:
    workbook = read_xlsx(source, allow_formula_cache=True)
    field_sheet, relation_sheet, evidence_sheet, trace_sheet = (
        workbook.sheets[1], workbook.sheets[2], workbook.sheets[3], workbook.sheets[6]
    )
    field_headers, fields = table_rows(field_sheet)
    relation_headers, relations = table_rows(relation_sheet)
    evidence_headers, evidence = table_rows(evidence_sheet)
    trace_headers, traces = table_rows(trace_sheet)
    if (len(fields), len(relations), len(evidence), len(traces)) != (257, 118, 23, 269):
        fail(f"base counts drifted: fields={len(fields)}, relations={len(relations)}, evidence={len(evidence)}, traces={len(traces)}")

    field_by_id = {str(row["values"].get("field_id") or ""): row for row in fields}
    relation_by_id = {str(row["values"].get("relation_id") or ""): row for row in relations}
    target_field_ids = {
        *(f"P1.RISK.OS.AD.{risk}" for risk in ("RAITCOR001", "RAITCOR002", "RAITCOR003", "RAITCOR004", "RAITCOR006", "RAITCOR011")),
        *(f"P1.CONTROL.OS.AD.OS_{number}" for number in ("02", "05", "06", "10")),
        *(f"P1.RISK.TOOL.MIGRATION.{risk}" for risk in ("RAITTOOL002", "RAITTOOL003", "RAITTOOL004")),
        *(f"P1.CONTROL.TOOL.MIGRATION.TOOL_{number}" for number in ("05", "06", "10")),
    }
    target_relation_ids = {
        "REL.OS.AD.RAITCOR001.OS_02", "REL.OS.AD.RAITCOR001.OS_06",
        "REL.OS.AD.RAITCOR003.OS_05", "REL.OS.AD.RAITCOR006.OS_10",
        "REL.TOOL.MIGRATION.RAITTOOL002.TOOL_05", "REL.TOOL.MIGRATION.RAITTOOL002.TOOL_06",
        "REL.TOOL.MIGRATION.RAITTOOL003.TOOL_10",
    }
    if target_field_ids & set(field_by_id) or target_relation_ids & set(relation_by_id):
        fail("target AD/code-migration identities already exist or input is partially transformed")

    def field_source(field_id: str) -> tuple[dict[str, object], str]:
        row = field_by_id.get(field_id)
        if not row:
            fail(f"field template is missing: {field_id}")
        xml = workbook.parts[field_sheet.part_name].decode("utf-8")
        return dict(row["values"]), find_row_xml(xml, int(row["row"]))

    ad_risk_labels = {
        "RAITCOR001": "RAITCOR001｜通用操作系统 - 用户拥有的访问权限超出了执行分配的职责所必需的权限，这可能导致职责分离不当。",
        "RAITCOR002": "RAITCOR002｜通用操作系统 - 通过应用系统层面操作以外的其他方式直接对财务数据进行不适当的更改。",
        "RAITCOR003": "RAITCOR003｜通用操作系统 - 系统配置或更新不足，无法限制正确授权和适当的用户访问系统。",
        "RAITCOR004": "RAITCOR004｜通用操作系统 - 对包含相关自动控制和/或报告逻辑的应用系统或程序进行了不适当的变更。",
        "RAITCOR006": "RAITCOR006｜通用操作系统 - 对系统软件（如操作系统、网络、变更管理软件或访问控制软件）进行了不适当的变更。",
        "RAITCOR011": "RAITCOR011｜通用操作系统 - 生产系统、程序和/或系统任务会导致数据处理不准确、不完整或未经授权。",
    }
    migration_risk_labels = {
        "RAITTOOL002": "RAITTOOL002｜代码迁移工具 - 未经授权的用户可将变更迁移到生产环境中。",
        "RAITTOOL003": "RAITTOOL003｜代码迁移工具 - 将变更发布至生产环境的自动配置可能并未得到适当配置，且未经授权的变更可能会发布至生产环境。",
        "RAITTOOL004": "RAITTOOL004｜代码迁移工具 - 系统中的电子审批不可靠或可能会被修改。",
    }
    ad_control_labels = {
        "OS_02": "OS.02｜及时删除或修改已离职和/或调职用户的访问权限。",
        "OS_05": "OS.05｜通过唯一用户ID和密码或其他方法验证用户是否有权访问系统；密码参数符合公司和/或行业标准。",
        "OS_06": "OS.06｜特权级别访问（例如配置和安全管理员）已获得授权并受到适当限制。",
        "OS_10": "OS.10｜操作系统变更在发布至生产环境之前经过适当测试和批准，包括安全补丁程序。",
    }
    migration_control_labels = {
        "TOOL_05": "TOOL.05｜通过唯一用户ID、密码或其他方法进行身份验证；密码参数符合公司和/或行业标准。",
        "TOOL_06": "TOOL.06｜特权级别访问权限（如安全管理员或配置修改用户）已获得授权并受到适当限制。",
        "TOOL_10": "TOOL.10｜程序或配置变更在发布至生产环境之前经过适当批准和测试（如相关）。",
    }

    new_fields: list[tuple[list[object], str, str]] = []
    ad_risk_templates = {
        "RAITCOR001": "P1.RISK.OS.GENERIC.RAITCOR001", "RAITCOR002": "P1.RISK.APP.GENERIC.RAITCOR002",
        "RAITCOR003": "P1.RISK.OS.GENERIC.RAITCOR003", "RAITCOR004": "P1.RISK.APP.GENERIC.RAITCOR004",
        "RAITCOR006": "P1.RISK.OS.GENERIC.RAITCOR006", "RAITCOR011": "P1.RISK.OS.GENERIC.RAITCOR011",
    }
    for risk, template_id in ad_risk_templates.items():
        source_values, template_xml = field_source(template_id)
        field_id = f"P1.RISK.OS.AD.{risk}"
        trace_id = f"AD.RECORDING.be62fb35.FIELD.{risk}"
        new_fields.append((copy_values(field_headers, source_values, {
            "field_id": field_id, "场景/对象类型": "Risk", "对象子类型/区段": "Operating System Infrastructure / AD（Omnia内容：通用操作系统）",
            "Higher适用": "Y", "Lower适用": "Y", "Omnia UI标准字段名": ad_risk_labels[risk],
            "evidence_type": "recording+api", "v4证据路径+行号": f"{AD_RECORDING}; {AD_ARTIFACT}",
            "证据状态/置信度": "已确认-强", "校验规则": "Higher=Higher; Lower=Lower; riskNumber 必须唯一精确匹配",
            "source_trace_id": trace_id, "备注": "AD 输入只映射到通用操作系统内容；通用操作系统不反向等同于 AD。",
        }), template_xml, trace_id))
    for number in ("02", "05", "06", "10"):
        source_values, template_xml = field_source(f"P1.CONTROL.OS.GENERIC.OS_{number}")
        field_id = f"P1.CONTROL.OS.AD.OS_{number}"
        trace_id = f"AD.RECORDING.be62fb35.FIELD.OS_{number}"
        new_fields.append((copy_values(field_headers, source_values, {
            "field_id": field_id, "场景/对象类型": "Control", "对象子类型/区段": "Operating System Infrastructure / AD（Omnia内容：通用操作系统）",
            "Higher适用": "Y", "Lower适用": "Y", "Omnia UI标准字段名": ad_control_labels[f"OS_{number}"],
            "evidence_type": "recording+api", "v4证据路径+行号": f"{AD_RECORDING}; {AD_ARTIFACT}",
            "证据状态/置信度": "已确认-强", "source_trace_id": trace_id,
            "备注": "录制回读的 AD/通用操作系统 Control；只有治理关系表声明的四条关系可建立。",
        }), template_xml, trace_id))

    for risk in ("RAITTOOL002", "RAITTOOL003", "RAITTOOL004"):
        source_values, template_xml = field_source("P1.RISK.TOOL.TICKET.RAITTOOL001")
        field_id = f"P1.RISK.TOOL.MIGRATION.{risk}"
        trace_id = f"MIGRATION.RECORDING.8f74355b.FIELD.{risk}"
        new_fields.append((copy_values(field_headers, source_values, {
            "field_id": field_id, "场景/对象类型": "Risk", "对象子类型/区段": "IT Tool / 代码迁移工具",
            "Higher适用": "Y", "Lower适用": "Y", "Omnia UI标准字段名": migration_risk_labels[risk],
            "evidence_type": "recording+api", "v4证据路径+行号": f"{TOOL_RECORDING}; {TOOL_ARTIFACT}",
            "证据状态/置信度": "已确认-强", "校验规则": "Higher=Higher; Lower=Lower; riskNumber 必须唯一精确匹配",
            "source_trace_id": trace_id, "备注": "代码迁移工具 Higher/Lower 均评估同一三项 Risk；RAITTOOL004 无 Control 关系。",
        }), template_xml, trace_id))
    migration_control_templates = {"05": "P1.CONTROL.TOOL.TICKET.TOOL_05", "06": "P1.CONTROL.TOOL.TICKET.TOOL_06", "10": "P1.CONTROL.TOOL.IDENTITY.TOOL_10"}
    for number, template_id in migration_control_templates.items():
        source_values, template_xml = field_source(template_id)
        field_id = f"P1.CONTROL.TOOL.MIGRATION.TOOL_{number}"
        trace_id = f"MIGRATION.RECORDING.8f74355b.FIELD.TOOL_{number}"
        new_fields.append((copy_values(field_headers, source_values, {
            "field_id": field_id, "场景/对象类型": "Control", "对象子类型/区段": "IT Tool / 代码迁移工具",
            "Higher适用": "Y", "Lower适用": "Y", "Omnia UI标准字段名": migration_control_labels[f"TOOL_{number}"],
            "evidence_type": "recording+api", "v4证据路径+行号": f"{TOOL_RECORDING}; {TOOL_ARTIFACT}",
            "证据状态/置信度": "已确认-强", "source_trace_id": trace_id,
            "备注": "录制回读的代码迁移工具 Control；Higher/Lower 使用同一精确 Control 身份。",
        }), template_xml, trace_id))
    if {str(values[0]) for values, _, _ in new_fields} != target_field_ids:
        fail("generated field inventory drifted")

    relation_xml = workbook.parts[relation_sheet.part_name].decode("utf-8")
    def relation_template(relation_id: str) -> tuple[dict[str, object], str]:
        row = relation_by_id.get(relation_id)
        if not row:
            fail(f"relation template is missing: {relation_id}")
        return dict(row["values"]), find_row_xml(relation_xml, int(row["row"]))

    relation_specs = [
        ("REL.OS.AD.RAITCOR001.OS_02", "REL.OS.GENERIC.RAITCOR001.OS_02", "P1.RISK.OS.AD.RAITCOR001", ad_risk_labels["RAITCOR001"], "P1.CONTROL.OS.AD.OS_02", ad_control_labels["OS_02"], AD_RECORDING, AD_ARTIFACT, "AD.RECORDING.be62fb35.REL.RAITCOR001.OS_02"),
        ("REL.OS.AD.RAITCOR001.OS_06", "REL.OS.GENERIC.RAITCOR001.OS_06", "P1.RISK.OS.AD.RAITCOR001", ad_risk_labels["RAITCOR001"], "P1.CONTROL.OS.AD.OS_06", ad_control_labels["OS_06"], AD_RECORDING, AD_ARTIFACT, "AD.RECORDING.be62fb35.REL.RAITCOR001.OS_06"),
        ("REL.OS.AD.RAITCOR003.OS_05", "REL.OS.GENERIC.RAITCOR003.OS_05", "P1.RISK.OS.AD.RAITCOR003", ad_risk_labels["RAITCOR003"], "P1.CONTROL.OS.AD.OS_05", ad_control_labels["OS_05"], AD_RECORDING, AD_ARTIFACT, "AD.RECORDING.be62fb35.REL.RAITCOR003.OS_05"),
        ("REL.OS.AD.RAITCOR006.OS_10", "REL.OS.GENERIC.RAITCOR006.OS_10", "P1.RISK.OS.AD.RAITCOR006", ad_risk_labels["RAITCOR006"], "P1.CONTROL.OS.AD.OS_10", ad_control_labels["OS_10"], AD_RECORDING, AD_ARTIFACT, "AD.RECORDING.be62fb35.REL.RAITCOR006.OS_10"),
        ("REL.TOOL.MIGRATION.RAITTOOL002.TOOL_05", "REL.TOOL.TICKET.RAITTOOL001.TOOL_05", "P1.RISK.TOOL.MIGRATION.RAITTOOL002", migration_risk_labels["RAITTOOL002"], "P1.CONTROL.TOOL.MIGRATION.TOOL_05", migration_control_labels["TOOL_05"], TOOL_RECORDING, TOOL_ARTIFACT, "MIGRATION.RECORDING.8f74355b.REL.RAITTOOL002.TOOL_05"),
        ("REL.TOOL.MIGRATION.RAITTOOL002.TOOL_06", "REL.TOOL.TICKET.RAITTOOL001.TOOL_06", "P1.RISK.TOOL.MIGRATION.RAITTOOL002", migration_risk_labels["RAITTOOL002"], "P1.CONTROL.TOOL.MIGRATION.TOOL_06", migration_control_labels["TOOL_06"], TOOL_RECORDING, TOOL_ARTIFACT, "MIGRATION.RECORDING.8f74355b.REL.RAITTOOL002.TOOL_06"),
        ("REL.TOOL.MIGRATION.RAITTOOL003.TOOL_10", "REL.TOOL.IDENTITY.RAITTOOL005.TOOL_10", "P1.RISK.TOOL.MIGRATION.RAITTOOL003", migration_risk_labels["RAITTOOL003"], "P1.CONTROL.TOOL.MIGRATION.TOOL_10", migration_control_labels["TOOL_10"], TOOL_RECORDING, TOOL_ARTIFACT, "MIGRATION.RECORDING.8f74355b.REL.RAITTOOL003.TOOL_10"),
    ]
    new_relations: list[tuple[list[object], str]] = []
    for relation_id, template_id, risk_id, risk_label, control_id, control_label, recording, artifact, trace_id in relation_specs:
        source_values, template_xml = relation_template(template_id)
        object_type = "Operating System Infrastructure / AD（Omnia内容：通用操作系统）" if relation_id.startswith("REL.OS.") else "IT Tool / 代码迁移工具"
        new_relations.append((copy_values(relation_headers, source_values, {
            "relation_id": relation_id, "risk_field_id": risk_id, "Risk标准名": risk_label,
            "control_field_id": control_id, "Control标准名": control_label, "catalog_present_higher": "Y", "catalog_present_lower": "Y",
            "link_required_higher": "Y", "link_required_lower": "Y", "classification_higher": "Higher", "classification_lower": "Lower",
            "执行适用层级": "两者", "适用场景/对象类型": object_type, "是否必需": "条件必需",
            "v4 evidence_type": "recording+api", "证据文件+行号": f"{recording}; {artifact}", "确认状态": "已确认-强",
            "source_trace_id": trace_id, "备注": "Higher 与 Lower 使用同一精确 Risk-Control 关系；目录缺失或不唯一时停止。",
        }), template_xml))
    if {str(values[0]) for values, _ in new_relations} != target_relation_ids:
        fail("generated relation inventory drifted")

    field_xml = workbook.parts[field_sheet.part_name].decode("utf-8")
    field_start = max(int(row["row"]) for row in fields) + 1
    field_rows_xml = [inline_row(field_start + index, values, template) for index, (values, template, _) in enumerate(new_fields)]
    field_last = field_start + len(field_rows_xml) - 1

    relation_start = max(int(row["row"]) for row in relations) + 1
    relation_rows_xml = [inline_row(relation_start + index, values, template) for index, (values, template) in enumerate(new_relations)]
    relation_last = relation_start + len(relation_rows_xml) - 1

    evidence_xml = workbook.parts[evidence_sheet.part_name].decode("utf-8")
    evidence_template = find_row_xml(evidence_xml, int(evidence[-1]["row"]))
    evidence_values = [
        copy_values(evidence_headers, dict(evidence[-1]["values"]), {
            "evidence_id": "V5.RECORDING.AD.20260810", "operation": "AD create/GRA/RAIT/Control relation readback",
            "evidence_type": "recording-artifact", "endpoint/method/connector operation": "Omnia RAP/Risk-Control read APIs captured by Recording",
            "payload/response/DOM": "AD -> 通用操作系统 content; 6 risks; exact OS.02/05/06/10 identities and four enabled relations",
            "调用入口": "Recording 0.4.20 frozen stream", "证据位置": f"{AD_RECORDING}; {AD_ARTIFACT}",
            "适用功能": "Create & Associate / OS AD", "确认状态": "已确认-强", "置信说明": "920 events, 0 dropped; final Lower readback",
            "备注": "AD 单向映射到通用操作系统；Higher/Lower 均使用同一四条 Control 关系。",
        }),
        copy_values(evidence_headers, dict(evidence[-1]["values"]), {
            "evidence_id": "V5.RECORDING.CODE_MIGRATION.20260810", "operation": "Code migration tool create/GRA/RAIT/Control relation readback",
            "evidence_type": "recording-artifact", "endpoint/method/connector operation": "Omnia RAP/Risk-Control read APIs captured by Recording",
            "payload/response/DOM": "代码迁移工具; RAITTOOL002/003/004; exact TOOL.05/06/10 identities and three enabled relations",
            "调用入口": "Recording 0.4.20 frozen stream", "证据位置": f"{TOOL_RECORDING}; {TOOL_ARTIFACT}",
            "适用功能": "Create & Associate / Tool code migration", "确认状态": "已确认-强", "置信说明": "844 events, 0 dropped; final Lower readback",
            "备注": "Higher/Lower 均使用同一三条 Control 关系；RAITTOOL004 无 Control 关系。",
        }),
    ]
    evidence_start = max(int(row["row"]) for row in evidence) + 1
    evidence_rows_xml = [inline_row(evidence_start + index, values, evidence_template) for index, values in enumerate(evidence_values)]
    evidence_last = evidence_start + len(evidence_rows_xml) - 1

    trace_xml = workbook.parts[trace_sheet.part_name].decode("utf-8")
    trace_template = find_row_xml(trace_xml, int(traces[-1]["row"]))
    trace_values = []
    for values, _, trace_id in new_fields:
        field_id = str(values[0])
        is_ad = ".OS.AD." in field_id
        trace_values.append(copy_values(trace_headers, dict(traces[-1]["values"]), {
            "trace_item_id": trace_id,
            "source_file": "recording-artifact/ad-20260810" if is_ad else "recording-artifact/code-migration-20260810",
            "source_sheet": "Recording frozen stream", "source_row": "events=920" if is_ad else "events=844", "行角色": "字段",
            "源对象类型": "OS" if is_ad else "TOOL", "源区段/子类型": "AD / 通用操作系统" if is_ad else "代码迁移工具",
            "源字段/编号": field_id.rsplit(".", 1)[-1], "原始描述/汇总": str(values[6]),
            "原始填写方式/评估": "Higher/Lower", "原始示例/关系": "exact recorded catalog/readback",
            "原始Higher/非AI校验": "Higher", "原始Lower/AI校验": "Lower", "master_field_id": field_id,
            "追溯状态": "已确认-强", "备注": AD_RECORDING if is_ad else TOOL_RECORDING,
        }))
    trace_start = max(int(row["row"]) for row in traces) + 1
    trace_rows_xml = [inline_row(trace_start + index, values, trace_template) for index, values in enumerate(trace_values)]
    trace_last = trace_start + len(trace_rows_xml) - 1

    mutations = {
        field_sheet.part_name: append_rows(field_xml, field_rows_xml, field_last, "V").encode("utf-8"),
        relation_sheet.part_name: append_rows(relation_xml, relation_rows_xml, relation_last, "V").encode("utf-8"),
        evidence_sheet.part_name: append_rows(evidence_xml, evidence_rows_xml, evidence_last, "K").encode("utf-8"),
        trace_sheet.part_name: append_rows(trace_xml, trace_rows_xml, trace_last, "P").encode("utf-8"),
    }
    table_parts = [name for name in workbook.parts if name.startswith("xl/tables/table")]
    refs = {"Phase1FieldMaster": field_last, "RiskControlRelations": relation_last, "V4InterfaceEvidence": evidence_last, "SourceTrace": trace_last}
    for part_name in table_parts:
        text = workbook.parts[part_name].decode("utf-8")
        for table_name, last_row in refs.items():
            if f'name="{table_name}"' in text:
                mutations[part_name] = update_table_ref(workbook.parts[part_name], last_row)
    result = compile_parts(source, mutations)
    check = read_xlsx(result, allow_formula_cache=True)
    _, checked_fields = table_rows(check.sheets[1])
    _, checked_relations = table_rows(check.sheets[2])
    _, checked_evidence = table_rows(check.sheets[3])
    _, checked_traces = table_rows(check.sheets[6])
    if (len(checked_fields), len(checked_relations), len(checked_evidence), len(checked_traces)) != (273, 125, 25, 285):
        fail("generated table counts drifted")
    if target_field_ids != {str(row["values"].get("field_id") or "") for row in checked_fields} & target_field_ids:
        fail("generated field identities are incomplete")
    if target_relation_ids != {str(row["values"].get("relation_id") or "") for row in checked_relations} & target_relation_ids:
        fail("generated relation identities are incomplete")
    return result


def main() -> int:
    source = WORKBOOK.read_bytes()
    if digest(source) != BASE_SHA256:
        fail(f"input digest drifted: {digest(source)}")
    result = build(source)
    atomic_write(WORKBOOK, result)
    print(f"AD/code-migration V8 governance appended: sha256={digest(result)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
