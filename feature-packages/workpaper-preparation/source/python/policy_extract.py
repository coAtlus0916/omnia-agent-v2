"""Deterministic policy-archive (制度) text extraction.

Pure standard-library. Extracts text from .docx (WordprocessingML) and .xlsx
(OOXML via ooxml.read_xlsx) members of a .zip archive. Scanned-image PDFs carry
no text layer and are reported as skipped rather than guessed.
"""

from __future__ import annotations

import base64
import io
import os
import posixpath
import re
import zipfile
from typing import Any
from xml.etree import ElementTree as ET

from errors import EngineError, require
from ooxml import read_xlsx

ARCHIVE_SCHEMA = "omnia.workpaper-policy-archive/v1"
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_MEMBER_BYTES = 32 * 1024 * 1024
MAX_MEMBERS = 200
MAX_EXTRACTED_CHARS = 400_000

_W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def _docx_text(data: bytes) -> str:
    try:
        archive = zipfile.ZipFile(io.BytesIO(data), "r")
        document = archive.read("word/document.xml")
    except (zipfile.BadZipFile, KeyError, OSError) as exc:
        raise EngineError("POLICY.DOCX_INVALID", "制度 docx 文件无法读取。") from exc
    require(len(document) <= MAX_MEMBER_BYTES, "POLICY.DOCX_TOO_LARGE", "制度 docx 超过大小限制。")
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
    workbook = read_xlsx(data, allow_formula_cache=True)
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


def extract_policy_archive(payload: Any) -> dict[str, Any]:
    require(isinstance(payload, dict) and payload.get("schemaVersion") == ARCHIVE_SCHEMA,
            "POLICY.INPUT_INVALID", "制度压缩包输入 schema 无效。")
    zip_path = payload.get("zipPath")
    if isinstance(zip_path, str) and zip_path:
        # Large archives are delivered as a Core-managed artifact handle path
        # (a regular file inside the Feature/Run temp root) to avoid the 1 MiB
        # RPC frame ceiling. Read the bytes directly from that exact file.
        require(os.path.isabs(zip_path), "POLICY.ZIP_PATH_INVALID", "制度压缩包路径无效。")
        try:
            with open(zip_path, "rb") as handle:
                raw = handle.read()
        except OSError as exc:
            raise EngineError("POLICY.ZIP_READ_FAILED", "制度压缩包文件读取失败。") from exc
    else:
        encoded = payload.get("zipBase64")
        require(isinstance(encoded, str) and encoded, "POLICY.ZIP_REQUIRED", "制度压缩包字节缺失。")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as exc:
            raise EngineError("POLICY.ZIP_BASE64_INVALID", "制度压缩包不是有效 base64。") from exc
    require(0 < len(raw) <= MAX_ARCHIVE_BYTES, "POLICY.ZIP_TOO_LARGE", "制度压缩包超过 64 MiB。")
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw), "r")
    except zipfile.BadZipFile as exc:
        raise EngineError("POLICY.ZIP_INVALID", "制度压缩包 ZIP 无效。") from exc

    infos = [info for info in archive.infolist() if not info.is_dir() and not info.filename.endswith("/")]
    require(0 < len(infos) <= MAX_MEMBERS, "POLICY.ZIP_ENTRY_LIMIT", f"制度压缩包成员数超出 1..{MAX_MEMBERS} 限制。")

    documents: list[dict[str, str]] = []
    skipped: list[str] = []
    total_chars = 0
    for info in infos:
        name = _safe_member_name(info.filename)
        original_name = posixpath.basename(name)
        if original_name.startswith(".") or "__MACOSX" in name:
            continue
        lower = original_name.lower()
        data = archive.read(info)
        require(len(data) <= MAX_MEMBER_BYTES, "POLICY.MEMBER_TOO_LARGE", f"制度文件 {original_name} 超过大小限制。")
        if lower.endswith(".docx"):
            text = _docx_text(data)
            kind = "Word"
        elif lower.endswith((".xlsx", ".xlsm")):
            text = _xlsx_text(data)
            kind = "Excel"
        elif lower.endswith(".pdf"):
            # Scanned-image PDFs have no text layer; report skipped, never guess.
            skipped.append(f"{original_name}（扫描 PDF 无文本层，需文本版制度或多模态 AI）")
            continue
        else:
            skipped.append(f"{original_name}（不支持的制度文件类型）")
            continue
        text = text.strip()
        if not text:
            skipped.append(f"{original_name}（未提取到文字）")
            continue
        total_chars += len(text)
        require(total_chars <= MAX_EXTRACTED_CHARS, "POLICY.EXTRACTED_TOO_LARGE", "制度提取文本总量超过限制。")
        documents.append({"name": original_name, "kind": kind, "text": text})

    return {
        "schemaVersion": "omnia.workpaper-policy-extraction/v1",
        "documents": documents,
        "skipped": skipped,
        "documentCount": len(documents),
        "skippedCount": len(skipped),
    }
