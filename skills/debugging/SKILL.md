---
name: debugging
description: Diagnose software failures by reproducing them, tracing the execution path, isolating the root cause, and verifying a focused fix.
---

# Debugging

- Capture the exact error, input, environment, and first failing boundary.
- Reproduce the failure with the smallest reliable case before changing code.
- Separate symptoms from root cause and test one hypothesis at a time.
- Prefer a minimal fix that preserves surrounding behavior.
- Add a regression test when the failure is deterministic, then rerun the original reproduction.
