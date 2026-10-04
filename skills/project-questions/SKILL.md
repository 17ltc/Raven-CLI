---
name: project-questions
description: Ask focused project questions through the CLI using choices, defaults, confirmations, and an Autre free-text response.
---

# Project Questions

When an important project requirement is missing or ambiguous, use the
`ask_user` tool instead of guessing. Ask only the minimum useful questions and
combine related questions into one call when possible.

## Rules

- Offer 2 to 5 concrete choices when there are meaningful alternatives.
- Always keep `allow_other: true` unless the answer must be one strict value.
- Use `default` only when it is a reasonable, reversible assumption.
- Ask confirmation before destructive, expensive, external, or irreversible actions.
- Use several short questions when the project needs multiple decisions.
- After receiving answers, summarize the decisions briefly and continue working.
- Never put secrets or API keys in question text or option labels.
