"""Bounded, standard-library-only XLSX/OOXML reader and deterministic compiler."""

from __future__ import annotations

import io
import posixpath
import re
import zipfile
from collections.abc import Mapping
from dataclasses import dataclass
from typing import BinaryIO, Final
from xml.etree import ElementTree as ET

from errors import EngineError, require

MAX_CONTAINER_BYTES: Final = 64 * 1024 * 1024
MAX_ENTRY_BYTES: Final = 32 * 1024 * 1024
MAX_TOTAL_INFLATED: Final = 128 * 1024 * 1024
MAX_ENTRIES: Final = 2048
MAX_COMPRESSION_RATIO: Final = 100

_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
_DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_CELL_REF = re.compile(r"^([A-Z]+)([1-9][0-9]*)$")


@dataclass(frozen=True)
class Worksheet:
    name: str
    part_name: str
    rows: dict[int, list[str]]


@dataclass(frozen=True)
class Workbook:
    parts: dict[str, bytes]
    sheets: tuple[Worksheet, ...]


def read_bounded(source: bytes | bytearray | memoryview | BinaryIO, *, limit: int = MAX_CONTAINER_BYTES) -> bytes:
    if isinstance(source, (bytes, bytearray, memoryview)):
        data = bytes(source)
    elif hasattr(source, "read"):
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = source.read(min(1024 * 1024, limit + 1 - total))
            if chunk in (b"", None):
                break
            require(isinstance(chunk, (bytes, bytearray, memoryview)), "INPUT.BINARY_REQUIRED", "Workbook handle must return bytes.")
            total += len(chunk)
            if total > limit:
                raise EngineError("INPUT.SIZE_EXCEEDED", f"Workbook exceeds {limit} bytes.")
            chunks.append(bytes(chunk))
        data = b"".join(chunks)
    else:
        raise EngineError("INPUT.BINARY_REQUIRED", "Workbook input must be bytes or a readable binary handle.")
    require(0 < len(data) <= limit, "INPUT.SIZE_INVALID", f"Workbook size must be between 1 and {limit} bytes.")
    return data


def read_xlsx(source: bytes | bytearray | memoryview | BinaryIO, *, allow_formula_cache: bool = False) -> Workbook:
    parts = read_zip_parts(read_bounded(source))
    required = ("[Content_Types].xml", "xl/workbook.xml", "xl/_rels/workbook.xml.rels")
    for name in required:
        require(name in parts, "WORKBOOK.REQUIRED_PART_MISSING", f"Required OOXML part is missing: {name}.")
    shared = _shared_strings(parts.get("xl/sharedStrings.xml"))
    workbook_root = _parse_xml(parts["xl/workbook.xml"], "WORKBOOK.XML_INVALID")
    rel_root = _parse_xml(parts["xl/_rels/workbook.xml.rels"], "WORKBOOK.RELS_INVALID")
    relationships: dict[str, str] = {}
    for rel in rel_root.findall(f"{{{_REL_NS}}}Relationship"):
        rel_id, target = rel.get("Id", ""), rel.get("Target", "")
        if rel_id and target and rel.get("TargetMode", "Internal") != "External":
            relationships[rel_id] = _resolve_part("xl/workbook.xml", target)
    sheets: list[Worksheet] = []
    sheet_parent = workbook_root.find(f"{{{_SHEET_NS}}}sheets")
    require(sheet_parent is not None, "WORKBOOK.SHEET_DIRECTORY_MISSING", "Workbook has no sheet directory.")
    for node in sheet_parent.findall(f"{{{_SHEET_NS}}}sheet"):
        name = node.get("name", "")
        rel_id = node.get(f"{{{_DOC_REL_NS}}}id", "")
        part_name = relationships.get(rel_id, "")
        require(name and part_name, "WORKBOOK.SHEET_RELATION_MISSING", f"Worksheet relationship is missing for {name or '(unnamed)' }.")
        require(part_name in parts, "WORKBOOK.SHEET_PART_MISSING", f"Worksheet part is missing for {name}.")
        rows = _worksheet_rows(parts[part_name], shared, allow_formula_cache=allow_formula_cache)
        sheets.append(Worksheet(name=name, part_name=part_name, rows=rows))
    require(sheets, "WORKBOOK.SHEET_DIRECTORY_MISSING", "XLSX workbook contains no readable worksheets.")
    return Workbook(parts=parts, sheets=tuple(sheets))


def read_zip_parts(data: bytes) -> dict[str, bytes]:
    require(len(data) >= 22, "WORKBOOK.INVALID_ZIP", "XLSX ZIP container is too small.")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data), "r")
    except (zipfile.BadZipFile, OSError) as exc:
        raise EngineError("WORKBOOK.INVALID_ZIP", "XLSX ZIP container is invalid.") from exc
    parts: dict[str, bytes] = {}
    total = 0
    infos = archive.infolist()
    require(0 < len(infos) <= MAX_ENTRIES, "WORKBOOK.ZIP_ENTRY_LIMIT", f"XLSX must contain 1..{MAX_ENTRIES} parts.")
    for info in infos:
        name = _safe_part_name(info.filename)
        require(name not in parts, "WORKBOOK.DUPLICATE_PART", f"Duplicate OOXML part: {name}.")
        require(not (info.flag_bits & 0x1), "WORKBOOK.ENCRYPTED_PART", f"Encrypted OOXML part is unsupported: {name}.")
        require(info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "WORKBOOK.UNSUPPORTED_COMPRESSION", f"Unsupported compression for {name}.")
        require(info.file_size <= MAX_ENTRY_BYTES and info.compress_size <= MAX_ENTRY_BYTES, "WORKBOOK.ZIP_BOMB", f"OOXML part exceeds size limit: {name}.")
        if info.compress_size:
            require(info.file_size / info.compress_size <= MAX_COMPRESSION_RATIO, "WORKBOOK.ZIP_BOMB", f"OOXML part exceeds compression ratio: {name}.")
        total += info.file_size
        require(total <= MAX_TOTAL_INFLATED, "WORKBOOK.ZIP_BOMB", "XLSX total inflated size exceeds 128 MiB.")
        try:
            content = archive.read(info)
        except (RuntimeError, zipfile.BadZipFile, OSError) as exc:
            raise EngineError("WORKBOOK.PART_READ_FAILED", f"Failed to read OOXML part: {name}.") from exc
        require(len(content) == info.file_size, "WORKBOOK.PART_SIZE_DRIFT", f"OOXML part size drifted: {name}.")
        parts[name] = content
    archive.close()
    return parts


def compile_parts(base: bytes | bytearray | memoryview | BinaryIO, mutations: Mapping[str, bytes]) -> bytes:
    """Replace/add only explicitly declared parts; unchanged part payloads remain byte-identical."""
    original = read_zip_parts(read_bounded(base))
    normalized: dict[str, bytes] = {}
    for raw_name, value in mutations.items():
        name = _safe_part_name(raw_name)
        require(isinstance(value, bytes), "COMPILE.PART_BYTES_REQUIRED", f"Mutation for {name} must be bytes.")
        require(len(value) <= MAX_ENTRY_BYTES, "COMPILE.PART_SIZE_EXCEEDED", f"Mutation for {name} exceeds size limit.")
        normalized[name] = value
    require(normalized, "COMPILE.NO_DECLARED_PARTS", "At least one declared OOXML part mutation is required.")
    final = dict(original)
    final.update(normalized)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9, strict_timestamps=True) as archive:
        for name in sorted(final):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            info.create_system = 3
            archive.writestr(info, final[name], compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    result = output.getvalue()
    require(len(result) <= MAX_CONTAINER_BYTES, "COMPILE.OUTPUT_SIZE_EXCEEDED", "Compiled workbook exceeds 64 MiB.")
    verified = read_zip_parts(result)
    for name, value in original.items():
        if name not in normalized:
            require(verified.get(name) == value, "COMPILE.UNDECLARED_PART_DRIFT", f"Undeclared OOXML part changed: {name}.")
    for name, value in normalized.items():
        require(verified.get(name) == value, "COMPILE.DECLARED_PART_DRIFT", f"Declared OOXML part was not written exactly: {name}.")
    return result


def _safe_part_name(name: str) -> str:
    require(isinstance(name, str) and name != "", "WORKBOOK.PART_NAME_INVALID", "OOXML part name is empty.")
    normalized = name.replace("\\", "/").lstrip("/")
    require(normalized == posixpath.normpath(normalized), "WORKBOOK.PART_NAME_INVALID", f"Unsafe OOXML part name: {name}.")
    require(not normalized.startswith("../") and "/../" not in normalized and "\x00" not in normalized, "WORKBOOK.PART_NAME_INVALID", f"Unsafe OOXML part name: {name}.")
    return normalized


def _resolve_part(source: str, target: str) -> str:
    if target.startswith("/"):
        resolved = target.lstrip("/")
    else:
        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(source), target))
    return _safe_part_name(resolved)


def _parse_xml(data: bytes, code: str) -> ET.Element:
    require(len(data) <= MAX_ENTRY_BYTES, code, "OOXML XML part exceeds size limit.")
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise EngineError("WORKBOOK.XML_DTD_FORBIDDEN", "OOXML XML parts may not contain DTD/entity declarations.")
    try:
        return ET.fromstring(data)
    except ET.ParseError as exc:
        raise EngineError(code, "OOXML XML part is malformed.") from exc


def _shared_strings(data: bytes | None) -> tuple[str, ...]:
    if data is None:
        return ()
    root = _parse_xml(data, "WORKBOOK.SHARED_STRINGS_INVALID")
    values: list[str] = []
    for item in root.findall(f"{{{_SHEET_NS}}}si"):
        values.append("".join(node.text or "" for node in item.iter(f"{{{_SHEET_NS}}}t")))
    return tuple(values)


def _column_index(reference: str) -> int:
    match = _CELL_REF.match(reference)
    require(match is not None, "WORKBOOK.CELL_REFERENCE_INVALID", f"Invalid cell reference: {reference or '(empty)'}.")
    value = 0
    for char in match.group(1):
        value = value * 26 + ord(char) - 64
    require(value <= 16_384, "WORKBOOK.COLUMN_LIMIT_EXCEEDED", f"Cell column exceeds XLSX limit: {reference}.")
    return value - 1


def _worksheet_rows(data: bytes, shared: tuple[str, ...], *, allow_formula_cache: bool) -> dict[int, list[str]]:
    root = _parse_xml(data, "WORKBOOK.WORKSHEET_XML_INVALID")
    rows: dict[int, list[str]] = {}
    sheet_data = root.find(f"{{{_SHEET_NS}}}sheetData")
    if sheet_data is None:
        return rows
    implicit_row = 0
    for row in sheet_data.findall(f"{{{_SHEET_NS}}}row"):
        row_number = int(row.get("r") or implicit_row + 1)
        require(1 <= row_number <= 1_048_576, "WORKBOOK.ROW_LIMIT_EXCEEDED", "Worksheet row exceeds XLSX limit.")
        implicit_row = row_number
        values: list[str] = []
        for cell in row.findall(f"{{{_SHEET_NS}}}c"):
            ref = cell.get("r", "")
            index = _column_index(ref)
            while len(values) <= index:
                values.append("")
            formula = cell.find(f"{{{_SHEET_NS}}}f")
            if formula is not None and not allow_formula_cache:
                raise EngineError("WORKBOOK.FORMULA_UNSUPPORTED", f"Formula cell {ref} is unsupported in user input.")
            cell_type = cell.get("t", "")
            if formula is not None and cell_type == "s":
                raise EngineError("WORKBOOK.FORMULA_CACHE_INVALID", f"Formula cell {ref} cannot use a shared-string cached value.")
            value_node = cell.find(f"{{{_SHEET_NS}}}v")
            if cell_type == "inlineStr":
                inline = cell.find(f"{{{_SHEET_NS}}}is")
                value = "" if inline is None else "".join(node.text or "" for node in inline.iter(f"{{{_SHEET_NS}}}t"))
            else:
                value = "" if value_node is None else value_node.text or ""
                if cell_type == "s" and formula is None:
                    try:
                        value = shared[int(value)]
                    except (ValueError, IndexError) as exc:
                        raise EngineError("WORKBOOK.SHARED_STRING_INDEX_INVALID", f"Invalid shared string index in {ref}.") from exc
                elif cell_type == "b":
                    value = "TRUE" if value == "1" else "FALSE"
            values[index] = value
        rows[row_number] = values
    return rows
