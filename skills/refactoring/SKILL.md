---
name: refactoring
description: Simplify and restructure existing code while preserving observable behavior, reducing duplication, and improving maintainability.
---

# Refactoring

- Establish the current behavior with tests, call sites, and a focused diff before restructuring.
- Prefer incremental changes with one clear responsibility per step.
- Remove duplication only when the shared abstraction is stable and genuinely clarifies the design.
- Preserve public behavior, error semantics, configuration compatibility, and performance unless the request changes them.
- Run regression tests and inspect the final diff for accidental scope expansion.
