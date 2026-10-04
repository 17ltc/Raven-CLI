---
name: telegram-suite
description: Consolidated Telegram workflow for Raven bot conversations, owner authorization, chat scope, agent commands, and concise output delivery.
---

# Telegram Suite

Use Telegram only through the configured Raven bot. Respect `owner_ids` and
`chat_ids`; never expose tokens, private configuration, or another user's
conversation. Keep replies short and split long output into safe message-sized
chunks.

## Workflow

1. Confirm the request comes from an authorized owner and configured chat.
2. Route `/raven <commande>` to Raven's command system or natural language to
   the active agent.
3. Report tool results plainly; do not invent server status or actions.
4. Ask for human confirmation before destructive or sensitive operations.
5. Keep bot tokens in `TELEGRAM_BOT_TOKEN` or Raven's protected config.

## Available operations

`telegram_bot`, `telegram_commands`, `telegram_agents`, `telegram_output`, and
`telegram_security` are consolidated here; the runtime bridge is implemented
by Raven's `telegram_bot_tools` module.
