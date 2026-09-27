# Raven

Raven is a local-first terminal agent for software development, research, and
defensive intelligence workflows. It connects to local or remote AI backends,
loads specialized skills, and works inside the configured project workspace.

Raven is not tied to one provider. It supports Ollama, LM Studio, vLLM,
OpenRouter, NVIDIA NIM, OmniRoute, custom HTTP endpoints, and other adapters.

## Installation

Python 3.9 or newer is required.

Windows PowerShell:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -e .
```

macOS/Linux:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e .
```

Add the environment `Scripts` or `bin` directory to `PATH` if you want to run
Raven outside the activated environment. Once installed on `PATH`, launch it
with one command:

```text
raven
```

No extra launch flag is required.

## Backend configuration

Personal configuration is stored outside the repository:

```text
Windows: C:\Users\<user>\.raven\config.json
Unix:    ~/.raven/config.json
```

Raven supports `ollama`, `lmstudio`, `vllm`, `openrouter`, `nvidia`,
`omniroute`, and `custom` backends. API credentials belong in environment
variables such as `OPENROUTER_API_KEY` or `NVIDIA_API_KEY`, never in Git.

## Using Raven

Ask for work in natural language:

```text
inspect the project structure
create an empty hello.txt file
find every call to this function
run the tests and explain the failures
review the current diff
```

The AI selects and calls the appropriate tool. Raven displays the tool call,
its result, and the final response.

## Commands

```text
/help                         Show help
/config show                  Show configuration
/files                        List project files
/find <text>                  Search project text
/context                      Summarize the project
/diff <file>                  Show a file diff
/git status                   Show Git status
/test                         Run tests
/lint                         Run linting
/build                        Build the project
/run <command>                Run a command after confirmation
/session list                 List sessions
/session load <id>            Restore a session
/skill list                   List available skills
/skill <name> enable          Enable an optional skill
/reminder add Title | in 20m Create a reminder
/reminder list                List reminders
/doctor                       Diagnose Raven
/clear                        Clear the terminal
/quit                         Exit Raven
```

Slash completion appears when the input starts with `/`.

## Skills and tools

The default skills are `cmd`, `raven-code`, and `osint-threat-intel`.
Additional skills cover coding, debugging, testing, Git, web research, OSINT,
CSINT, GEOINT, OPSEC, Discord, security, documentation, and performance.

Useful tools include project inspection, file editing, undo, tests, linting,
builds, Git, web search, page profiling, sitemaps, DNS, WHOIS, certificates,
GEOINT, IOC extraction, confidence scoring, and OPSEC secret scanning.

OSINT tools are passive and bounded. Raven does not perform port scanning,
exploitation, credential testing, authentication bypass, or mass scraping.

Create a skill with:

```text
raven skills create my-skill --description "Skill description"
```

## Configuration example

```json
{
  "backend": {
    "type": "custom",
    "base_url": "http://localhost:20128/v1",
    "model": "your-model",
    "max_tokens": 32768
  },
  "workspace": {
    "path": "C:\\Users\\<user>\\Desktop\\code\\YourProject"
  }
}
```

## Project layout

```text
raven/                    Core Python package
  cli.py                  Terminal interface
  backend.py              Backend client
  core/agent.py           Agent orchestration
  tools.py                Tool registry
  project_tools.py        Workspace inspection
  file_tools.py           File operations and undo
  passive_osint_tools.py  Passive web and GEOINT
  csint_opsec_tools.py    Defensive CSINT and OPSEC
  automation.py           Reminders and ICS export
  integrations.py         Providers and MCP foundation
skills/                   Skill definitions
```

## Publishing and development

Before publishing, run `git status`, `git diff --check`, and inspect `git diff`.
The `.gitignore` excludes virtual environments, sessions, caches, builds,
credentials, local databases, and temporary workspaces.

Syntax check:

```text
python -m compileall -q raven
```

Optional browser support:

```text
python -m pip install -e ".[browser]"
playwright install chromium
```

## License

Raven is distributed under the MIT License. See [LICENSE](LICENSE).
