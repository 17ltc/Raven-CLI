# OSINT / CTI Sources by Data Type

Query these via `web_search` and `web_fetch` (fetch the platform's public lookup page for the indicator). Most have free web UIs that don't require an API key for single lookups; some require sign-in for bulk/API access — don't try to work around that, just note it to the user if hit.

## Infrastructure (domains, IPs, ASNs)
- **WHOIS** — registrar, registrant org, creation/expiry dates.
- **crt.sh** — certificate transparency logs; best free way to enumerate subdomains and spot infrastructure reused across domains.
- **Shodan / Censys** — indexed banners for internet-facing services (passive — reads what's already been indexed, doesn't scan live).
- **Passive DNS / historical resolutions** — via VirusTotal's "Relations" tab or SecurityTrails public lookups; shows what domains/IPs have resolved to over time.
- **BGP/ASN lookups** (e.g. bgp.he.net, RIPEstat) — hosting provider, netblock ownership, routing context.
- **Wayback Machine (web.archive.org)** — historical site snapshots; useful for phishing kit evolution or defacement history.

## Malware & file indicators
- **VirusTotal** — multi-engine detection, behavioral reports, relations (dropped files, contacted domains/IPs), community comments/tags.
- **AlienVault OTX** — community threat pulses, IOC correlation across reported campaigns.
- **ThreatFox / MalwareBazaar / URLhaus (abuse.ch)** — curated, free IOC feeds for malware and phishing URLs.
- **Hybrid Analysis / ANY.RUN public reports** — if a sandbox report already exists publicly for a hash, use it.

## Threat actor / campaign intelligence
- **MITRE ATT&CK** (attack.mitre.org) — canonical TTP and group-profile reference; always map techniques to their T-numbers.
- **Vendor CTI blogs** — Mandiant/Google Threat Intelligence, Microsoft MSTIC, Cisco Talos, Unit42 (Palo Alto), Recorded Future, CrowdStrike — primary source for named-group attribution and campaign writeups.
- **Ransomware leak-site trackers** (e.g. ransomware.live) — public aggregators of leak-site claims; treat claims as unverified allegations, not confirmed breaches, unless corroborated.

## Breach / credential exposure
- **Have I Been Pwned** — check by email or domain for *existence* of exposure in known breaches. Report that an account/domain appears in named breaches and the breach's public description.

## Code / secret leaks
- **GitHub/GitLab code search** — search for leaked API keys, credentials, or internal hostnames in an org's public repos (their own repos only, in the authorized-org-assessment case).
- **public paste sites** — only reference if the user already has a specific known link; don't go searching paste dumps for "whatever's out there" on a person.

## Social/organizational footprint (org-level only)
- **LinkedIn org search** — employee count/role footprint for social-engineering-surface awareness in an authorized assessment.
- **Company filings / press releases** — for org structure, subsidiaries, M&A history relevant to attack surface inheritance.
