'use strict';
/** Port of Raven/advanced_tools.py */

const REQUEST_TIMEOUT_MS = 10000;

function makeIPInfo(fields) {
  return {
    ip: '',
    source: '',
    country: '',
    city: '',
    region: '',
    isp: '',
    org: '',
    asn: '',
    timezone: '',
    is_vpn: false,
    is_proxy: false,
    is_tor: false,
    threat_level: 'unknown',
    confidence: 0.0,
    raw_data: {},
    ...fields,
  };
}

async function fetchJson(url, opts = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

function mostCommonValue(values) {
  if (!values.length) return '';
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = values[0];
  let bestCount = 0;
  for (const [v, c] of counts.entries()) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

class AdvancedIPLookup {
  constructor(log = null) {
    this.log = log || ((msg) => console.log(msg));
    this.sources = {
      ipapi: (ip) => this._lookupIpapi(ip),
      ipinfo: (ip) => this._lookupIpinfo(ip),
      ipgeolocation: (ip) => this._lookupIpgeolocation(ip),
      virustotal: (ip) => this._lookupVirustotal(ip),
      abuseipdb: (ip) => this._lookupAbuseipdb(ip),
    };
  }

  async lookupIp(ip, sources = null) {
    sources = sources || ['ipapi', 'ipinfo', 'ipgeolocation'];
    try {
      return await this._lookupIpSync(ip, sources);
    } catch (e) {
      return { ip, error: `IP lookup failed: ${e.message}`, sources_queried: sources, results_count: 0 };
    }
  }

  async _lookupIpSync(ip, sources) {
    const results = [];
    for (const source of sources) {
      if (!this.sources[source]) continue;
      try {
        const result = await this.sources[source](ip);
        if (result) results.push(result);
      } catch (e) {
        this.log(`Lookup error for ${source}: ${e.message}`);
      }
    }
    const correlated = this._correlateResults(results);
    return {
      ip,
      sources_queried: sources,
      results_count: results.length,
      correlated_data: correlated,
      lookup_timestamp: new Date().toISOString(),
      confidence_score: this._calculateConfidence(correlated),
    };
  }

  async _lookupIpapi(ip) {
    try {
      const data = await fetchJson(`http://ip-api.com/json/${ip}`);
      if (data.status === 'fail') return null;
      return makeIPInfo({
        ip,
        source: 'ip-api.com',
        country: data.country || '',
        city: data.city || '',
        region: data.regionName || '',
        isp: data.isp || '',
        org: data.org || '',
        asn: data.as || '',
        timezone: data.timezone || '',
        is_proxy: Boolean(data.proxy),
        raw_data: data,
      });
    } catch (e) {
      this.log(`ip-api error: ${e.message}`);
      return null;
    }
  }

  async _lookupIpinfo(ip) {
    try {
      const data = await fetchJson(`https://ipinfo.io/${ip}/json`);
      return makeIPInfo({
        ip,
        source: 'ipinfo.io',
        country: data.country || '',
        city: data.city || '',
        region: data.region || '',
        org: data.org || '',
        timezone: data.timezone || '',
        raw_data: data,
      });
    } catch (e) {
      this.log(`ipinfo error: ${e.message}`);
      return null;
    }
  }

  async _lookupIpgeolocation(ip) {
    try {
      const data = await fetchJson(`https://ipgeolocation.io/ip/${ip}`);
      return makeIPInfo({
        ip,
        source: 'ipgeolocation.io',
        country: data.country_name || '',
        city: data.city || '',
        region: data.state_prov || '',
        isp: data.isp || '',
        org: data.org || '',
        raw_data: data,
      });
    } catch (e) {
      this.log(`ipgeolocation error: ${e.message}`);
      return null;
    }
  }

  async _lookupVirustotal(ip) {
    const apiKey = process.env.VT_API_KEY;
    if (!apiKey) return null;
    try {
      const data = await fetchJson(
        `https://www.virustotal.com/api/v3/ip_addresses/${ip}`,
        { headers: { 'x-apikey': apiKey } },
        15000
      );
      if (data.error) return null;
      const attributes = (data.data && data.data.attributes) || {};
      return makeIPInfo({
        ip,
        source: 'virustotal',
        country: attributes.country || '',
        threat_level: this._vtReputationToLevel(attributes.reputation || 0),
        confidence: 0.9,
        raw_data: data,
      });
    } catch (e) {
      this.log(`virustotal error: ${e.message}`);
      return null;
    }
  }

  async _lookupAbuseipdb(ip) {
    const apiKey = process.env.ABUSEIPDB_API_KEY;
    if (!apiKey) return null;
    try {
      const url = `https://api.abuseipdb.com/api/v2/check?${new URLSearchParams({ ipAddress: ip, maxAgeInDays: '90' })}`;
      const data = await fetchJson(url, { headers: { Key: apiKey, Accept: 'application/json' } }, 15000);
      if (data.errors) return null;
      const attributes = (data.data && data.data.attributes) || {};
      return makeIPInfo({
        ip,
        source: 'abuseipdb',
        isp: attributes.isp || '',
        threat_level: this._abuseScoreToLevel(attributes.abuseConfidenceScore || 0),
        confidence: 0.85,
        raw_data: data,
      });
    } catch (e) {
      this.log(`abuseipdb error: ${e.message}`);
      return null;
    }
  }

  _correlateResults(results) {
    if (!results.length) return {};
    return {
      country: mostCommonValue(results.map((r) => r.country).filter(Boolean)),
      city: mostCommonValue(results.map((r) => r.city).filter(Boolean)),
      isp: mostCommonValue(results.map((r) => r.isp).filter(Boolean)),
      org: mostCommonValue(results.map((r) => r.org).filter(Boolean)),
      sources_agree: new Set(results.map((r) => r.source)).size,
      discrepancies: this._findDiscrepancies(results),
      security_flags: {
        is_vpn: results.some((r) => r.is_vpn),
        is_proxy: results.some((r) => r.is_proxy),
        is_tor: results.some((r) => r.is_tor),
      },
    };
  }

  _findDiscrepancies(results) {
    const discrepancies = [];
    const countries = new Set(results.map((r) => r.country).filter(Boolean));
    if (countries.size > 1) discrepancies.push(`Country mismatch: ${[...countries]}`);
    const isps = new Set(results.map((r) => r.isp).filter(Boolean));
    if (isps.size > 1) discrepancies.push(`ISP mismatch: ${[...isps]}`);
    return discrepancies;
  }

  _calculateConfidence(correlated) {
    const sourcesAgree = correlated.sources_agree || 0;
    const discrepancies = correlated.discrepancies || [];
    if (sourcesAgree === 0) return 0.0;
    const base = Math.min(sourcesAgree / 3.0, 1.0);
    const penalty = discrepancies.length * 0.1;
    return Math.max(0.0, base - penalty);
  }

  _vtReputationToLevel(reputation) {
    if (reputation <= -10) return 'critical';
    if (reputation <= -5) return 'high';
    if (reputation < 0) return 'medium';
    return 'low';
  }

  _abuseScoreToLevel(score) {
    if (score >= 75) return 'critical';
    if (score >= 50) return 'high';
    if (score >= 25) return 'medium';
    return 'low';
  }
}

class SelfReflectionSystem {
  analyzeResults(results, originalQuery) {
    const analysis = {
      query: originalQuery,
      timestamp: new Date().toISOString(),
      consistency_check: this._checkConsistency(results),
      completeness_check: this._checkCompleteness(results, originalQuery),
      accuracy_check: this._checkAccuracy(results),
      corrections_needed: [],
      confidence_score: 0.0,
    };

    analysis.confidence_score = this._calculateOverallConfidence(analysis);

    if (analysis.consistency_check.has_inconsistencies && analysis.consistency_check.has_inconsistencies.length) {
      analysis.corrections_needed.push('resolve_inconsistencies');
    }
    if (analysis.completeness_check.is_incomplete) analysis.corrections_needed.push('gather_missing_data');
    if (analysis.accuracy_check.has_potential_errors) analysis.corrections_needed.push('verify_suspicious_data');

    return analysis;
  }

  _checkConsistency(results) {
    const correlated = (results && results.correlated_data) || {};
    return {
      has_inconsistencies: correlated.discrepancies || [],
      discrepancy_count: (correlated.discrepancies || []).length,
      source_agreement: correlated.sources_agree || 0,
    };
  }

  _checkCompleteness(results) {
    const correlated = (results && results.correlated_data) || {};
    const requiredFields = ['country', 'city', 'isp'];
    const missing = requiredFields.filter((f) => !correlated[f]);
    return {
      is_incomplete: missing.length > 0,
      missing_fields: missing,
      completeness_ratio: 1.0 - missing.length / requiredFields.length,
    };
  }

  _checkAccuracy(results) {
    const correlated = (results && results.correlated_data) || {};
    const securityFlags = correlated.security_flags || {};
    const issues = [];
    if (securityFlags.is_vpn && securityFlags.is_proxy) issues.push('conflicting_security_flags');
    if ((results && results.confidence_score) || 0 < 0.5) issues.push('low_confidence');
    return { has_potential_errors: issues.length > 0, issues };
  }

  _calculateOverallConfidence(analysis) {
    const consistency = analysis.consistency_check.has_inconsistencies.length === 0 ? 1.0 : 0.7;
    const completeness = analysis.completeness_check.completeness_ratio;
    const accuracy = !analysis.accuracy_check.has_potential_errors ? 0.8 : 0.6;
    return (consistency + completeness + accuracy) / 3.0;
  }

  generateCorrections(analysis, results) {
    const corrections = [];
    if (analysis.corrections_needed.includes('resolve_inconsistencies')) {
      const discrepancies = (results.correlated_data && results.correlated_data.discrepancies) || [];
      corrections.push(`Resolve ${discrepancies.length} source discrepancies: ${discrepancies}`);
    }
    if (analysis.corrections_needed.includes('gather_missing_data')) {
      corrections.push(`Gather missing data for: ${analysis.completeness_check.missing_fields}`);
    }
    if (analysis.corrections_needed.includes('verify_suspicious_data')) {
      corrections.push(`Verify suspicious data: ${analysis.accuracy_check.issues}`);
    }
    return corrections;
  }

  formatReflectionReport(analysis) {
    const pct = (n) => `${(n * 100).toFixed(2)}%`;
    let report = '\nSelf-Reflection Analysis\n\n';
    report += `Query: ${analysis.query}\n`;
    report += `Timestamp: ${analysis.timestamp}\n\n`;
    report += 'Consistency Check:\n';
    report += `  - Source Agreement: ${analysis.consistency_check.source_agreement} sources\n`;
    report += `  - Inconsistencies: ${JSON.stringify(analysis.consistency_check.has_inconsistencies)}\n`;
    report += `  - Discrepancy Count: ${analysis.consistency_check.discrepancy_count}\n\n`;
    report += 'Completeness Check:\n';
    report += `  - Complete: ${!analysis.completeness_check.is_incomplete}\n`;
    report += `  - Completeness Ratio: ${pct(analysis.completeness_check.completeness_ratio)}\n`;
    report += `  - Missing Fields: ${JSON.stringify(analysis.completeness_check.missing_fields)}\n\n`;
    report += 'Accuracy Check:\n';
    report += `  - Potential Errors: ${analysis.accuracy_check.has_potential_errors}\n`;
    report += `  - Issues: ${JSON.stringify(analysis.accuracy_check.issues)}\n\n`;
    report += `Overall Confidence: ${pct(analysis.confidence_score)}\n\n`;
    report += 'Corrections Needed:\n';
    if (analysis.corrections_needed.length) {
      for (const c of analysis.corrections_needed) report += `  - ${c}\n`;
    } else {
      report += '  - No corrections needed\n';
    }
    return report;
  }
}

module.exports = { AdvancedIPLookup, SelfReflectionSystem };
