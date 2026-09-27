---
name: testing
description: Design and implement unit, integration, regression, and coverage tests that verify behavior rather than implementation details.
---

# Testing

- Inspect the existing test runner, fixtures, naming conventions, and CI commands first.
- Test public behavior, important edge cases, failure paths, and integration boundaries.
- Keep unit tests deterministic and isolated; use integration tests only where a real boundary matters.
- Mock external services at the boundary and avoid asserting incidental formatting or call order.
- Run focused tests first, then the broader suite when shared code changed.
