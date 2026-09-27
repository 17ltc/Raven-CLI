from __future__ import annotations

import requests
from typing import Dict, List, Optional
from dataclasses import dataclass
from datetime import datetime
from rich.console import Console


@dataclass
class IPInfo:
    ip: str
    source: str
    country: str = ""
    city: str = ""
    region: str = ""
    isp: str = ""
    org: str = ""
    asn: str = ""
    timezone: str = ""
    is_vpn: bool = False
    is_proxy: bool = False
    is_tor: bool = False
    threat_level: str = "unknown"
    confidence: float = 0.0
    raw_data: Dict = None

    def __post_init__(self):
        if self.raw_data is None:
            self.raw_data = {}


class AdvancedIPLookup:
    def __init__(self, console: Console = None):
        self.console = console or Console()
        self.sources = {
            "ipapi": self._lookup_ipapi,
            "ipinfo": self._lookup_ipinfo,
            "ipgeolocation": self._lookup_ipgeolocation,
            "virustotal": self._lookup_virustotal,
            "abuseipdb": self._lookup_abuseipdb
        }

    def lookup_ip(self, ip: str, sources: List[str] = None) -> Dict:
        """Perform multi-source IP lookup."""
        if sources is None:
            sources = ["ipapi", "ipinfo", "ipgeolocation"]
        
        try:
            return self._lookup_ip_sync(ip, sources)
        except Exception as e:
            return {
                "ip": ip,
                "error": f"IP lookup failed: {str(e)}",
                "sources_queried": sources,
                "results_count": 0
            }

    def _lookup_ip_sync(self, ip: str, sources: List[str]) -> Dict:
        """Sync implementation of IP lookup."""
        results = []
        
        for source in sources:
            if source in self.sources:
                try:
                    result = self.sources[source](ip)
                    if result:
                        results.append(result)
                except Exception as e:
                    self.console.print(f"[yellow]Lookup error for {source}: {e}[/yellow]")
        
        # Correlate and analyze results
        correlated = self._correlate_results(results)
        
        return {
            "ip": ip,
            "sources_queried": sources,
            "results_count": len(results),
            "correlated_data": correlated,
            "lookup_timestamp": datetime.now().isoformat(),
            "confidence_score": self._calculate_confidence(correlated)
        }

    def _lookup_ipapi(self, ip: str) -> Optional[IPInfo]:
        """Lookup using ip-api.com (free, no key needed)."""
        try:
            response = requests.get(f"http://ip-api.com/json/{ip}", timeout=10)
            data = response.json()
            
            if data.get("status") == "fail":
                return None
            
            return IPInfo(
                ip=ip,
                source="ip-api.com",
                country=data.get("country", ""),
                city=data.get("city", ""),
                region=data.get("regionName", ""),
                isp=data.get("isp", ""),
                org=data.get("org", ""),
                asn=data.get("as", ""),
                timezone=data.get("timezone", ""),
                is_proxy=data.get("proxy", False),
                raw_data=data
            )
        except Exception as e:
            self.console.print(f"[red]ip-api error: {e}[/red]")
            return None

    def _lookup_ipinfo(self, ip: str) -> Optional[IPInfo]:
        """Lookup using ipinfo.io (free tier)."""
        try:
            response = requests.get(f"https://ipinfo.io/{ip}/json", timeout=10)
            data = response.json()
            
            return IPInfo(
                ip=ip,
                source="ipinfo.io",
                country=data.get("country", ""),
                city=data.get("city", ""),
                region=data.get("region", ""),
                org=data.get("org", ""),
                timezone=data.get("timezone", ""),
                raw_data=data
            )
        except Exception as e:
            self.console.print(f"[red]ipinfo error: {e}[/red]")
            return None

    def _lookup_ipgeolocation(self, ip: str) -> Optional[IPInfo]:
        """Lookup using ipgeolocation.io (free)."""
        try:
            response = requests.get(f"https://ipgeolocation.io/ip/{ip}", timeout=10)
            data = response.json()
            
            return IPInfo(
                ip=ip,
                source="ipgeolocation.io",
                country=data.get("country_name", ""),
                city=data.get("city", ""),
                region=data.get("state_prov", ""),
                isp=data.get("isp", ""),
                org=data.get("org", ""),
                raw_data=data
            )
        except Exception as e:
            self.console.print(f"[red]ipgeolocation error: {e}[/red]")
            return None

    def _lookup_virustotal(self, ip: str) -> Optional[IPInfo]:
        """Lookup using VirusTotal (requires API key)."""
        import os
        api_key = os.environ.get("VT_API_KEY")
        if not api_key:
            return None
        
        try:
            headers = {"x-apikey": api_key}
            response = requests.get(
                f"https://www.virustotal.com/api/v3/ip_addresses/{ip}",
                headers=headers,
                timeout=15
            )
            data = response.json()
            
            if "error" in data:
                return None
            
            attributes = data.get("data", {}).get("attributes", {})
            
            return IPInfo(
                ip=ip,
                source="virustotal",
                country=attributes.get("country", ""),
                threat_level=self._vt_reputation_to_level(attributes.get("reputation", 0)),
                confidence=0.9,
                raw_data=data
            )
        except Exception as e:
            self.console.print(f"[red]virustotal error: {e}[/red]")
            return None

    def _lookup_abuseipdb(self, ip: str) -> Optional[IPInfo]:
        """Lookup using AbuseIPDB (requires API key)."""
        import os
        api_key = os.environ.get("ABUSEIPDB_API_KEY")
        if not api_key:
            return None
        
        try:
            headers = {"Key": api_key, "Accept": "application/json"}
            params = {"ipAddress": ip, "maxAgeInDays": 90}
            response = requests.get(
                "https://api.abuseipdb.com/api/v2/check",
                headers=headers,
                params=params,
                timeout=15
            )
            data = response.json()
            
            if "errors" in data:
                return None
            
            attributes = data.get("data", {}).get("attributes", {})
            
            return IPInfo(
                ip=ip,
                source="abuseipdb",
                isp=attributes.get("isp", ""),
                threat_level=self._abuse_score_to_level(attributes.get("abuseConfidenceScore", 0)),
                confidence=0.85,
                raw_data=data
            )
        except Exception as e:
            self.console.print(f"[red]abuseipdb error: {e}[/red]")
            return None

    def _correlate_results(self, results: List[IPInfo]) -> Dict:
        """Correlate results from multiple sources."""
        if not results:
            return {}
        
        correlated = {
            "country": self._most_common_value([r.country for r in results if r.country]),
            "city": self._most_common_value([r.city for r in results if r.city]),
            "isp": self._most_common_value([r.isp for r in results if r.isp]),
            "org": self._most_common_value([r.org for r in results if r.org]),
            "sources_agree": len(set([r.source for r in results])),
            "discrepancies": self._find_discrepancies(results),
            "security_flags": {
                "is_vpn": any(r.is_vpn for r in results),
                "is_proxy": any(r.is_proxy for r in results),
                "is_tor": any(r.is_tor for r in results)
            }
        }
        
        return correlated

    def _most_common_value(self, values: List[str]) -> str:
        """Find the most common value in a list."""
        if not values:
            return ""
        from collections import Counter
        return Counter(values).most_common(1)[0][0]

    def _find_discrepancies(self, results: List[IPInfo]) -> List[str]:
        """Find discrepancies between sources."""
        discrepancies = []
        
        countries = [r.country for r in results if r.country]
        if len(set(countries)) > 1:
            discrepancies.append(f"Country mismatch: {set(countries)}")
        
        isps = [r.isp for r in results if r.isp]
        if len(set(isps)) > 1:
            discrepancies.append(f"ISP mismatch: {set(isps)}")
        
        return discrepancies

    def _calculate_confidence(self, correlated: Dict) -> float:
        """Calculate confidence score based on source agreement."""
        sources_agree = correlated.get("sources_agree", 0)
        discrepancies = correlated.get("discrepancies", [])
        
        if sources_agree == 0:
            return 0.0
        
        base_confidence = min(sources_agree / 3.0, 1.0)  # Max confidence with 3 sources
        discrepancy_penalty = len(discrepancies) * 0.1
        
        return max(0.0, base_confidence - discrepancy_penalty)

    def _vt_reputation_to_level(self, reputation: int) -> str:
        """Convert VirusTotal reputation to threat level."""
        if reputation <= -10:
            return "critical"
        elif reputation <= -5:
            return "high"
        elif reputation < 0:
            return "medium"
        else:
            return "low"

    def _abuse_score_to_level(self, score: float) -> str:
        """Convert AbuseIPDB confidence score to threat level."""
        if score >= 75:
            return "critical"
        elif score >= 50:
            return "high"
        elif score >= 25:
            return "medium"
        else:
            return "low"


class SelfReflectionSystem:
    def __init__(self, console: Console = None):
        self.console = console or Console()

    def analyze_results(self, results: Dict, original_query: str) -> Dict:
        """Analyze AI results and identify potential issues."""
        analysis = {
            "query": original_query,
            "timestamp": datetime.now().isoformat(),
            "consistency_check": self._check_consistency(results),
            "completeness_check": self._check_completeness(results, original_query),
            "accuracy_check": self._check_accuracy(results),
            "corrections_needed": [],
            "confidence_score": 0.0
        }
        
        # Calculate overall confidence
        analysis["confidence_score"] = self._calculate_overall_confidence(analysis)
        
        # Identify needed corrections
        if analysis["consistency_check"]["has_inconsistencies"]:
            analysis["corrections_needed"].append("resolve_inconsistencies")
        
        if analysis["completeness_check"]["is_incomplete"]:
            analysis["corrections_needed"].append("gather_missing_data")
        
        if analysis["accuracy_check"]["has_potential_errors"]:
            analysis["corrections_needed"].append("verify_suspicious_data")
        
        return analysis

    def _check_consistency(self, results: Dict) -> Dict:
        """Check for internal consistency in results."""
        return {
            "has_inconsistencies": results.get("correlated_data", {}).get("discrepancies", []),
            "discrepancy_count": len(results.get("correlated_data", {}).get("discrepancies", [])),
            "source_agreement": results.get("correlated_data", {}).get("sources_agree", 0)
        }

    def _check_completeness(self, results: Dict, query: str) -> Dict:
        """Check if results are complete for the query."""
        correlated = results.get("correlated_data", {})
        
        required_fields = ["country", "city", "isp"]
        missing_fields = [field for field in required_fields if not correlated.get(field)]
        
        return {
            "is_incomplete": len(missing_fields) > 0,
            "missing_fields": missing_fields,
            "completeness_ratio": 1.0 - (len(missing_fields) / len(required_fields))
        }

    def _check_accuracy(self, results: Dict) -> Dict:
        """Check for potential accuracy issues."""
        correlated = results.get("correlated_data", {})
        security_flags = correlated.get("security_flags", {})
        
        potential_issues = []
        
        if security_flags.get("is_vpn") and security_flags.get("is_proxy"):
            potential_issues.append("conflicting_security_flags")
        
        if results.get("confidence_score", 0) < 0.5:
            potential_issues.append("low_confidence")
        
        return {
            "has_potential_errors": len(potential_issues) > 0,
            "issues": potential_issues
        }

    def _calculate_overall_confidence(self, analysis: Dict) -> float:
        """Calculate overall confidence in the results."""
        consistency = 1.0 if not analysis["consistency_check"]["has_inconsistencies"] else 0.7
        completeness = analysis["completeness_check"]["completeness_ratio"]
        accuracy = 0.8 if not analysis["accuracy_check"]["has_potential_errors"] else 0.6
        
        return (consistency + completeness + accuracy) / 3.0

    def generate_corrections(self, analysis: Dict, results: Dict) -> List[str]:
        """Generate correction suggestions."""
        corrections = []
        
        if "resolve_inconsistencies" in analysis["corrections_needed"]:
            discrepancies = results.get("correlated_data", {}).get("discrepancies", [])
            corrections.append(f"Resolve {len(discrepancies)} source discrepancies: {discrepancies}")
        
        if "gather_missing_data" in analysis["corrections_needed"]:
            missing = analysis["completeness_check"]["missing_fields"]
            corrections.append(f"Gather missing data for: {missing}")
        
        if "verify_suspicious_data" in analysis["corrections_needed"]:
            issues = analysis["accuracy_check"]["issues"]
            corrections.append(f"Verify suspicious data: {issues}")
        
        return corrections

    def format_reflection_report(self, analysis: Dict) -> str:
        """Format the self-reflection analysis as a readable report."""
        report = f"""
[bold]Self-Reflection Analysis[/bold]

[dim]Query:[/dim] {analysis['query']}
[dim]Timestamp:[/dim] {analysis['timestamp']}

[bold]Consistency Check:[/bold]
  • Source Agreement: {analysis['consistency_check']['source_agreement']} sources
  • Inconsistencies: {analysis['consistency_check']['has_inconsistencies']}
  • Discrepancy Count: {analysis['consistency_check']['discrepancy_count']}

[bold]Completeness Check:[/bold]
  • Complete: {not analysis['completeness_check']['is_incomplete']}
  • Completeness Ratio: {analysis['completeness_check']['completeness_ratio']:.2%}
  • Missing Fields: {analysis['completeness_check']['missing_fields']}

[bold]Accuracy Check:[/bold]
  • Potential Errors: {analysis['accuracy_check']['has_potential_errors']}
  • Issues: {analysis['accuracy_check']['issues']}

[bold]Overall Confidence:[/bold] {analysis['confidence_score']:.2%}

[bold]Corrections Needed:[/bold]
"""
        if analysis['corrections_needed']:
            for correction in analysis['corrections_needed']:
                report += f"  • {correction}\n"
        else:
            report += "  • No corrections needed\n"
        
        return report
