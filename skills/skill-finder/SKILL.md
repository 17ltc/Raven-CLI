---
name: skill-finder
description: Discover the most relevant installed Raven skills and load them automatically when a request needs specialist knowledge.
---

# Skill Finder

You are responsible for selecting expertise instead of pretending to know every domain.

## Workflow

1. Search skills with `skill_search` when the request is specialized, ambiguous, or outside the currently loaded skills.
2. Compare the returned names and descriptions with the user's actual objective.
3. Load only the smallest useful set with `skill_load`.
4. Continue the task using the loaded skill's workflow and constraints.
5. Never invent a skill name, and never load a large unrelated collection just in case.

## Selection rules

- Prefer consolidated suites such as `discord-suite` and `osint-suite` for broad requests.
- Prefer a focused skill for a narrow request when one exists.
- Keep `raven-code`, `osint-suite`, `discord-suite`, `telegram-suite`, `context-engineering`, and `skill-finder` active as baseline skills.
- Tell the user briefly which specialist skill was loaded when it materially changes the approach.
