---
name: discord-suite
description: Consolidated authorized Discord workflow covering bot lookups, search, exports, moderation, audits, alerts, summaries, and community operations.
---

# Discord Suite

This is the consolidated entry point for Raven's Discord skills. Use only configured servers and channels, respect the scope returned by tools, and keep lookups read-only unless the user separately authorizes an administrative action.

## Workflow

1. Confirm the target guild/channel scope and the purpose of the lookup.
2. Use the narrowest search, time range, and result limit.
3. Preserve message IDs, authors, timestamps, and links as evidence.
4. For audits, moderation, alerts, exports, summaries, and community analysis, keep unrelated private content out of the result.
5. Explain missing permissions, incomplete history, and confidence instead of filling gaps.

## Included modules

The bot bridge, search, export, audit, moderation, alerts, summaries, and
community workflows are consolidated in this skill and exposed through Raven's
Discord tools.
