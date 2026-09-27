---
name: csint
description: Defensive Cyber Threat Intelligence workflow for classifying indicators, enriching public evidence, correlating infrastructure, mapping ATT&CK techniques, and producing confidence-scored briefings.
---

# CSINT

Use `csint_triage` first, then `ioc_extract` for supplied reports or logs.
Enrich only through passive public sources such as DNS, WHOIS, certificates,
reputation databases, public reports, and bounded web research. Use
`confidence_score` for claims and `mitre_attack_mapping` as an analyst-review
starting point, never as automatic attribution.

Never exploit, scan ports, test credentials, access private systems, or expose
secrets. Preserve sources, collection time, limitations, and competing
interpretations in every incident briefing.
