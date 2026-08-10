"""Generate deterministic TEST workbooks from an installed Create & Associate package.

The script only patches declared data-entry cells in the signed package's managed
V5 template, then runs that same installed package's parser, validator, and plan
compiler.  It never calls Omnia and never treats offline validation as a live
canary.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any


MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
XML_NS = "http://www.w3.org/XML/1998/namespace"
ET.register_namespace("", MAIN_NS)


def require(condition: object, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def atomic_write(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}.", delete=False) as output:
            temporary_path = Path(output.name)
            output.write(value)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_path, path)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def patch_workbook(source: bytes, cells: dict[str, str]) -> bytes:
    source_buffer = io.BytesIO(source)
    output_buffer = io.BytesIO()
    patched: set[str] = set()
    with zipfile.ZipFile(source_buffer, "r") as archive, zipfile.ZipFile(
        output_buffer, "w", zipfile.ZIP_DEFLATED
    ) as output:
        for info in archive.infolist():
            data = archive.read(info.filename)
            if info.filename.startswith("xl/worksheets/") and info.filename.endswith(".xml"):
                root = ET.fromstring(data)
                present = {cell.get("r") for cell in root.findall(f".//{{{MAIN_NS}}}c")}
                relevant = set(cells).intersection(present)
                for address in relevant:
                    cell = root.find(f".//{{{MAIN_NS}}}c[@r='{address}']")
                    require(cell is not None, f"Managed template cell is absent: {address}")
                    for child in list(cell):
                        cell.remove(child)
                    cell.set("t", "inlineStr")
                    inline = ET.SubElement(cell, f"{{{MAIN_NS}}}is")
                    text = ET.SubElement(inline, f"{{{MAIN_NS}}}t")
                    value = cells[address]
                    if value != value.strip():
                        text.set(f"{{{XML_NS}}}space", "preserve")
                    text.text = value
                    patched.add(address)
                if relevant:
                    data = ET.tostring(root, encoding="utf-8", xml_declaration=True)
            output.writestr(info, data)
    missing = sorted(set(cells) - patched)
    require(not missing, f"Managed template did not expose acceptance cells: {missing}")
    return output_buffer.getvalue()


def core_mode_cells(
    prefix: str, workspace: str, mode: str
) -> tuple[dict[str, str], dict[str, dict[str, Any]]]:
    suffix = "H" if mode == "Higher" else "L"
    app = f"{prefix}-APP-{suffix}"
    database = f"{prefix}-DB-{suffix}"
    operating_system = f"{prefix}-OS-{suffix}"
    network = f"{prefix}-DCNO-{suffix}"
    tool = f"{prefix}-TOOL-{suffix}"
    description = (
        "Processes explicitly identified key financial data."
        if mode == "Higher"
        else "Contains no key data according to the supplied assessment text."
    )
    cells = {
        "B23": app, "C23": "Generic", "D23": mode, "E23": description, "F23": workspace,
        "B30": database, "C30": "SQL", "D30": workspace, "E30": app,
        "B35": operating_system, "C35": "WIN", "D35": workspace, "E35": app,
        "B40": network, "C40": "网络", "D40": workspace, "E40": app,
        "B46": tool, "C46": "工单工具", "D46": mode, "E46": workspace, "F46": app,
    }
    expected = {
        app: {"kind": "APP", "rait": mode, "dependencies": []},
        database: {"kind": "DB", "rait": mode, "dependencies": [app]},
        operating_system: {"kind": "OS", "rait": mode, "dependencies": [app]},
        network: {"kind": "DCNO", "rait": mode, "dependencies": [app]},
        tool: {"kind": "TOOL", "rait": mode, "dependencies": [app]},
    }
    return cells, expected


def oracle_ebs_cells(prefix: str, workspace: str) -> tuple[dict[str, str], dict[str, dict[str, Any]]]:
    higher = f"{prefix}-OEBS-H"
    lower = f"{prefix}-OEBS-L"
    cells = {
        "B23": higher, "C23": "Oracle EBS", "D23": "Higher",
        "E23": "Processes explicitly identified key financial data.", "F23": workspace,
        "B24": lower, "C24": "Oracle EBS", "D24": "Lower",
        "E24": "Contains no key data according to the supplied assessment text.", "F24": workspace,
    }
    expected = {
        higher: {"kind": "APP", "rait": "Higher", "dependencies": [], "catalog": 12, "required": 11},
        lower: {"kind": "APP", "rait": "Lower", "dependencies": [], "catalog": 12, "required": 7},
    }
    return cells, expected


def subtype_batch_cells(
    prefix: str,
    workspace: str,
    mode: str,
    app_type: str,
    database_type: str,
    operating_system_type: str,
    tool_type: str,
    include_dcno: bool,
) -> tuple[dict[str, str], dict[str, dict[str, Any]]]:
    """Build one dependency-closed batch without duplicating execution engines.

    Every optional infrastructure/tool row points to the batch APP.  Calling the
    function repeatedly with different signed enum values covers the supported
    content matrix while continuing to use the production parser and planner.
    """
    suffix = "H" if mode == "Higher" else "L"
    app = f"{prefix}-APP-{suffix}"
    description = (
        "Processes explicitly identified key financial data."
        if mode == "Higher"
        else "Contains no key data according to the supplied assessment text."
    )
    cells = {
        "B23": app,
        "C23": app_type,
        "D23": mode,
        "E23": description,
        "F23": workspace,
    }
    expected: dict[str, dict[str, Any]] = {
        app: {"kind": "APP", "rait": mode, "dependencies": []},
    }
    optional_rows = (
        ("DB", database_type, "B30", "C30", "D30", "E30"),
        ("OS", operating_system_type, "B35", "C35", "D35", "E35"),
    )
    for kind, content_type, id_cell, type_cell, workspace_cell, relation_cell in optional_rows:
        if not content_type:
            continue
        element_id = f"{prefix}-{kind}-{suffix}"
        cells.update({
            id_cell: element_id,
            type_cell: content_type,
            workspace_cell: workspace,
            relation_cell: app,
        })
        expected[element_id] = {"kind": kind, "rait": mode, "dependencies": [app]}
    if include_dcno:
        network = f"{prefix}-DCNO-{suffix}"
        cells.update({"B40": network, "C40": "网络", "D40": workspace, "E40": app})
        expected[network] = {"kind": "DCNO", "rait": mode, "dependencies": [app]}
    if tool_type:
        tool = f"{prefix}-TOOL-{suffix}"
        cells.update({
            "B46": tool,
            "C46": tool_type,
            "D46": mode,
            "E46": workspace,
            "F46": app,
        })
        expected[tool] = {"kind": "TOOL", "rait": mode, "dependencies": [app]}
    return cells, expected


def require_signed_enum(
    governance: dict[str, Any], kind: str, raw_field_key: str, value: str
) -> None:
    if not value:
        return
    fields = governance.get("kindRegistry", {}).get(kind, {}).get("reviewFields", [])
    field = next((item for item in fields if item.get("rawFieldKey") == raw_field_key), None)
    allowed = field.get("allowedValues", []) if isinstance(field, dict) else []
    require(value in allowed, f"{kind} content value is not in signed governance: {value!r}")


def validate_with_installed_package(
    package_root: Path,
    workbook: bytes,
    expected: dict[str, dict[str, Any]],
    source_id: str,
) -> dict[str, Any]:
    python_root = package_root / "python"
    require(python_root.is_dir(), f"Installed package Python root is absent: {python_root}")
    sys.path.insert(0, str(python_root))
    try:
        from engine import parse_workbook, validate_ir  # type: ignore[import-not-found]
        from plan_ir import build_plan_ir  # type: ignore[import-not-found]
    finally:
        sys.path.pop(0)

    governance = json.loads((package_root / "backend" / "governance.json").read_text(encoding="utf-8"))
    parsed = validate_ir(parse_workbook(workbook, source_artifact_id=source_id, governance=governance))
    blocking = [
        {"code": issue.get("code"), "message": issue.get("message"), "fieldKey": issue.get("fieldKey")}
        for issue in parsed.get("issues", [])
        if issue.get("state") in {"blocking", "needs_input"}
    ]
    require(not blocking, f"Acceptance workbook has blocking local issues: {blocking}")
    plan = build_plan_ir(parsed=parsed, governance=governance)
    rows = {row["object"]["externalId"]: row for row in plan["rows"]}
    require(set(rows) == set(expected), f"Acceptance row inventory drifted: {sorted(rows)}")
    parsed_by_key = {row["rowKey"]: row for row in parsed["rows"]}
    summary: list[dict[str, Any]] = []
    for element_id, contract in expected.items():
        row = rows[element_id]
        dependencies = sorted(parsed_by_key[key]["elementId"] for key in row["dependencyRowKeys"])
        require(row["kind"] == contract["kind"], f"{element_id} kind drifted: {row['kind']}")
        require(row["status"] == "ready_for_remote_preflight", f"{element_id} is not ready: {row['status']}")
        require(row["rait"]["value"] == contract["rait"], f"{element_id} RAIT drifted: {row['rait']}")
        require(dependencies == sorted(contract["dependencies"]), f"{element_id} dependencies drifted: {dependencies}")
        intents = row["returnIntents"]
        if "catalog" in contract:
            require(len(intents["riskControlCatalogRelations"]) == contract["catalog"], f"{element_id} catalog count drifted")
            require(len(intents["riskControlRelations"]) == contract["required"], f"{element_id} required count drifted")
        summary.append({
            "elementId": element_id,
            "kind": row["kind"],
            "rait": row["rait"]["value"],
            "dependencies": dependencies,
            "status": row["status"],
            "riskControlCatalog": len(intents["riskControlCatalogRelations"]),
            "riskControlRequired": len(intents["riskControlRelations"]),
        })
    return {
        "schemaVersion": "omnia.create-associate.acceptance-workbook-validation/v1",
        "validationScope": "offline-installed-package-parser-validator-plan-only",
        "liveOmniaCanary": False,
        "packageVersion": json.loads((package_root / "manifest.json").read_text(encoding="utf-8"))["version"],
        "governanceSourceSha256": governance["sourceSha256"],
        "rows": summary,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package-root", type=Path, required=True)
    parser.add_argument(
        "--profile",
        choices=("core-higher", "core-lower", "oracle-ebs", "subtype-batch"),
        required=True,
    )
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--mode", choices=("Higher", "Lower"))
    parser.add_argument("--app-type")
    parser.add_argument("--db-type", default="")
    parser.add_argument("--os-type", default="")
    parser.add_argument("--tool-type", default="")
    parser.add_argument("--include-dcno", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    require(sys.version_info[:3] == (3, 13, 14), f"Release CPython 3.13.14 is required, got {sys.version.split()[0]}")
    args = parse_args()
    package_root = args.package_root.resolve()
    workspace = args.workspace.strip()
    prefix = args.prefix.strip().upper()
    require(workspace and len(workspace) <= 128, "Workspace must be a non-empty value of at most 128 characters.")
    require(re.fullmatch(r"[A-Z0-9][A-Z0-9-]{2,23}", prefix), "Prefix must be 3-24 uppercase letters, digits, or hyphens.")
    template_path = package_root / "backend" / "Phase1-用户填写模板V5.xlsx"
    template = template_path.read_bytes()
    governance = json.loads((package_root / "backend" / "governance.json").read_text(encoding="utf-8"))
    if args.profile == "core-higher":
        cells, expected = core_mode_cells(prefix, workspace, "Higher")
    elif args.profile == "core-lower":
        cells, expected = core_mode_cells(prefix, workspace, "Lower")
    elif args.profile == "oracle-ebs":
        cells, expected = oracle_ebs_cells(prefix, workspace)
    else:
        require(args.mode is not None, "--mode is required for subtype-batch")
        require(args.app_type is not None and args.app_type.strip(), "--app-type is required for subtype-batch")
        app_type = args.app_type.strip()
        database_type = args.db_type.strip()
        operating_system_type = args.os_type.strip()
        tool_type = args.tool_type.strip()
        require_signed_enum(governance, "APP", "APP类型", app_type)
        require_signed_enum(governance, "DB", "DB 类型", database_type)
        require_signed_enum(governance, "OS", "OS 类型", operating_system_type)
        require_signed_enum(governance, "TOOL", "Tool 类型", tool_type)
        if args.include_dcno:
            require_signed_enum(governance, "DCNO", "DCNO 类型", "网络")
        cells, expected = subtype_batch_cells(
            prefix,
            workspace,
            args.mode,
            app_type,
            database_type,
            operating_system_type,
            tool_type,
            args.include_dcno,
        )
    workbook = patch_workbook(template, cells)
    validation = validate_with_installed_package(package_root, workbook, expected, f"acceptance:{args.profile}:{prefix}")
    validation.update({
        "profile": args.profile,
        "workspace": workspace,
        "templateSha256": sha256_bytes(template),
        "workbookSha256": sha256_bytes(workbook),
    })
    if args.profile == "subtype-batch":
        validation["matrix"] = {
            "mode": args.mode,
            "appType": args.app_type.strip(),
            "dbType": args.db_type.strip(),
            "osType": args.os_type.strip(),
            "toolType": args.tool_type.strip(),
            "dcno": args.include_dcno,
        }
    output = args.output.resolve()
    atomic_write(output, workbook)
    validation_path = output.with_suffix(output.suffix + ".validation.json")
    atomic_write(validation_path, (json.dumps(validation, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    print(json.dumps({"output": str(output), "validation": str(validation_path), **validation}, ensure_ascii=False))


if __name__ == "__main__":
    main()
