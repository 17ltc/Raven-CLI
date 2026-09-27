---
name: cmd
description: Execute shell commands with explicit user confirmation for each command. Use this when the user needs to run terminal commands, system operations, or any shell-level tasks. Always requires user approval before execution.
---

# Command Execution Skill

## Scope and ground rules

This skill enables the AI agent to execute shell commands on behalf of the user, with **mandatory user confirmation** for every command. This is a security measure to ensure the user has full control over what gets executed.

**IMPORTANT SECURITY RULES:**
- **EVERY command must be confirmed by the user before execution**
- Never execute commands without showing the user exactly what will run
- Explain what each command does before asking for confirmation
- Never try to hide or obfuscate commands
- Do not execute destructive operations (rm, format, delete, etc.) without explicit warning
- If a user rejects a command, respect their decision and suggest alternatives

**Allowed operations:**
- File system operations (ls, cd, cat, mkdir, etc.)
- System information gathering
- Network operations (ping, curl, wget, etc.)
- Development tools (git, npm, python, etc.)
- Any other safe shell operations

**Explicitly forbidden without extra warnings:**
- Destructive file operations (rm -rf, format, etc.)
- System configuration changes
- Package installations without user awareness
- Any operation that could cause data loss

## Workflow

1. **Identify the need** - When the user requests a shell operation or when system-level information is needed
2. **Formulate the command** - Create the exact shell command that accomplishes the task
3. **Explain and confirm** - Show the user:
   - What the command does
   - Why it's needed
   - Any potential risks
   - The exact command that will be executed
4. **Wait for approval** - Do NOT execute until the user explicitly confirms
5. **Execute or adjust** - Run the command if approved, or modify based on user feedback
6. **Report results** - Show the user the output and explain what happened

## Command examples

### File operations
```bash
# List files in current directory
ls -la

# Create a directory
mkdir new_folder

# View file contents
cat file.txt
```

### System information
```bash
# Check disk space
df -h

# Show running processes
ps aux

# Check memory usage
free -h
```

### Network operations
```bash
# Test connectivity
ping google.com

# Download a file
curl -O https://example.com/file.txt

# Check network configuration
ipconfig  # Windows
ifconfig  # Linux/Mac
```

### Development tools
```bash
# Git operations
git status
git log

# Python operations
python --version
pip list
```

## Confirmation format

When asking for confirmation, use this format:

```
I need to execute the following command:

[bold]COMMAND:[/bold] <exact command>

[bold]PURPOSE:[/bold] <what this accomplishes>

[bold]RISK LEVEL:[/bold] <none/low/medium/high>

[bold]Execute this command? [y/N]:[/bold]
```

## Error handling

If a command fails:
1. Show the error output to the user
2. Explain what went wrong
3. Suggest fixes or alternatives
4. Ask if the user wants to try a different approach

## Safety checks

Before executing any command, perform these mental checks:
- Is this command destructive?
- Could this cause data loss?
- Does this affect system configuration?
- Is the user aware of what this does?
- Have I explained the risks clearly?

If any answer is "yes" and concerning, add extra warnings and be especially clear about risks.
