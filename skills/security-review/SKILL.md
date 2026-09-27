---
name: security-review
description: Review application code for exploitable weaknesses, insecure defaults, data exposure, and authorization flaws, then propose prioritized fixes.
---

# Security Review

- Establish the trust boundaries, assets, entry points, identities, and expected authorization rules.
- Prioritize concrete vulnerabilities by impact, exploitability, and affected scope.
- Check secrets, injection, path traversal, SSRF, unsafe deserialization, dependency risk, logging, and error disclosure as relevant.
- Provide evidence, affected locations, remediation, and a verification step for each finding.
- Do not perform intrusive testing or access systems outside the authorized workspace.
