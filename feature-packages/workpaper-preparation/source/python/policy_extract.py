"""Deterministic policy-file and recursive policy-archive (制度) extraction.

Pure standard-library. Reads a direct .docx/.xlsx/.xlsm/.pdf input or recursively
extracts those files from a .zip archive. Scanned-image PDFs carry no text layer
and are reported as skipped rather than guessed.
"""

from __future__ import annotations

import base64
import io
import os
import posixpath
import zipfile
from typing import Any
from xml.etree import ElementTree as ET

from errors import EngineError, require
from ooxml import read_workpaper_xlsx

ARCHIVE_SCHEMA = "omnia.workpaper-policy-archive/v1"
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_MEMBER_BYTES = 32 * 1024 * 1024
MAX_MEMBERS = 200
MAX_ARCHIVE_DEPTH = 4
MAX_TOTAL_EXPANDED_BYTES = 128 * 1024 * 1024
MAX_EXTRACTED_CHARS = 400_000
SUPPORTED_COMPRESSION = {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}

_W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def _docx_text(data: bytes) -> str:
    try:
        archive = zipfile.ZipFile(io.BytesIO(data), "r")
        info = archive.getinfo("word/document.xml")
        require(info.compress_type in SUPPORTED_COMPRESSION,
                "POLICY.DOCX_COMPRESSION_UNSUPPORTED", "制度 docx 使用了不支持的压缩算法。")
        require(info.file_size <= MAX_MEMBER_BYTES,
                "POLICY.DOCX_TOO_LARGE", "制度 docx 超过大小限制。")
        document = archive.read(info)
    except (zipfile.BadZipFile, KeyError, OSError) as exc:
        raise EngineError("POLICY.DOCX_INVALID", "制度 docx 文件无法读取。") from exc
    require(len(document) <= MAX_MEMBER_BYTES,
            "POLICY.DOCX_TOO_LARGE", "制度 docx 超过大小限制。")
    try:
        root = ET.fromstring(document)
    except ET.ParseError as exc:
        raise EngineError("POLICY.DOCX_XML_INVALID", "制度 docx XML 无效。") from exc
    paragraphs: list[str] = []
    for paragraph in root.iter(f"{{{_W_NS}}}p"):
        runs = [node.text or "" for node in paragraph.iter(f"{{{_W_NS}}}t")]
        text = "".join(runs).strip()
        if text:
            paragraphs.append(text)
    return "\n".join(paragraphs)


def _xlsx_text(data: bytes) -> str:
    workbook = read_workpaper_xlsx(data, allow_formula_cache=True)
    lines: list[str] = []
    for sheet in workbook.sheets:
        lines.append(f"== {sheet.name} ==")
        for row_number in sorted(sheet.rows):
            values = [value for value in sheet.rows[row_number] if value.strip()]
            if values:
                lines.append("\t".join(values))
    return "\n".join(lines)


def _safe_member_name(name: str) -> str:
    normalized = name.replace("\\", "/").lstrip("/")
    require(normalized == posixpath.normpath(normalized) and not normalized.startswith("../")
            and "/../" not in normalized and "\x00" not in normalized,
            "POLICY.MEMBER_NAME_INVALID", f"制度压缩包成员路径无效：{name}。")
    return normalized


def _archive_label(prefix: str, member_name: str) -> str:
    return posixpath.join(prefix, member_name) if prefix else member_name


def _walk_archive(
    raw: bytes,
    *,
    depth: int,
    prefix: str,
    budget: dict[str, int],
    documents: list[dict[str, str]],
    skipped: list[str],
) -> None:
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw), "r")
    except zipfile.BadZipFile as exc:
        if depth == 0:
            raise EngineError("POLICY.ZIP_INVALID", "制度压缩包 ZIP 无效。") from exc
        skipped.append(f"{prefix}（嵌套 ZIP 无效）")
        return

    infos = [info for info in archive.infolist() if not info.is_dir() and not info.filename.endswith("/")]
    if depth == 0:
        require(infos, "POLICY.ZIP_ENTRY_LIMIT", f"制度压缩包成员数超出 1..{MAX_MEMBERS} 限制。")
    elif not infos:
        skipped.append(f"{prefix}（空压缩包）")
        return

    for info in infos:
        budget["members"] += 1
        require(budget["members"] <= MAX_MEMBERS, "POLICY.ZIP_ENTRY_LIMIT",
                f"制度压缩包递归成员数超出 1..{MAX_MEMBERS} 限制。")
        name = _safe_member_name(info.filename)
        display_name = _archive_label(prefix, name)
        original_name = posixpath.basename(name)
        if original_name.startswith(".") or "__MACOSX" in name.split("/"):
            continue
        require(info.compress_type in SUPPORTED_COMPRESSION, "POLICY.COMPRESSION_UNSUPPORTED",
                f"制度文件 {display_name} 使用了不支持的压缩算法。")
        require(info.file_size <= MAX_MEMBER_BYTES, "POLICY.MEMBER_TOO_LARGE",
                f"制度文件 {display_name} 超过大小限制。")
        try:
            data = archive.read(info)
        except (RuntimeError, zipfile.BadZipFile, OSError) as exc:
            raise EngineError("POLICY.MEMBER_READ_FAILED", f"制度文件 {display_name} 无法读取。") from exc
        require(len(data) <= MAX_MEMBER_BYTES, "POLICY.MEMBER_TOO_LARGE",
                f"制度文件 {display_name} 超过大小限制。")
        budget["expandedBytes"] += len(data)
        require(budget["expandedBytes"] <= MAX_TOTAL_EXPANDED_BYTES, "POLICY.EXPANDED_TOO_LARGE",
                "制度压缩包递归展开后的总大小超过限制。")

        lower = original_name.lower()
        if lower.endswith(".zip"):
            if depth >= MAX_ARCHIVE_DEPTH:
                skipped.append(f"{display_name}（嵌套 ZIP 超过 {MAX_ARCHIVE_DEPTH} 层限制）")
                continue
            _walk_archive(data, depth=depth + 1, prefix=display_name, budget=budget,
                          documents=documents, skipped=skipped)
            continue
        if lower.endswith(".docx"):
            extracted = _docx_text(data)
            kind = "Word"
        elif lower.endswith((".xlsx", ".xlsm")):
            extracted = _xlsx_text(data)
            kind = "Excel"
        elif lower.endswith(".pdf"):
            skipped.append(f"{display_name}（扫描 PDF 无文本层，需文本版制度或多模态 AI）")
            continue
        else:
            skipped.append(f"{display_name}（不支持的制度文件类型）")
            continue

        extracted = extracted.strip()
        if not extracted:
            skipped.append(f"{display_name}（未提取到文字）")
            continue
        budget["extractedChars"] += len(extracted)
        require(budget["extractedChars"] <= MAX_EXTRACTED_CHARS, "POLICY.EXTRACTED_TOO_LARGE",
                "制度提取文本总量超过限制。")
        documents.append({"name": display_name, "kind": kind, "text": extracted})


def extract_policy_archive(payload: Any) -> dict[str, Any]:
    require(isinstance(payload, dict) and payload.get("schemaVersion") == ARCHIVE_SCHEMA,
            "POLICY.INPUT_INVALID", "制度压缩包输入 schema 无效。")
    zip_path = payload.get("zipPath")
    if isinstance(zip_path, str) and zip_path:
        require(os.path.isabs(zip_path), "POLICY.ZIP_PATH_INVALID", "制度压缩包路径无效。")
        try:
            with open(zip_path, "rb") as handle:
                raw = handle.read()
        except OSError as exc:
            raise EngineError("POLICY.ZIP_READ_FAILED", "制度压缩包文件读取失败。") from exc
    else:
        encoded = payload.get("zipBase64")
        require(isinstance(encoded, str) and encoded,
                "POLICY.ZIP_REQUIRED", "制度压缩包字节缺失。")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as exc:
            raise EngineError("POLICY.ZIP_BASE64_INVALID", "制度压缩包不是有效 base64。") from exc
    require(0 < len(raw) <= MAX_ARCHIVE_BYTES,
            "POLICY.ZIP_TOO_LARGE", "制度压缩包超过 64 MiB。")

    documents: list[dict[str, str]] = []
    skipped: list[str] = []
    budget = {"members": 0, "expandedBytes": 0, "extractedChars": 0}
    source_name = posixpath.basename(str(payload.get("sourceName") or "policy-materials.zip").replace("\\", "/"))
    lower = source_name.lower()
    if lower.endswith(".zip"):
        _walk_archive(raw, depth=0, prefix="", budget=budget, documents=documents, skipped=skipped)
    else:
        require(len(raw) <= MAX_MEMBER_BYTES, "POLICY.MEMBER_TOO_LARGE",
                f"制度文件 {source_name} 超过大小限制。")
        if lower.endswith(".docx"):
            extracted = _docx_text(raw)
            kind = "Word"
        elif lower.endswith((".xlsx", ".xlsm")):
            extracted = _xlsx_text(raw)
            kind = "Excel"
        elif lower.endswith(".pdf"):
            extracted = ""
            kind = "PDF"
            skipped.append(f"{source_name}（扫描 PDF 无文本层，需文本版制度或多模态 AI）")
        else:
            raise EngineError("POLICY.FILE_TYPE_UNSUPPORTED", "制度文件类型不受支持。")
        extracted = extracted.strip()
        if extracted:
            require(len(extracted) <= MAX_EXTRACTED_CHARS, "POLICY.EXTRACTED_TOO_LARGE",
                    "制度提取文本总量超过限制。")
            documents.append({"name": source_name, "kind": kind, "text": extracted})
        elif kind != "PDF":
            skipped.append(f"{source_name}（未提取到文字）")

    return {
        "schemaVersion": "omnia.workpaper-policy-extraction/v1",
        "documents": documents,
        "skipped": skipped,
        "documentCount": len(documents),
        "skippedCount": len(skipped),
    }
