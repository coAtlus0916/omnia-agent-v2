#!/usr/bin/env python3
"""Normalize V8 Risk/Control mode columns from the user-maintained link flags.

The yellow ``link_required_higher`` and ``link_required_lower`` cells remain the
authoritative user input.  This script only derives catalog parity,
classification, execution applicability, and the matching Risk field rule.
It performs a SHA-256 compare-and-swap before writing and changes only explicit
cells in the two governance worksheets.
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
from collections import defaultdict


ROOT = pathlib.Path(__file__).resolve().parents[1]
PYTHON_SOURCE = ROOT / "feature-packages" / "create-associate" / "source" / "python"
sys.path.insert(0, str(PYTHON_SOURCE))

from ooxml import compile_parts, read_xlsx, read_zip_parts  # noqa: E402


FIELD_SHEET = "字段母版"
RELATION_SHEET = "Risk-Control关系"
DEFAULT_INPUT = ROOT / "feature-packages" / "create-associate" / "source" / "managed" / "phase1-system-information-v8.xlsx"


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"[normalize-v8-risk-control-governance] {message}")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def column_name(index: int) -> str:
    value = index + 1
    result = ""
    while value:
        value, remainder = divmod(value - 1, 26)
        result = chr(65 + remainder) + result
    return result


def xml_escape(value: object) -> str:
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def replace_cell(xml: str, row_number: int, column: int, value: str) -> str:
    row_pattern = re.compile(
        r"<(?P<prefix>[A-Za-z_][\w.-]*:)?row\b(?P<attrs>[^>]*)>"
        r"(?P<body>[\s\S]*?)</(?:[A-Za-z_][\w.-]*:)?row>"
    )
    reference = f"{column_name(column)}{row_number}"
    replaced_row = False

    def update_row(match: re.Match[str]) -> str:
        nonlocal replaced_row
        attrs = match.group("attrs")
        if int(re.search(r'\br="(\d+)"', attrs).group(1) if re.search(r'\br="(\d+)"', attrs) else 0) != row_number:
            return match.group(0)
        cell_pattern = re.compile(
            r"<(?P<prefix>[A-Za-z_][\w.-]*:)?c\b(?P<attrs>[^>]*?)"
            r"(?:/>|>(?P<body>[\s\S]*?)</(?:[A-Za-z_][\w.-]*:)?c>)"
        )
        found = False

        def update_cell(cell: re.Match[str]) -> str:
            nonlocal found
            cell_attrs = cell.group("attrs")
            cell_ref = re.search(r'\br="([A-Z]+\d+)"', cell_attrs)
            if not cell_ref or cell_ref.group(1) != reference:
                return cell.group(0)
            found = True
            clean_attrs = re.sub(r'\s+t="[^"]*"', "", cell_attrs)
            prefix = cell.group("prefix") or match.group("prefix") or ""
            return (
                f'<{prefix}c{clean_attrs} t="inlineStr"><{prefix}is><{prefix}t xml:space="preserve">'
                f"{xml_escape(value)}</{prefix}t></{prefix}is></{prefix}c>"
            )

        body = cell_pattern.sub(update_cell, match.group("body"))
        if not found:
            fail(f"target cell is missing: {reference}")
        replaced_row = True
        prefix = match.group("prefix") or ""
        return f"<{prefix}row{attrs}>{body}</{prefix}row>"

    updated = row_pattern.sub(update_row, xml)
    if not replaced_row:
        fail(f"target row is missing: {row_number}")
    return updated


def normalize_flag(value: object) -> str:
    return "Y" if str(value).strip().upper() == "Y" else "N"


def table_rows(sheet, headers: list[str]) -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    for row_number, raw in sorted(sheet.rows.items()):
        if row_number <= 4 or not any(str(value).strip() for value in raw):
            continue
        values = list(raw) + [""] * max(0, len(headers) - len(raw))
        result.append(
            {
                "row": row_number,
                "values": {header: values[index] for index, header in enumerate(headers)},
            }
        )
    return result


def mode_classification(has_links: bool, mode: str) -> str:
    return mode if has_links else "ClassificationNA"


def applicability(higher: str, lower: str) -> str:
    return {
        ("Y", "Y"): "两者",
        ("Y", "N"): "Higher",
        ("N", "Y"): "Lower",
        ("N", "N"): "不建立关联",
    }[(higher, lower)]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=pathlib.Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=pathlib.Path)
    parser.add_argument("--expected-sha256", default="")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--repair-unbound-x", action="store_true")
    args = parser.parse_args()

    input_path = args.input.resolve()
    output_path = (args.output or args.input).resolve()
    source = input_path.read_bytes()
    source_sha = sha256(source)
    expected_sha = args.expected_sha256.strip().upper()
    if args.apply and not expected_sha:
        fail("--apply requires --expected-sha256 for compare-and-swap safety")
    if expected_sha and source_sha != expected_sha:
        fail(f"input SHA mismatch: expected {expected_sha}, got {source_sha}")

    if args.repair_unbound_x:
        if not args.apply:
            fail("--repair-unbound-x requires --apply")
        parts = read_zip_parts(source)
        repairs: dict[str, bytes] = {}
        occurrences = 0
        for part_name, payload in parts.items():
            if not part_name.startswith("xl/worksheets/") or not part_name.endswith(".xml"):
                continue
            xml = payload.decode("utf-8")
            if "<x:" not in xml and "</x:" not in xml:
                continue
            occurrences += xml.count("<x:") + xml.count("</x:")
            repairs[part_name] = xml.replace("<x:", "<").replace("</x:", "</").encode("utf-8")
        if not repairs:
            fail("no unbound x-prefixed worksheet tags were found")
        output = compile_parts(source, repairs)
        output_sha = sha256(output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{output_path.name}.", suffix=".tmp", dir=output_path.parent)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(output)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, output_path)
        finally:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)
        print(json.dumps({
            "schemaVersion": "omnia.v8-ooxml-prefix-repair-report/v1",
            "inputSha256": source_sha,
            "outputSha256": output_sha,
            "repairedParts": sorted(repairs),
            "replacedTagCount": occurrences,
        }, ensure_ascii=False, indent=2))
        return 0

    workbook = read_xlsx(source, allow_formula_cache=True)
    sheets = {sheet.name: sheet for sheet in workbook.sheets}
    if FIELD_SHEET not in sheets or RELATION_SHEET not in sheets:
        fail("required governance worksheets are missing")
    field_sheet = sheets[FIELD_SHEET]
    relation_sheet = sheets[RELATION_SHEET]
    field_headers = list(field_sheet.rows.get(4, []))
    relation_headers = list(relation_sheet.rows.get(4, []))
    required_field_headers = {"field_id", "Higher适用", "Lower适用", "校验规则"}
    required_relation_headers = {
        "relation_id",
        "risk_field_id",
        "catalog_present_lower",
        "link_required_higher",
        "link_required_lower",
        "classification_higher",
        "classification_lower",
        "执行适用层级",
        "备注",
    }
    if not required_field_headers.issubset(field_headers):
        fail("字段母版 headers drifted")
    if not required_relation_headers.issubset(relation_headers):
        fail("Risk-Control关系 headers drifted")

    fields = table_rows(field_sheet, field_headers)
    relations = table_rows(relation_sheet, relation_headers)
    relations_by_risk: dict[str, list[dict[str, object]]] = defaultdict(list)
    for relation in relations:
        values = relation["values"]
        relation_id = str(values["relation_id"])
        risk_field_id = str(values["risk_field_id"])
        if not relation_id.startswith("REL.") or not risk_field_id.startswith("P1.RISK."):
            fail(f"invalid relation identity at row {relation['row']}")
        relations_by_risk[risk_field_id].append(relation)

    changes: list[dict[str, object]] = []

    def set_value(sheet_name: str, row: dict[str, object], header: str, value: str) -> None:
        values = row["values"]
        old = str(values.get(header, ""))
        if old == value:
            return
        values[header] = value
        changes.append({"sheet": sheet_name, "row": row["row"], "column": header, "old": old, "new": value})

    risk_outcomes: dict[str, dict[str, object]] = {}
    for risk_field_id, risk_relations in sorted(relations_by_risk.items()):
        higher_links = any(normalize_flag(item["values"]["link_required_higher"]) == "Y" for item in risk_relations)
        lower_links = any(normalize_flag(item["values"]["link_required_lower"]) == "Y" for item in risk_relations)
        risk_outcomes[risk_field_id] = {
            "higher": mode_classification(higher_links, "Higher"),
            "lower": mode_classification(lower_links, "Lower"),
            "higherLinks": sum(normalize_flag(item["values"]["link_required_higher"]) == "Y" for item in risk_relations),
            "lowerLinks": sum(normalize_flag(item["values"]["link_required_lower"]) == "Y" for item in risk_relations),
        }

    for relation in relations:
        values = relation["values"]
        risk = risk_outcomes[str(values["risk_field_id"])]
        higher = normalize_flag(values["link_required_higher"])
        lower = normalize_flag(values["link_required_lower"])
        set_value(RELATION_SHEET, relation, "catalog_present_lower", "Y")
        set_value(RELATION_SHEET, relation, "classification_higher", str(risk["higher"]))
        set_value(RELATION_SHEET, relation, "classification_lower", str(risk["lower"]))
        set_value(RELATION_SHEET, relation, "执行适用层级", applicability(higher, lower))
        note = str(values.get("备注", ""))
        if "Lower 未录制，N 是执行阻断边界" in note or "未录制 Lower，N 是执行阻断边界" in note:
            set_value(
                RELATION_SHEET,
                relation,
                "备注",
                re.sub(
                    r"(?:Lower 未录制|未录制 Lower)，N 是执行阻断边界[^。]*。?",
                    "Higher/Lower 共享同一精确目录身份；是否关联仅由 link_required_higher/link_required_lower 决定。",
                    note,
                ),
            )

    risk_field_rows: dict[str, dict[str, object]] = {}
    for field in fields:
        field_id = str(field["values"]["field_id"])
        if not field_id.startswith("P1.RISK."):
            continue
        if field_id in risk_field_rows:
            fail(f"duplicate Risk field_id: {field_id}")
        risk_field_rows[field_id] = field
        outcome = risk_outcomes.get(
            field_id,
            {"higher": "ClassificationNA", "lower": "ClassificationNA", "higherLinks": 0, "lowerLinks": 0},
        )
        set_value(FIELD_SHEET, field, "Higher适用", "Y")
        set_value(FIELD_SHEET, field, "Lower适用", "Y")
        set_value(
            FIELD_SHEET,
            field,
            "校验规则",
            f"Higher={outcome['higher']}; Lower={outcome['lower']}; riskNumber 必须唯一精确匹配",
        )
        risk_outcomes[field_id] = outcome

    missing_risk_fields = sorted(set(relations_by_risk) - set(risk_field_rows))
    if missing_risk_fields:
        fail(f"relations reference missing Risk fields: {', '.join(missing_risk_fields)}")

    mutations: dict[str, bytes] = {}
    for sheet, headers, rows in (
        (field_sheet, field_headers, fields),
        (relation_sheet, relation_headers, relations),
    ):
        relevant = [change for change in changes if change["sheet"] == sheet.name]
        if not relevant:
            continue
        xml = workbook.parts[sheet.part_name].decode("utf-8")
        for change in relevant:
            xml = replace_cell(xml, int(change["row"]), headers.index(str(change["column"])), str(change["new"]))
        mutations[sheet.part_name] = xml.encode("utf-8")

    output = compile_parts(source, mutations) if mutations else source
    output_sha = sha256(output)
    report = {
        "schemaVersion": "omnia.v8-risk-control-normalization-report/v1",
        "input": str(input_path),
        "output": str(output_path),
        "inputSha256": source_sha,
        "outputSha256": output_sha,
        "applied": bool(args.apply),
        "fieldCount": len(fields),
        "relationCount": len(relations),
        "riskCount": len(risk_field_rows),
        "changeCount": len(changes),
        "changesByColumn": dict(
            sorted(
                {
                    column: sum(change["column"] == column for change in changes)
                    for column in {str(change["column"]) for change in changes}
                }.items()
            )
        ),
        "classificationNA": {
            "Higher": sorted(field_id for field_id, item in risk_outcomes.items() if item["higher"] == "ClassificationNA"),
            "Lower": sorted(field_id for field_id, item in risk_outcomes.items() if item["lower"] == "ClassificationNA"),
        },
    }
    if args.apply and output != source:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{output_path.name}.", suffix=".tmp", dir=output_path.parent)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(output)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, output_path)
        finally:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
