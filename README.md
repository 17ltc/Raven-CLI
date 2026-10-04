# Raven

Raven is a Node.js terminal agent for working directly inside a configured project. It can inspect source code, edit files, run approved commands, manage background development servers, route requests across model providers, and connect to Discord or Telegram.

Raven is designed for local project work. It keeps file operations inside the selected workspace and requires human confirmation for sensitive actions.

## Requirements

- Node.js 18 or newer

## Install

```bash
npm install
npm link
```

On Windows, the launcher can also be installed with:

```powershell
.\install.cmd
```

## Start

Run Raven from a project directory:

```bash
raven
```

Use an explicit workspace when needed:

```bash
raven --workspace /path/to/project
```

Raven works directly in that directory. It does not create wrapper directories such as `workspace/` or `targets/` unless a command explicitly needs them.

## Configuration

Configuration is stored in `~/.raven/config.json`. The setup wizard is available with:

```bash
raven setup
```

Common settings include:

- `backend`: provider, model, endpoint, timeout, and token limit
- `providers`: multiple providers and API keys
- `model_routes`: ordered fallback routes
- `workspace.path`: the project root Raven may modify
- `enabled_skills`: skills enabled for the session
- `discord` and `telegram`: bot tokens, owners, and allowed scopes

Environment variables are preferred for secrets. Raven supports provider-specific variables such as `OPENROUTER_API_KEY`, `NVIDIA_API_KEY`, `DISCORD_BOT_TOKEN`, and `TELEGRAM_BOT_TOKEN`.

## Core commands

```text
/status       Show backend, model, skills, and context usage
/config       View or update configuration
/prompt       Switch between lite and full prompts
/compact      Compact older conversation history
/cost         Show context and session token estimates
/skill        List, load, or manage skills
/server       Start, inspect, or stop development servers
/provider     Manage model providers and API keys
/route        Manage ordered model fallback routes
/discord      Manage the Discord bridge
/telegram     Manage the Telegram bridge
/init         Create project memory when explicitly requested
```

## Project workflow

Raven includes scoped project tools for reading, searching, editing, testing, and reviewing files. The `project-questions` skill lets the agent ask focused questions with numbered choices, defaults, confirmations, and an `Other` free-text answer instead of guessing requirements.

The default skills are:

- `raven-code`
- `osint-suite`
- `project-questions`
- `context-engineering`
- `skill-finder`

Additional skills can be loaded from the `skills/` directory.

## Model routing

Raven can keep several providers and API keys and try routes in a user-defined order. Rate limits, timeouts, network failures, and server errors can move a request to the next route.

```text
/provider add openrouter openrouter https://openrouter.ai/api/v1
/provider key openrouter main $OPENROUTER_API_KEY
/route add primary openrouter meta-llama/llama-3.1-70b-instruct main
/route add backup local llama3.1
```

## Integrations

Discord uses `discord.js` gateway mode when available and falls back to REST polling. Telegram uses `node-telegram-bot-api` polling. Both integrations support owner IDs, scoped channels or chats, and the same Raven command and agent entry points.

## Security model

- File tools are scoped to the configured workspace.
- Destructive file operations require human confirmation.
- Plan mode blocks write, execution, export, target, reminder, and server actions.
- Git inspection is restricted to read-only subcommands.
- Web tools accept HTTP(S) URLs only.
- API keys should be supplied through environment variables or protected local configuration.

Raven is not a substitute for a container or operating-system sandbox. Review commands and permissions before enabling autonomous workflows.

## Development

```bash
npm test
```

The test suite covers the agent loop, backend routing, context handling, file history, installer behavior, prompt handling, UI editing, and rendering.

## License

MIT. See [LICENSE](LICENSE).
