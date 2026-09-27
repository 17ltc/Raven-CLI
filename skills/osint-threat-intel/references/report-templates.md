# CTI Report Templates

Use a consistent confidence scale across all reports:
- **Confirmed** — verified first-hand from primary/authoritative source
- **High** — multiple independent, credible sources agree
- **Moderate** — single credible source, or multiple weak/unverified sources
- **Low** — single weak source, community-tagged only, or inferential
- **Unverified** — claim exists but no corroboration found

---

## 1. Indicator Card

```markdown
## Indicator: `<value>`
**Type:** domain / IP / hash / URL / email
**First seen (by this lookup):** <date>
**Confidence of malicious classification:** <scale above>

### Reputation
- VirusTotal: X/Y engines flagged, tags: ...
- Other feeds: ...

### Infrastructure context
- WHOIS / ASN / hosting: ...
- DNS records: ...
- Related infrastructure (shared cert/IP/registrant pattern): ...

### Historical notes
- Passive DNS / Wayback notes: ...

### Pivots worth chasing
- ...

### Sources
1. [source name](url) — what it contributed
```

## 2. Campaign / Threat Actor Brief

```markdown
## Campaign/Actor: <name / aliases>
**Attribution confidence:** <scale above> — note if contested

### Summary
2-3 sentence plain-language summary of who/what and why it matters.

### TTPs (MITRE ATT&CK)
| Tactic | Technique | ID |
|---|---|---|
| ... | ... | Txxxx |

### Known infrastructure / IOCs
| Indicator | Type | Notes |
|---|---|---|

### Targeting pattern
Sectors / geographies / victim profile, per named sources — flag if sources disagree.

### Sources
1. ...
```

## 3. Attack Surface Summary (authorized, org's own assets)

```markdown
## Attack Surface Summary: <org/domain>
**Scope confirmed:** yes — <how>

### Exposed assets
| Asset | Type | Exposure | Notes |
|---|---|---|---|

### Findings by severity
- **High:** ...
- **Medium:** ...
- **Low / informational:** ...

### Recommendations
- ...

Note: this reflects passive/indexed exposure only, not exploitability. Validate findings with authorized active testing before remediation prioritization.
```
