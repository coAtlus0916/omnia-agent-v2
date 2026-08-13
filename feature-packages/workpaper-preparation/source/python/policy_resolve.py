"""Phase 2 policy index + placeholder extraction + snippet retrieval.

Pure standard-library. Mirrors the v4 policy-index contract: chunk extracted
policy text, index by term frequency, and retrieve the top relevant snippets
for a Control's query fields. Also extracts the 【placeholder】 occurrences
that the policy-AI must resolve.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

from errors import EngineError, require

INDEX_VERSION = 1
CHUNK_CHARACTERS = 4000
CHUNK_OVERLAP = 300
MAX_DOCUMENTS = 100
MAX_DOCUMENT_CHARS = 1_000_000
MAX_TOTAL_CHARS = 6_000_000
MAX_QUERY_CHARS = 20_000

_PLACEHOLDER = re.compile(r"【[^【】]*】")
_HAN = re.compile(r"^[一-鿿]+$")
_TOKEN = re.compile(r"[\w]+", re.UNICODE)


def _normalize(text: str) -> str:
    import unicodedata
    return unicodedata.normalize("NFKC", str(text or "")).replace("\r\n", "\n").replace("\r", "\n")


def _tokenize(value: str) -> list[str]:
    text = _normalize(value).lower()
    tokens: list[str] = []
    for group in _TOKEN.findall(text):
        if _HAN.match(group):
            if len(group) == 1:
                tokens.append(group)
            for i in range(len(group) - 1):
                tokens.append(group[i:i + 2])
        elif len(group) >= 2 or group.isdigit():
            tokens.append(group)
    return tokens


def _term_frequency(tokens: list[str]) -> dict[str, int]:
    result: dict[str, int] = {}
    for token in tokens:
        result[token] = result.get(token, 0) + 1
    return result


def _chunk(text: str) -> list[str]:
    if len(text) <= CHUNK_CHARACTERS:
        return [text]
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + CHUNK_CHARACTERS, len(text))
        if end < len(text):
            boundary = max(text.rfind("\n\n", start, end), text.rfind("\n", start, end),
                           text.rfind("。", start, end), text.rfind(". ", start, end))
            if boundary > start + int(CHUNK_CHARACTERS * 0.6):
                end = boundary + 1
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(text):
            break
        start = max(end - CHUNK_OVERLAP, start + 1)
    return chunks


def build_policy_index(payload: Any) -> dict[str, Any]:
    require(isinstance(payload, dict) and payload.get("schemaVersion") == "omnia.workpaper-policy-index-input/v1",
            "POLICY.INDEX_INPUT_INVALID", "Policy index input schema is invalid.")
    documents = payload.get("documents")
    require(isinstance(documents, list) and 0 < len(documents) <= MAX_DOCUMENTS,
            "POLICY.DOCUMENTS_INVALID", "Policy documents are invalid or exceed the bound.")
    chunks: list[dict[str, Any]] = []
    for index, doc in enumerate(documents):
        require(isinstance(doc, dict), "POLICY.DOCUMENT_INVALID", "Policy document is not an object.")
        name = str(doc.get("name") or "").strip()
        text = _normalize(doc.get("text") or "")
        require(name and text, "POLICY.DOCUMENT_TEXT_EMPTY", "Policy document text is empty.")
        require(len(text) <= MAX_DOCUMENT_CHARS, "POLICY.DOCUMENT_TOO_LARGE", "Policy document text exceeds the bound.")
        source_sha256 = hashlib.sha256(text.encode("utf-8")).hexdigest()
        for ordinal, part in enumerate(_chunk(text)):
            chunks.append({
                "snippetId": hashlib.sha256(f"{name}\0{ordinal}\0{part}".encode("utf-8")).hexdigest(),
                "documentName": name,
                "sourceFileSha256": source_sha256,
                "ordinal": ordinal,
                "text": part,
                "terms": _term_frequency(_tokenize(part)),
            })
    require(chunks, "POLICY.INDEX_EMPTY", "Policy documents contain no indexable text.")
    document_frequency: dict[str, int] = {}
    for chunk in chunks:
        for term in chunk["terms"]:
            document_frequency[term] = document_frequency.get(term, 0) + 1
    return {
        "schemaVersion": "omnia.workpaper-policy-index/v1",
        "version": INDEX_VERSION,
        "chunks": chunks,
        "documentFrequency": document_frequency,
        "chunkCount": len(chunks),
    }


def retrieve_policy_snippets(payload: Any) -> dict[str, Any]:
    require(isinstance(payload, dict) and payload.get("schemaVersion") == "omnia.workpaper-policy-retrieve-input/v1",
            "POLICY.RETRIEVE_INPUT_INVALID", "Policy retrieve input schema is invalid.")
    index = payload.get("index")
    control = payload.get("control")
    require(isinstance(index, dict) and index.get("version") == INDEX_VERSION and isinstance(index.get("chunks"), list),
            "POLICY.INDEX_INVALID", "Policy index is invalid.")
    require(isinstance(control, dict), "POLICY.CONTROL_INVALID", "Control query is invalid.")
    chunks = index["chunks"]
    document_frequency = index.get("documentFrequency") or {}
    query_fields = [str(control.get(k) or "").strip() for k in
                    ("applicationName", "system", "controlNumber", "description", "procedure", "documentProcedureResults")]
    query_fields = [f for f in query_fields if f]
    query_terms = _term_frequency(_tokenize("\n".join(query_fields))[:MAX_QUERY_CHARS])
    if not query_terms:
        return {"schemaVersion": "omnia.workpaper-policy-snippets/v1", "snippets": []}
    chunk_count = len(chunks)
    scored: list[tuple[float, dict[str, Any], int]] = []
    for chunk in chunks:
        score = 0.0
        matched = 0
        for term, qf in query_terms.items():
            freq = chunk["terms"].get(term, 0)
            if not freq:
                continue
            df = document_frequency.get(term, 0)
            score += (1 + __import__("math").log(freq)) * (__import__("math").log((chunk_count + 1) / (df + 1)) + 1) * (1 + __import__("math").log(qf))
            matched += 1
        if not matched:
            continue
        lower = chunk["text"].lower()
        for field in query_fields:
            nf = field.lower()
            if len(nf) >= 4 and nf in lower:
                score += 4
        if score > 0:
            scored.append((score, chunk, matched))
    scored.sort(key=lambda item: (-item[0], -item[2], item[1]["documentName"], item[1]["ordinal"]))
    snippets: list[dict[str, Any]] = []
    used = 0
    for score, chunk, matched in scored[:6]:
        if used >= 18000:
            break
        text = chunk["text"][:18000 - used]
        if not text:
            continue
        snippets.append({"snippetId": chunk["snippetId"], "documentName": chunk["documentName"],
                         "sourceFileSha256": chunk["sourceFileSha256"], "ordinal": chunk["ordinal"], "text": text})
        used += len(text)
    return {"schemaVersion": "omnia.workpaper-policy-snippets/v1", "snippets": snippets}


def extract_placeholders(payload: Any) -> dict[str, Any]:
    require(isinstance(payload, dict) and payload.get("schemaVersion") == "omnia.workpaper-placeholder-input/v1",
            "POLICY.PLACEHOLDER_INPUT_INVALID", "Placeholder input schema is invalid.")
    control_number = str(payload.get("controlNumber") or "").strip()
    source_field = str(payload.get("sourceField") or "").strip()
    source_text = str(payload.get("sourceText") or "")
    require(control_number and source_field, "POLICY.PLACEHOLDER_IDENTITY", "Placeholder identity is required.")
    occurrences: list[dict[str, Any]] = []
    seen = set()
    for match in _PLACEHOLDER.finditer(source_text):
        original = match.group(0)
        occurrence = len([o for o in occurrences if o["originalPlaceholder"] == original])
        placeholder_id = hashlib.sha256(
            f"phase2-placeholder-v1\0{control_number}\0{source_field}\0{occurrence}\0{original}".encode("utf-8")
        ).hexdigest()
        if placeholder_id in seen:
            continue
        seen.add(placeholder_id)
        occurrences.append({"placeholderId": placeholder_id, "originalPlaceholder": original,
                            "occurrence": occurrence, "index": match.start(), "sourceField": source_field})
    return {"schemaVersion": "omnia.workpaper-placeholders/v1", "controlNumber": control_number,
            "sourceField": source_field, "placeholders": occurrences, "placeholderCount": len(occurrences)}
