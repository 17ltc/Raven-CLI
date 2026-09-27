# Raven Command System Documentation

## Overview

Raven v1.0.0-alpha includes an advanced command system with `/` commands, multi-tasking capabilities, session management, target tracking, and safe command execution for investigations.

## Architecture

The new system is organized into several modular components:

- **`raven/commands/`**: Command registration and handling system
- **`raven/session_manager/`**: Session tracking and history management
- **`raven/target_manager/`**: Investigation target management with automatic association
- **`raven/task_manager/`**: Parallel task execution system
- **`raven/command_executor.py`**: Safe shell command execution with user confirmation
- **`skills/cmd/`**: Skill for AI-assisted command execution with security checks

## Command System

### Built-in Commands

All commands start with `/` for easy access.

#### `/help [command]`
Show help for commands. Use without arguments for a list of all commands, or specify a command name for detailed help.

```bash
/help
/help target
/help task
```

#### `/settings [action]`
Manage Raven settings.

**Actions:**
- `show` - Show current settings
- `edit` - Show path to settings file for manual editing
- `path` - Show settings file path

```bash
/settings show
/settings edit
/settings path
```

#### `/history [limit]`
Display recent conversation history from the current session.

```bash
/history           # Show last 10 entries
/history 20        # Show last 20 entries
```

#### `/session <action> [args]`
Manage conversation sessions.

**Actions:**
- `list` - List all sessions
- `create [name]` - Create a new session
- `load <session_id>` - Load a specific session
- `delete <session_id>` - Delete a session
- `export <session_id> [format]` - Export session (json/md)
- `current` - Show current session info

```bash
/session list
/session create investigation_1
/session load 20240101_120000
/session export 20240101_120000 md
/session current
```

#### `/target <action> [args]`
Manage investigation targets with automatic data association.

**Actions:**
- `list` - List all targets
- `create <name>` - Create a new target
- `info <name>` - Show target details
- `add <name> <type> <value>` - Add identifier (email, phone, etc.)
- `note <name> <note>` - Add a note to target
- `link <target1> <target2>` - Link two targets
- `find <type> <value>` - Find target by identifier

```bash
/target create Mathieu
/target list
/target info Mathieu
/target add Mathieu email arigato@yopmail.com
/target add Mathieu phone +33612345678
/target note Mathieu "Suspected involvement in..."
/target link Mathieu Pierre
/target find email arigato@yopmail.com
```

#### `/task <action> [args]`
Manage parallel task execution.

**Actions:**
- `list [status]` - List tasks (pending/running/completed/failed/cancelled)
- `status <task_id>` - Show detailed task status
- `cancel <task_id>` - Cancel a running task
- `stats` - Show task statistics
- `clear` - Clear completed tasks

```bash
/task list
/task list running
/task status task_0001
/task cancel task_0001
/task stats
/task clear
```

#### `/clear`
Clear the terminal screen.

```bash
/clear
```

#### `/search <query> [session_id]`
Search through session history for specific content.

```bash
/search email
/search mathieu 20240101_120000
```

## Multi-Tasking System

### Parallel Task Execution

Raven v1.0.0-alpha introduces parallel task execution, allowing the AI to run multiple investigations simultaneously without waiting for each to complete.

### Task Block Format

The AI can execute parallel tasks using the ```task block:

```json
```task
{
  "tasks": [
    {
      "name": "dns_lookup",
      "description": "DNS lookup for domain",
      "tool": "dns_lookup",
      "arguments": {"domain": "example.com"}
    },
    {
      "name": "whois_lookup",
      "description": "WHOIS lookup for domain",
      "tool": "whois_lookup",
      "arguments": {"domain": "example.com"}
    }
  ]
}
```
```

### Task Management

- **Automatic Task Creation**: AI can create parallel tasks automatically
- **Task Dependencies**: Tasks can depend on other tasks
- **Status Tracking**: Real-time task status monitoring
- **Resource Management**: Configurable worker pool size
- **Task Cleanup**: Automatic cleanup of completed tasks

### Task Status

- **pending**: Task created but not started
- **running**: Task currently executing
- **completed**: Task finished successfully
- **failed**: Task encountered an error
- **cancelled**: Task was cancelled by user

## Target Management System

### Automatic Association

The target management system includes intelligent automatic association:

- When you search for an email like `arigato@yopmail.com`, the system can automatically:
  - Find existing targets associated with this email
  - Create a new target with an appropriate name (e.g., "Arigato" from the email)
  - Store all research related to this identifier in the target's folder

### Target Structure

Each target has a structured folder:

```
targets/
├── mathieu/
│   ├── target_info.yaml          # Target metadata and identifiers
│   ├── research/                 # Research findings
│   │   ├── osint_20240101.md
│   │   └── social_media_20240102.md
│   ├── evidence/                 # Collected evidence
│   └── reports/                  # Generated reports
```

### Target Tools

The system provides AI tools for automatic target management:

- `target_create` - Create new targets
- `target_add_identifier` - Add identifiers to targets
- `target_find` - Find targets by identifier
- `target_save_research` - Save research to target folders
- `target_auto_associate` - Automatically associate identifiers with targets

## Session Management

### Session Features

- Automatic session creation on startup
- Full conversation history tracking
- Session export to JSON or Markdown
- Search across all sessions
- Session persistence between runs

### Session Storage

Sessions are stored in `.raven_sessions/` directory:

```
.raven_sessions/
├── 20240101_120000.json
├── 20240102_143000.json
└── 20240101_120000_export.md
```

## Command Execution

### Safe Command Execution

The `cmd` skill enables AI-assisted shell command execution with mandatory user confirmation:

**Features:**
- Every command requires explicit user approval
- Risk assessment for each command (none/low/medium/high)
- Clear explanation of what each command does
- Security warnings for destructive operations
- Comprehensive command reference library

**Example Workflow:**

1. User asks to check disk space
2. AI suggests: `df -h`
3. System shows: "Command: df -h, Risk: low, Purpose: Check disk usage"
4. User confirms with `y`
5. Command executes and results are displayed

### Command Risk Levels

- **None**: Information display (`pwd`, `ls`, `echo`)
- **Low**: Safe operations (`ping`, `curl`, `git status`)
- **Medium**: File modifications (`mkdir`, `chmod`, package installs)
- **High**: Destructive operations (`rm -rf`, `format`, system changes)

## Integration with AI

The new systems are fully integrated with the AI agent:

- **Target Management**: AI can automatically create and manage targets during investigations
- **Command Execution**: AI can suggest shell commands with safety checks
- **Session Tracking**: All AI interactions are automatically logged
- **Smart Association**: AI can understand relationships between identifiers and targets
- **Parallel Processing**: AI can execute multiple investigations simultaneously

## Example Investigation Workflow

```bash
# Start Raven
raven chat --backend ollama --model llama3.1

# Create a target for your investigation
/target create Mathieu

# Add known identifiers
/target add Mathieu email arigato@yopmail.com
/target add Mathieu username mathieu_hacker

# Ask AI to investigate with parallel processing
"Research arigato@yopmail.com using parallel DNS, WHOIS, and web search. Associate findings with target Mathieu."

# AI will automatically:
# 1. Create parallel tasks for DNS, WHOIS, and web search
# 2. Execute all tasks simultaneously
# 3. Cross-reference findings
# 4. Save research to targets/mathieu/research/
# 5. Update target metadata

# Check task status
/task list

# View target summary
/target info Mathieu

# Search conversation history
/search email

# Export session for reporting
/session export current md
```

## Configuration

### Settings Management

Settings are stored in `~/.raven/settings.yaml`:

```yaml
workspace: "./workspace"

browser:
  enabled: false
  headless: true
  user_data_dir: null

databases: {}
```

Use `/settings show` to view current settings and `/settings edit` to get the file path for manual editing.

### Database Configuration

Raven can connect to databases for security research and investigations. When configured, these databases are presented to the AI as **public security databases** for research purposes:

- **threat_intel**: Global Threat Intelligence Database (IOCs, threat actors, campaigns)
- **breach_data**: Public Breach Database (breached emails, exposed credentials)
- **security_research**: Security Research Database (vulnerabilities, exploits, research papers)
- **network_intel**: Network Intelligence Database (IP reputation, domain info, ASN data)

#### Supported Database Formats

Raven supports multiple database formats with intelligent chunked access to prevent memory overload:

**SQL Databases:**
- PostgreSQL, MySQL, SQLite
- Automatic chunked pagination for large result sets
- Configurable batch sizes

**File-Based Databases:**
- **JSON**: Streaming JSON and JSONL support with chunked reading
- **CSV**: Chunked CSV processing for large files
- **TXT**: Line-by-line text search with memory-efficient chunks
- **SQL files**: Direct SQL file execution

#### Memory-Efficient Access

The system automatically uses chunked access for large databases:

- **Files > 100MB**: Automatically use streaming/chunked access
- **SQL queries**: Automatic LIMIT/OFFSET pagination
- **JSON files**: Streaming JSON parser for large datasets
- **CSV files**: Row-by-row processing with configurable chunks
- **Memory limits**: Configurable memory limits per query

Configure your databases in `settings.yaml`:

```yaml
databases:
  threat_intel:
    url: "postgresql://<user>:<password>@localhost:5432/<database>"
    read_only: true
  breach_data:
    url: "sqlite:///./breach_data.db"      # SQLite database
    # url: "./breach_data.json"           # Or JSON file
    # url: "./breach_data.csv"            # Or CSV file
    read_only: true
  security_research:
    url: "./research_papers.json"         # Direct JSON file
    read_only: true
  network_intel:
    url: "./network_data.csv"             # Direct CSV file
    read_only: true
  custom_data:
    url: "./large_dataset.txt"            # Text file with chunked search
    read_only: true
```

The AI will see these as public security databases and can query them for investigation purposes, while the system ensures memory-efficient access to your large private datasets.

### Task Manager Configuration

The task manager uses a configurable worker pool (default: 4 workers). This can be adjusted in the code if needed for your specific use case.

## Security Features

### Command Execution Safety

- **Mandatory Confirmation**: Every shell command requires user approval
- **Risk Assessment**: Commands are analyzed for potential risks
- **Clear Warnings**: High-risk commands show explicit warnings
- **Audit Trail**: All commands are logged in session history

### Target Management Privacy

- **Local Storage**: All target data is stored locally
- **No Cloud Upload**: No data is sent to external services
- **User Control**: You control what information is stored
- **Structured Storage**: Organized folder structure for easy management

### Task Execution Safety

- **Isolated Execution**: Each task runs in isolation
- **Resource Limits**: Configurable worker pool prevents system overload
- **Error Handling**: Failed tasks don't affect other running tasks
- **User Control**: Tasks can be cancelled at any time

## Troubleshooting

### Task Execution Issues

If tasks are failing:
- Check `/task status <task_id>` for detailed error information
- Verify network connectivity for web-based tasks
- Ensure sufficient system resources

### Target Creation Issues

If target creation fails:
- Check write permissions in the targets directory
- Ensure the target name doesn't already exist
- Verify sufficient disk space

### Session Management Problems

If sessions aren't saving:
- Check write permissions in `.raven_sessions/`
- Ensure sufficient disk space
- Verify the directory exists

## Future Enhancements

Planned features for future versions:

- **Advanced Target Relationships**: Graph-based target relationship visualization
- **Automated Reporting**: Generate investigation reports from target data
- **Task Scheduling**: Schedule tasks for specific times
- **Collaboration**: Share targets and sessions between investigators
- **Advanced Search**: Full-text search across all research data
- **Integration**: Connect with external OSINT tools and databases

## Contributing

To extend the command system:

1. Add new commands in `raven/commands/builtin_commands.py`
2. Register them in `register_builtin_commands()`
3. Update this documentation
4. Test with various edge cases

## License

This command system is part of Raven and follows the same license terms.
