"""Defensive CSINT and OPSEC helpers.

All collection is passive and bounded. Values that look like secrets are
reported by location and type, never returned verbatim.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse


IOC_PATTERNS = {
    "ipv4": re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"),
    "sha256": re.compile(r"\b[a-fA-F0-9]{64}\b"),
    "sha1": re.compile(r"\b[a-fA-F0-9]{40}\b"),
    "md5": re.compile(r"\b[a-fA-F0-9]{32}\b"),
    "url": re.compile(r"https?://[^\s<>\"']+", re.I),
    "email": re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    "domain": re.compile(r"\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b"),
}
SECRET_PATTERNS = {
    "private_key": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "token_assignment": re.compile(r"(?i)(api[_-]?key|secret|token|password)\s*[:=]\s*['\"]?[A-Za-z0-9_\-/+=]{12,}"),
}


def csint_triage(indicator: str) -> dict:
    value = indicator.strip().strip("[]()<>\"'")
    kinds = []
    if IOC_PATTERNS["url"].fullmatch(value): kinds.append("url")
    if IOC_PATTERNS["email"].fullmatch(value): kinds.append("email")
    if IOC_PATTERNS["sha256"].fullmatch(value): kinds.append("sha256")
    if IOC_PATTERNS["sha1"].fullmatch(value): kinds.append("sha1")
    if IOC_PATTERNS["md5"].fullmatch(value): kinds.append("md5")
    try:
        ipaddress.ip_address(value); kinds.append("ip")
    except ValueError: pass
    if not kinds and IOC_PATTERNS["domain"].fullmatch(value): kinds.append("domain")
    return {"indicator": value, "types": kinds or ["unknown"], "normalized": value.lower(), "confidence": "high" if len(kinds) == 1 else "moderate" if kinds else "low"}


def ioc_extract(text: str, max_results: int = 500) -> dict:
    found = []
    seen = set()
    for kind, pattern in IOC_PATTERNS.items():
        for match in pattern.findall(text or ""):
            value = match.rstrip(".,;:)")
            key = (kind, value.lower())
            if key not in seen:
                seen.add(key); found.append({"type": kind, "value": value})
    return {"iocs": found[:max(1, min(int(max_results), 1000))], "count": len(found)}


def confidence_score(evidence: list[dict], claim: str = "") -> dict:
    sources = {str(item.get("source", "")).strip() for item in evidence if item.get("source")}
    independent = len(sources)
    level = "confirmed" if independent >= 3 else "high" if independent == 2 else "moderate" if independent == 1 else "unverified"
    return {"claim": claim, "confidence": level, "independent_sources": independent, "evidence_count": len(evidence), "caveat": "Confidence is an analytical estimate, not proof."}


def mitre_attack_mapping(observations: list[str]) -> dict:
    catalog = {"phishing": "T1566", "spearphishing": "T1566.001", "powershell": "T1059.001", "command shell": "T1059.003", "credential dumping": "T1003", "scheduled task": "T1053", "ransomware": "T1486", "exfiltration": "T1041"}
    mappings = []
    for observation in observations:
        lowered = observation.lower()
        matches = [{"technique": technique, "evidence": observation} for term, technique in catalog.items() if term in lowered]
        mappings.extend(matches)
    return {"mappings": mappings, "count": len(mappings), "note": "Keyword mapping requires analyst validation."}


def opsec_scan_text(text: str) -> dict:
    findings = []
    for kind, pattern in SECRET_PATTERNS.items():
        for match in pattern.finditer(text or ""):
            line = (text or "")[:match.start()].count("\n") + 1
            findings.append({"type": kind, "line": line, "fingerprint": hashlib.sha256(match.group(0).encode()).hexdigest()[:12]})
    return {"findings": findings, "count": len(findings), "values_redacted": True}


def opsec_scan_workspace(root: str, limit: int = 500) -> dict:
    base = Path(root).resolve()
    findings = []
    ignored = {".git", ".venv", "venv", "node_modules", "__pycache__"}
    for path in base.rglob("*"):
        if len(findings) >= limit: break
        if not path.is_file() or any(part in ignored for part in path.relative_to(base).parts): continue
        try: result = opsec_scan_text(path.read_text(encoding="utf-8", errors="ignore"))
        except OSError: continue
        for finding in result["findings"]:
            findings.append({"file": str(path.relative_to(base)), **finding})
    return {"root": str(base), "findings": findings[:max(1, min(int(limit), 2000))], "count": len(findings), "values_redacted": True}


def redact_sensitive_text(text: str) -> dict:
    redacted = text or ""
    replacements = 0
    for pattern in SECRET_PATTERNS.values():
        redacted, count = pattern.subn("[REDACTED_SECRET]", redacted)
        replacements += count
    return {"text": redacted, "replacements": replacements}


def url_privacy_review(url: str) -> dict:
    parsed = urlparse(url)
    sensitive = {"token", "key", "secret", "password", "auth", "code", "email"}
    keys = [key for key in __import__("urllib.parse", fromlist=["parse_qsl"]).parse_qsl(parsed.query) if key[0].lower() in sensitive]
    return {"url": url, "scheme": parsed.scheme, "host": parsed.netloc, "sensitive_query_keys": [key for key, _ in keys], "risk": "review" if keys else "low"}


def register_csint_opsec_tools(registry: dict) -> None:
    registry["csint_triage"] = {"fn": csint_triage, "description": "Classify a domain, IP, hash, URL, or email."}
    registry["ioc_extract"] = {"fn": ioc_extract, "description": "Extract bounded public IOC candidates from text."}
    registry["confidence_score"] = {"fn": confidence_score, "description": "Estimate confidence from independent evidence sources."}
    registry["mitre_attack_mapping"] = {"fn": mitre_attack_mapping, "description": "Map observations to possible MITRE ATT&CK techniques for analyst review."}
    registry["opsec_scan_text"] = {"fn": opsec_scan_text, "description": "Find likely secrets in supplied text without revealing values."}
    registry["opsec_scan_workspace"] = {"fn": opsec_scan_workspace, "description": "Scan the configured workspace for likely secret exposure with redacted findings."}
    registry["redact_sensitive_text"] = {"fn": redact_sensitive_text, "description": "Redact likely credentials from text before sharing."}
    registry["url_privacy_review"] = {"fn": url_privacy_review, "description": "Review URL query parameters for privacy-sensitive values."}
