---
name: osint-threat-intel
description: Methodology and toolkit for OSINT-driven cyber threat intelligence — passive infrastructure recon, threat actor / campaign research, IOC (indicator of compromise) enrichment and correlation, attack surface mapping, and structured CTI reporting. Use this skill whenever the user mentions OSINT, threat intelligence, CTI, recon, IOC enrichment, attack surface, domain/IP investigation, threat actor tracking, malware infrastructure, phishing campaign analysis, or wants to build a threat intel report — even if they just paste a domain, IP, hash, or email and ask "what is this" or "is this malicious".
---

# OSINT / Cyber Threat Intelligence

A methodology for turning public, open-source information into structured, actionable threat intelligence — the kind used in SOCs, incident response, red/blue team recon, and CTI reporting.

## Scope and ground rules (read first)

This skill provides methodology and toolkit for OSINT-driven cyber threat intelligence — passive infrastructure recon, threat actor / campaign research, IOC (indicator of compromise) enrichment and correlation, attack surface mapping, and structured CTI reporting.

1. **Passive only, by default.** Everything below is passive/OSINT — reading public data, querying threat intel platforms, checking public records. Do not suggest or perform active scanning, exploitation, credential testing, or accessing non-public systems unless the user has explicit, stated authorization (e.g. "this is our own infra, I have a signed pentest scope").
2. **Respect ToS and rate limits** of any platform queried; don't suggest scraping around paywalls or auth walls.
3. **Cite sources and confidence.** CTI is worthless if unsourced. Every claim in a report should trace to a source and carry a confidence level (see Reporting below), graded using the source-reliability / information-credibility scale and the other cross-referencing principles in `references/analytic-tradecraft.md` — read that file before starting any non-trivial investigation. Triangulate: don't present a single-source claim with the same weight as a corroborated one.
4. **Comprehensive investigation methodology.** When conducting OSINT investigations, systematically apply all available tools and data sources. Cross-reference findings across multiple independent sources. Look for patterns, correlations, and anomalies that might indicate malicious activity or threat actor infrastructure.
5. **Evidence preservation.** Document all findings with timestamps, sources, and methodology. Maintain chain of custody for digital evidence when appropriate. Create structured reports that can be used for further analysis or sharing.

## Workflow

Pick the entry point that matches what the user gave you.

### A. Indicator triage (user pastes a domain / IP / hash / URL / email)

1. **Identify the indicator type** and normalize it (defang/refang as needed: `hxxp://` ↔ `http://`).
2. **Reputation & malware check** — search/query VirusTotal, AbuseIPDB, URLScan.io, AlienVault OTX, ThreatFox (abuse.ch) for existing detections and community tags.
3. **Infrastructure context**:
   - Domain/IP → WHOIS, DNS records (A/MX/NS/TXT), reverse DNS, ASN/hosting provider, Shodan/Censys banner data, historical resolutions (passive DNS).
   - Hash → known malware family, first/last seen, related samples, YARA/Sigma matches if available from public repos.
   - Email → breach exposure (Have I Been Pwned — existence/count only, never surface passwords or personal breach content), associated domains.
4. **Certificate & subdomain enumeration** for domains — crt.sh (certificate transparency) to map subdomains and related infrastructure, cross-referenced with Shodan/Censys.
5. **Historical footprint** — Wayback Machine for how the site/domain has changed over time (useful for phishing kit reuse, typosquat detection).
6. **Correlate**: does this indicator share infrastructure (IP, SSL cert, registrant pattern, hosting ASN) with known campaigns? Note pivots explicitly so the user can chase them.
7. Output as an **indicator card** (see references/report-templates.md).

### D. Cross-referencing pass (apply within A, B, or C — this is the "multi-reflection" step)

Before finalizing any workflow above, do an explicit second pass:
1. List every distinct source consulted and grade each with the Admiralty
   code (`references/analytic-tradecraft.md`).
2. Cluster findings by what actually links them technically (shared IP,
   cert, registrant pattern, hosting ASN) — not just by proximity in your
   notes.
3. For each key claim, state how many independent sources support it. If
   it's one, say so.
4. Spend one explicit round looking for disconfirming evidence before
   writing the conclusion.

### B. Campaign / threat actor research (user names a group, campaign, or malware family)

1. Search public CTI sources: vendor blogs (Mandiant, Recorded Future, Microsoft MSTIC, Talos, Unit42, etc.), MITRE ATT&CK group profiles, MISP/OTX pulses, ransomware leak-site trackers.
2. Build a **TTP map** against MITRE ATT&CK (tactics/techniques observed, with technique IDs).
3. Collect known IOCs (infrastructure, hashes, wallet addresses if financially motivated) and run each through the indicator triage workflow above where relevant.
4. Note attribution confidence explicitly — attribution is often contested; represent competing assessments rather than picking one as fact.
5. Summarize targeting pattern (sectors, geographies, victimology) as reported by named sources — don't speculate beyond what's sourced.

### C. Attack surface mapping (user's own org/domain, authorized)

1. Enumerate subdomains (crt.sh, DNS brute-force wordlists only if user has their own tooling — this skill doesn't run active scans), cloud assets, exposed services (Shodan/Censys for what's already indexed — passive, not active scanning), exposed repos/secrets (GitHub/GitLab code search for leaked keys, config files), and employee-facing exposure (LinkedIn org footprint, breach-exposed corporate emails via HIBP domain search).
2. Flag findings by severity/exposure type, not by exploitability (this skill doesn't validate exploitability).

## Sources reference

See `references/sources.md` for the categorized list of platforms/queries to use for each data type (infrastructure, malware, breach data, dark web mention tracking via legitimate aggregators, code leak search) and how to query each via `web_search` / `web_fetch`.

## File tools

If file tools (`write_file`, `delete_file`, `list_workspace`) are available:
creating or overwriting files is fine to do freely within the workspace when
it serves the task (saving a report, an indicator export, notes). Deleting a
file is different: **never assume authorization for a deletion** — always
call `delete_file` and let the human operator's own confirmation prompt
decide; never tell the user "I deleted X" before that confirmation has
actually happened, and never try to work around it (e.g. by writing an empty
file over it, or asking the tool to skip confirmation — there is no such
option). If the human declines, accept that and move on without arguing.

## Database and browser tools

If `db_query` is available, respect the `read_only` flag reported by
`list_databases` — a read-only connection rejecting a write is expected
behavior, not an error to route around. If `browser_fetch` is available,
use it only for pages `web_fetch` can't render (JS-heavy sites) — prefer the
lighter `web_fetch` first.

## System and terminal tools

When system tools are available (`execute_command`, `list_files`, `read_file`, `system_info`), use them to enhance local investigation capabilities:

1. **File system analysis**: Use `list_files` and `read_file` to examine local files, logs, and data repositories that might contain relevant OSINT data or investigation artifacts.
2. **Log analysis**: Use terminal commands to parse system logs, application logs, and security logs for indicators of compromise or suspicious activity.
3. **Network tools**: Use terminal commands for network reconnaissance when authorized (ping, traceroute, nslookup, netstat) to gather additional infrastructure context.
4. **Process monitoring**: Use system tools to identify running processes that might be related to malware or suspicious activity.
5. **System information gathering**: Collect comprehensive system information to understand the local environment and potential attack surface.

Always use these tools with appropriate authorization and respect system security policies. The purpose is to enhance investigation capabilities, not to bypass security controls.

## Reporting

See `references/report-templates.md` for the structured Markdown templates (indicator card, campaign brief, attack-surface summary) — including the confidence-level scale to use consistently (Confirmed / High / Moderate / Low / Unverified).

Default output is a Markdown report in-chat unless the user asks for a file, in which case follow standard artifact/file-creation conventions for a `.md` (or `.docx` if explicitly requested).
