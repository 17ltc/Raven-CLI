'use strict';
/**
 * Defensive CSINT and OPSEC helpers. Port of Raven/csint_opsec_tools.py
 *
 * All collection is passive and bounded. Values that look like secrets are
 * reported by location and type, never returned verbatim.
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const IOC_PATTERNS = {
  ipv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  sha256: /\b[a-fA-F0-9]{64}\b/g,
  sha1: /\b[a-fA-F0-9]{40}\b/g,
  md5: /\b[a-fA-F0-9]{32}\b/g,
  url: /https?:\/\/[^\s<>"']+/gi,
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  domain: /\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g,
};

const SECRET_PATTERNS = {
  private_key: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  token_assignment: /(api[_-]?key|secret|token|password)\s*[:=]\s*['"]?[A-Za-z0-9_\-/+=]{12,}/gi,
};

/** Equivalent of Python's re.fullmatch for a global regex. */
function fullMatch(rx, value) {
  const anchored = new RegExp(`^(?:${rx.source})$`, rx.flags.replace('g', ''));
  return anchored.test(value);
}

function csintTriage({ indicator }) {
  const value = String(indicator).trim().replace(/^[[\]()<>"']+|[[\]()<>"']+$/g, '');
  const kinds = [];
  if (fullMatch(IOC_PATTERNS.url, value)) kinds.push('url');
  if (fullMatch(IOC_PATTERNS.email, value)) kinds.push('email');
  if (fullMatch(IOC_PATTERNS.sha256, value)) kinds.push('sha256');
  if (fullMatch(IOC_PATTERNS.sha1, value)) kinds.push('sha1');
  if (fullMatch(IOC_PATTERNS.md5, value)) kinds.push('md5');
  if (net.isIP(value)) kinds.push('ip');
  if (!kinds.length && fullMatch(IOC_PATTERNS.domain, value)) kinds.push('domain');
  return {
    indicator: value,
    types: kinds.length ? kinds : ['unknown'],
    normalized: value.toLowerCase(),
    confidence: kinds.length === 1 ? 'high' : kinds.length ? 'moderate' : 'low',
  };
}

function iocExtract({ text, max_results = 500 }) {
  const found = [];
  const seen = new Set();
  for (const [kind, pattern] of Object.entries(IOC_PATTERNS)) {
    const matches = (text || '').match(new RegExp(pattern.source, pattern.flags)) || [];
    for (const match of matches) {
      const value = match.replace(/[.,;:)]+$/, '');
      const key = `${kind}\u0000${value.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({ type: kind, value });
      }
    }
  }
  const cap = Math.max(1, Math.min(parseInt(max_results, 10) || 500, 1000));
  return { iocs: found.slice(0, cap), count: found.length };
}

function confidenceScore({ evidence, claim = '' }) {
  evidence = evidence || [];
  const sources = new Set(
    evidence.filter((item) => item && item.source).map((item) => String(item.source).trim())
  );
  const independent = sources.size;
  const level = independent >= 3 ? 'confirmed' : independent === 2 ? 'high' : independent === 1 ? 'moderate' : 'unverified';
  return {
    claim,
    confidence: level,
    independent_sources: independent,
    evidence_count: evidence.length,
    caveat: 'Confidence is an analytical estimate, not proof.',
  };
}

function mitreAttackMapping({ observations }) {
  const catalog = {
    phishing: 'T1566',
    spearphishing: 'T1566.001',
    powershell: 'T1059.001',
    'command shell': 'T1059.003',
    'credential dumping': 'T1003',
    'scheduled task': 'T1053',
    ransomware: 'T1486',
    exfiltration: 'T1041',
  };
  const mappings = [];
  for (const observation of observations || []) {
    const lowered = observation.toLowerCase();
    for (const [term, technique] of Object.entries(catalog)) {
      if (lowered.includes(term)) mappings.push({ technique, evidence: observation });
    }
  }
  return { mappings, count: mappings.length, note: 'Keyword mapping requires analyst validation.' };
}

function opsecScanTextImpl(text) {
  const findings = [];
  const body = text || '';
  for (const [kind, pattern] of Object.entries(SECRET_PATTERNS)) {
    const rx = new RegExp(pattern.source, pattern.flags);
    let m;
    while ((m = rx.exec(body)) !== null) {
      const line = body.slice(0, m.index).split('\n').length;
      findings.push({
        type: kind,
        line,
        fingerprint: crypto.createHash('sha256').update(m[0]).digest('hex').slice(0, 12),
      });
      if (m[0].length === 0) rx.lastIndex += 1;
    }
  }
  return { findings, count: findings.length, values_redacted: true };
}

function opsecScanText({ text }) {
  return opsecScanTextImpl(text);
}

function opsecScanWorkspace({ root, limit = 500 }) {
  const base = path.resolve(root);
  const findings = [];
  const ignored = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__']);
  const stack = [base];
  outer: while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      if (findings.length >= limit) break outer;
      if (ignored.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch (e) {
        continue;
      }
      const result = opsecScanTextImpl(text);
      for (const finding of result.findings) {
        findings.push({ file: path.relative(base, full), ...finding });
      }
    }
  }
  const cap = Math.max(1, Math.min(parseInt(limit, 10) || 500, 2000));
  return { root: base, findings: findings.slice(0, cap), count: findings.length, values_redacted: true };
}

function redactSensitiveText({ text }) {
  let redacted = text || '';
  let replacements = 0;
  for (const pattern of Object.values(SECRET_PATTERNS)) {
    const rx = new RegExp(pattern.source, pattern.flags);
    redacted = redacted.replace(rx, () => {
      replacements += 1;
      return '[REDACTED_SECRET]';
    });
  }
  return { text: redacted, replacements };
}

function urlPrivacyReview({ url }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return { url, scheme: '', host: '', sensitive_query_keys: [], risk: 'low' };
  }
  const sensitive = new Set(['token', 'key', 'secret', 'password', 'auth', 'code', 'email']);
  const keys = [];
  parsed.searchParams.forEach((value, key) => {
    if (sensitive.has(key.toLowerCase())) keys.push(key);
  });
  return {
    url,
    scheme: parsed.protocol.replace(':', ''),
    host: parsed.host,
    sensitive_query_keys: keys,
    risk: keys.length ? 'review' : 'low',
  };
}

function registerCsintOpsecTools(registry) {
  registry.csint_triage = { fn: csintTriage, description: 'Classify a domain, IP, hash, URL, or email.' };
  registry.ioc_extract = { fn: iocExtract, description: 'Extract bounded public IOC candidates from text.' };
  registry.confidence_score = { fn: confidenceScore, description: 'Estimate confidence from independent evidence sources.' };
  registry.mitre_attack_mapping = { fn: mitreAttackMapping, description: 'Map observations to possible MITRE ATT&CK techniques for analyst review.' };
  registry.opsec_scan_text = { fn: opsecScanText, description: 'Find likely secrets in supplied text without revealing values.' };
  registry.opsec_scan_workspace = { fn: opsecScanWorkspace, description: 'Scan the configured workspace for likely secret exposure with redacted findings.' };
  registry.redact_sensitive_text = { fn: redactSensitiveText, description: 'Redact likely credentials from text before sharing.' };
  registry.url_privacy_review = { fn: urlPrivacyReview, description: 'Review URL query parameters for privacy-sensitive values.' };
}

module.exports = {
  csintTriage,
  iocExtract,
  confidenceScore,
  mitreAttackMapping,
  opsecScanText,
  opsecScanWorkspace,
  redactSensitiveText,
  urlPrivacyReview,
  registerCsintOpsecTools,
};
