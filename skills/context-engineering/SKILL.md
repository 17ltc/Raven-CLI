---
name: context-engineering
description: Select, structure, compress, and verify the smallest useful project context so Raven stays accurate, efficient, and grounded.
---

# Context Engineering

Treat context as a curated working set, not a dump of the repository.

## Workflow

1. Read `RAVEN.md` and identify project constraints before acting.
2. Inspect the project tree and select files that directly answer the request.
3. Prefer bounded excerpts, stable facts, and tool results over assumptions.
4. Separate user intent, repository evidence, tool output, and model inference.
5. When context grows, preserve the system instructions, current objective, open risks, and the latest evidence; compact older conversation turns.
6. State uncertainty and ask for independent corroboration for research claims.

## Efficiency rules

- Do not load unrelated files or duplicate the same skill guidance.
- Use the domain skill that matches the task; consult a consolidated suite before individual modules.
- Keep summaries actionable: decisions, constraints, changed files, tests, and remaining questions.
