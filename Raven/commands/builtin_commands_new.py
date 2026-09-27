"""
Built-in commands for Raven CLI
"""

import os
from pathlib import Path
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from typing import Dict, Optional


def register_builtin_commands(
    command_system,
    session_manager,
    target_manager,
    task_queue,
    config_manager
):
    """Register all built-in commands"""
    
    # Help command
    command_system.register(
        name="help",
        description="Show help for commands",
        handler=lambda args, ctx: cmd_help(args, ctx, command_system),
        args_help="[command]",
        examples=["/help", "/help config"]
    )
    
    # Config command
    command_system.register(
        name="config",
        description="Manage configuration (backend, API keys, etc.)",
        handler=lambda args, ctx: cmd_config(args, ctx, config_manager),
        args_help="[set|show|reset] [key] [value]",
        examples=["/config show", "/config set backend ollama", "/config set api_key YOUR_KEY"]
    )
    
    # Restart command
    command_system.register(
        name="restart",
        description="Restart Raven with new configuration",
        handler=lambda args, ctx: cmd_restart(args, ctx),
        examples=["/restart"]
    )
    
    # Session commands
    command_system.register(
        name="session",
        description="Manage sessions",
        handler=lambda args, ctx: cmd_session(args, ctx, session_manager),
        args_help="[list|create|load|delete] [name/id]",
        examples=["/session list", "/session create investigation1", "/session load 20260926_201000"]
    )
    
    # Target commands
    command_system.register(
        name="target",
        description="Manage investigation targets",
        handler=lambda args, ctx: cmd_target(args, ctx, target_manager),
        args_help="[create|list|info|add] [args...]",
        examples=["/target create mathieu", "/target list"]
    )
    
    # Task commands
    command_system.register(
        name="task",
        description="Manage tasks",
        handler=lambda args, ctx: cmd_task(args, ctx, task_queue),
        args_help="[list|status|cancel|stats] [id]",
        examples=["/task list", "/task stats"]
    )
    
    # Skill commands
    command_system.register(
        name="skill",
        description="Load and manage skills dynamically",
        handler=lambda args, ctx: cmd_skill(args, ctx),
        args_help="[load|list|info] [skill_name]",
        examples=["/skill load raven-code", "/skill list", "/skill info frontend-design"]
    )
    
    # Clear command
    command_system.register(
        name="clear",
        description="Clear screen",
        handler=lambda args, ctx: cmd_clear(args, ctx),
        examples=["/clear"]
    )

    command_system.register(
        name="files",
        description="List project files",
        handler=lambda args, ctx: cmd_project_files(args, ctx),
        args_help="[pattern]",
        examples=["/files", "/files *.py"]
    )
    command_system.register(
        name="find",
        description="Search text in the project",
        handler=lambda args, ctx: cmd_project_find(args, ctx),
        args_help="<text>",
        examples=["/find TODO"]
    )
    command_system.register(
        name="diff",
        description="Show the diff for one project file",
        handler=lambda args, ctx: cmd_project_diff(args, ctx),
        args_help="<file>",
        examples=["/diff raven/cli.py"]
    )
    command_system.register(
        name="git",
        description="Show Git status or diff",
        handler=lambda args, ctx: cmd_project_git(args, ctx),
        args_help="[status|diff|log]",
        examples=["/git status", "/git diff"]
    )
    command_system.register(
        name="undo",
        description="Restore the previous version of a workspace file",
        handler=lambda args, ctx: cmd_undo(args, ctx),
        args_help="<file>",
        examples=["/undo src/app.py"]
    )
    for name, tool, description in (
        ("test", "run_tests", "Run the project tests"),
        ("lint", "run_linter", "Run the project linter"),
        ("build", "build_project", "Build the project"),
    ):
        command_system.register(
            name=name,
            description=description,
            handler=lambda args, ctx, tool=tool: cmd_project_action(tool, args, ctx),
            args_help="[path|framework|tool]",
            examples=[f"/{name}"]
        )
    command_system.register(
        name="context",
        description="Summarize the project structure and entry points",
        handler=lambda args, ctx: cmd_project_context(args, ctx),
        examples=["/context"]
    )
    command_system.register(
        name="run",
        description="Run a shell command after explicit confirmation",
        handler=lambda args, ctx: cmd_project_run(args, ctx),
        args_help="<command>",
        examples=["/run pytest", "/run npm test"]
    )
    command_system.register(
        name="reminder",
        description="Create, list or cancel persistent reminders",
        handler=lambda args, ctx: cmd_reminder(args, ctx),
        args_help="[add|list|cancel|export] ...",
        examples=["/reminder add Appeler Paul | in 20m", "/reminder list", "/reminder export calendar.ics"]
    )
    for name, description, handler, args_help in (
        ("plan", "Prepare an execution plan without changing files", cmd_plan, "<objective>"),
        ("doctor", "Diagnose Raven and the current workspace", cmd_doctor, ""),
        ("timeline", "Show recent Raven activity", cmd_timeline, ""),
        ("cost", "Estimate the current context size", cmd_cost, ""),
        ("approve", "Show the safe approval workflow", cmd_approve, ""),
        ("watch", "Inspect workspace changes", cmd_watch, ""),
        ("projects", "Show the active project workspace", cmd_projects, ""),
    ):
        command_system.register(name=name, description=description, handler=lambda args, ctx, fn=handler: fn(args, ctx), args_help=args_help, examples=[f"/{name}"])


def cmd_help(args: str, ctx: Dict, command_system) -> str:
    """Handle help command"""
    console = ctx.get("console", Console())
    
    if not args.strip():
        return command_system.get_help()
    
    return command_system.get_help(args.strip())


def cmd_config(args: str, ctx: Dict, config_manager) -> str:
    """Handle config command"""
    console = ctx.get("console", Console())
    parts = args.strip().split(maxsplit=2)
    
    if not parts or parts[0] == "show":
        return _show_config(config_manager, console)
    
    elif parts[0] == "set":
        if len(parts) < 3:
            return "Usage: /config set <key> <value>\nKeys: backend, model, base_url, api_key, vt_key, abuse_key, shodan_key"
        
        key = parts[1]
        value = parts[2]
        
        if key == "backend":
            config_manager.config.backend.type = value
            config_manager.save()
            return f"Backend set to: {value}"
        
        elif key == "model":
            config_manager.config.backend.model = value
            config_manager.save()
            return f"Model set to: {value}"
        
        elif key == "base_url":
            config_manager.config.backend.base_url = value
            config_manager.save()
            return f"Base URL set to: {value}"
        
        elif key == "api_key":
            config_manager.config.backend.api_key = value
            config_manager.save()
            return "API key set (hidden)"
        
        elif key == "vt_key":
            config_manager.config.api_keys.virustotal = value
            config_manager.save()
            return "VirusTotal API key set (hidden)"
        
        elif key == "abuse_key":
            config_manager.config.api_keys.abuseipdb = value
            config_manager.save()
            return "AbuseIPDB API key set (hidden)"
        
        elif key == "shodan_key":
            config_manager.config.api_keys.shodan = value
            config_manager.save()
            return "Shodan API key set (hidden)"
        
        else:
            return f"Unknown key: {key}"
    
    elif parts[0] == "reset":
        config_manager.reset()
        return "Configuration reset to defaults"
    
    else:
        return "Usage: /config [show|set|reset]"


def _show_config(config_manager, console: Console) -> str:
    """Show current configuration"""
    config = config_manager.get()
    
    table = Table(title="Current Configuration")
    table.add_column("Setting", style="cyan")
    table.add_column("Value", style="green")
    
    # Backend
    table.add_row("Backend Type", config.backend.type)
    table.add_row("Model", config.backend.model)
    table.add_row("Base URL", config.backend.base_url or "default")
    table.add_row("API Key", "***" if config.backend.api_key else "not set")
    table.add_row("Temperature", str(config.backend.temperature))
    
    # API Keys
    table.add_row("VirusTotal Key", "***" if config.api_keys.virustotal else "not set")
    table.add_row("AbuseIPDB Key", "***" if config.api_keys.abuseipdb else "not set")
    table.add_row("Shodan Key", "***" if config.api_keys.shodan else "not set")
    
    # Task Config
    table.add_row("Max Concurrent Tasks", str(config.tasks.max_concurrent))
    table.add_row("Queue Size", str(config.tasks.queue_size))
    
    console.print(table)
    return ""


def cmd_restart(args: str, ctx: Dict) -> str:
    """Handle restart command"""
    # This will be handled by the CLI main loop
    return "Restarting... (handled by CLI)"


def cmd_session(args: str, ctx: Dict, session_manager) -> str:
    """Handle session command"""
    parts = args.strip().split(maxsplit=1)
    
    if not parts or parts[0] == "list":
        sessions = session_manager.list()
        if not sessions:
            return "No sessions found"
        
        output = "Sessions:\n"
        for session in sessions[:10]:
            output += f"  {session.id} - {session.name} ({session.created_at})\n"
        return output
    
    elif parts[0] == "create":
        if len(parts) < 2:
            return "Usage: /session create <name>"
        session = session_manager.create(parts[1])
        return f"Session created: {session.id}"
    
    elif parts[0] == "load":
        if len(parts) < 2:
            return "Usage: /session load <id>"
        cli_instance = ctx.get("cli")
        session = (
            cli_instance.restore_session_context(parts[1])
            if cli_instance
            else session_manager.load(parts[1])
        )
        if session:
            return f"Session loaded: {session.name} ({len(session.entries)} messages restored)"
        return "Session not found"
    
    elif parts[0] == "delete":
        if len(parts) < 2:
            return "Usage: /session delete <id>"
        if session_manager.delete(parts[1]):
            return "Session deleted"
        return "Session not found"
    
    return "Usage: /session [list|create|load|delete]"


def cmd_target(args: str, ctx: Dict, target_manager) -> str:
    """Handle target command"""
    parts = args.strip().split(maxsplit=2)
    
    if not parts or parts[0] == "list":
        targets = target_manager.list()
        if not targets:
            return "No targets found"
        
        output = "Targets:\n"
        for target in targets:
            output += f"  {target.name} ({len(target.identifiers)} identifiers)\n"
        return output
    
    elif parts[0] == "create":
        if len(parts) < 2:
            return "Usage: /target create <name>"
        target = target_manager.create(parts[1])
        return f"Target created: {target.name}"
    
    elif parts[0] == "info":
        if len(parts) < 2:
            return "Usage: /target info <name>"
        target = target_manager.get(parts[1])
        if not target:
            return "Target not found"
        
        output = f"Target: {target.name}\n"
        output += f"Created: {target.created_at}\n"
        output += f"Identifiers: {len(target.identifiers)}\n"
        output += f"Notes: {len(target.notes)}\n"
        output += f"Research entries: {len(target.research)}\n"
        return output
    
    elif parts[0] == "add":
        if len(parts) < 4:
            return "Usage: /target add <name> <type> <value>"
        if target_manager.add_identifier(parts[1], parts[2], parts[3]):
            return f"Identifier added to {parts[1]}"
        return "Target not found or error adding identifier"
    
    return "Usage: /target [list|create|info|add]"


def cmd_task(args: str, ctx: Dict, task_queue) -> str:
    """Handle task command"""
    parts = args.strip().split(maxsplit=1)
    
    if not parts or parts[0] == "list":
        tasks = task_queue.list()
        if not tasks:
            return "No tasks found"
        
        output = "Tasks:\n"
        for task in tasks[:10]:
            output += f"  {task['id']} - {task['name']} ({task['status']})\n"
        return output
    
    elif parts[0] == "stats":
        stats = task_queue.get_stats()
        output = "Task Statistics:\n"
        for key, value in stats.items():
            output += f"  {key}: {value}\n"
        return output
    
    elif parts[0] == "status":
        if len(parts) < 2:
            return "Usage: /task status <task_id>"
        status = task_queue.get_status(parts[1])
        if not status:
            return "Task not found"
        return str(status)
    
    elif parts[0] == "cancel":
        if len(parts) < 2:
            return "Usage: /task cancel <task_id>"
        if task_queue.cancel(parts[1]):
            return "Task cancelled"
        return "Task not found or cannot be cancelled"
    
    return "Usage: /task [list|stats|status|cancel]"


def cmd_clear(args: str, ctx: Dict) -> str:
    """Handle clear command"""
    import os
    os.system('cls' if os.name == 'nt' else 'clear')
    return ""


def cmd_project_files(args: str, ctx: Dict) -> str:
    cli = ctx.get("cli")
    if not cli:
        return "Project context unavailable"
    pattern = args.strip() or "*"
    files = cli.project_tools.files(pattern)
    return "\n".join(files) if files else "No matching files"


def cmd_project_find(args: str, ctx: Dict) -> str:
    cli = ctx.get("cli")
    query = args.strip()
    if not cli or not query:
        return "Usage: /find <text>"
    results = cli.project_tools.search(query)
    return "\n".join(f"{r['file']}:{r['line']}  {r['text']}" for r in results) if results else "No matches"


def cmd_project_diff(args: str, ctx: Dict) -> str:
    cli = ctx.get("cli")
    path = args.strip()
    if not cli or not path:
        return "Usage: /diff <file>"
    result = cli.project_tools.diff_file(path)
    if not result.get("success"):
        return result.get("error", "Unable to read diff")
    return result.get("output") or "No Git changes for this file"


def cmd_project_git(args: str, ctx: Dict) -> str:
    cli = ctx.get("cli")
    action = args.strip() or "status"
    if action not in {"status", "diff", "log"}:
        return "Usage: /git [status|diff|log]"
    git_args = [action]
    if action == "log":
        git_args.extend(["--oneline", "-10"])
    result = cli.project_tools.git(*git_args)
    return result["output"] or result["error"] or "No output"


def cmd_undo(args: str, ctx: Dict) -> str:
    path = args.strip()
    cli = ctx.get("cli")
    if not cli or not path:
        return "Usage: /undo <file>"
    result = cli.tool_registry.execute("undo_file", {"path": path})
    return result.get("error") or f"Restored {result.get('path', path)}"


def cmd_project_action(tool: str, args: str, ctx: Dict) -> str:
    cli = ctx.get("cli")
    if not cli:
        return "Project context unavailable"
    result = cli.tool_registry.execute(tool, {})
    if result.get("error"):
        return result["error"]
    output = result.get("output") or result.get("errors") or "completed"
    return str(output)


def cmd_project_context(args: str, ctx: Dict) -> str:
    cli = ctx.get("cli")
    if not cli:
        return "Project context unavailable"
    files = cli.project_tools.files()
    important = [path for path in files if Path(path).name.lower() in {
        "readme.md", "pyproject.toml", "package.json", "cargo.toml", "dockerfile"
    }]
    return "Project: " + str(cli.project_tools.root) + "\nFiles: " + str(len(files)) + "\nEntry points:\n" + (
        "\n".join(f"  {path}" for path in important) if important else "  none detected"
    )


def cmd_project_run(args: str, ctx: Dict) -> str:
    command = args.strip()
    cli = ctx.get("cli")
    if not cli or not command:
        return "Usage: /run <command>"
    result = cli.tool_registry.execute("execute_command", {"command": command})
    return result.get("output") or result.get("error") or str(result)


def cmd_skill(args: str, ctx: Dict) -> str:
    """Handle skill commands"""
    console = ctx.get("console", Console())
    cli_instance = ctx.get("cli")
    parts = args.strip().split(maxsplit=2)
    
    # Use the correct skills root from CLI instance
    skills_root = cli_instance.skills_root if cli_instance else Path.cwd() / "skills"
    
    # If no arguments or "list", show available skills
    if not parts or parts[0] == "list":
        from raven.skills_manager import list_skills
        skills = list_skills(skills_root)
        
        if not skills:
            return "No skills found in skills/ directory"
        
        output = "Available skills:\n"
        for skill in skills:
            output += f"  [cyan]{skill.name}[/cyan] - {skill.description}\n"
        return output
    
    if len(parts) >= 2 and parts[1] in ("enable", "disable"):
        skill_name = parts[0]
        enabled = parts[1] == "enable"
        if not cli_instance:
            return "Error: CLI instance not available"
        success, message = cli_instance.set_skill_enabled(skill_name, enabled)
        return f"[green]{message}[/green]" if success else f"[red]{message}[/red]"

    if parts[0] in ("enable", "disable"):
        if len(parts) < 2:
            return f"Usage: /skill <name> {parts[0]}"
        skill_name = parts[1]
        enabled = parts[0] == "enable"
        if not cli_instance:
            return "Error: CLI instance not available"
        success, message = cli_instance.set_skill_enabled(skill_name, enabled)
        return f"[green]{message}[/green]" if success else f"[red]{message}[/red]"

    # If "load" command or just skill name, load the skill
    if parts[0] == "load":
        if len(parts) < 2:
            return "Usage: /skill load <skill_name>"
        skill_name = parts[1]
    else:
        # Direct skill name (e.g., "/skill frontend-design")
        skill_name = parts[0]
    
    if not cli_instance:
        return "Error: CLI instance not available for dynamic skill loading"
    
    # Call the CLI's load_skill method
    success, message = cli_instance.load_skill(skill_name)
    
    if success:
        return f"[green]{message}[/green]"
    else:
        return f"[red]{message}[/red]"


def cmd_reminder(args: str, ctx: Dict) -> str:
    """Manage reminders persisted in ~/.raven/automations.json."""
    cli = ctx.get("cli")
    if not cli:
        return "Reminder system unavailable"
    parts = args.strip().split(maxsplit=1)
    action = parts[0].lower() if parts else "list"
    if action == "list":
        result = cli.tool_registry.execute("reminder_list", {})
        items = result if isinstance(result, list) else result.get("result", result)
        if not items:
            return "No active reminders"
        return "\n".join(f"{item['id']}  {item['run_at']}  {item['title']}" for item in items)
    if action == "add" and len(parts) > 1:
        fields = [value.strip() for value in parts[1].split("|", 1)]
        if len(fields) != 2:
            return "Usage: /reminder add <title> | <when>"
        result = cli.tool_registry.execute("reminder_create", {"title": fields[0], "when": fields[1]})
        return str(result.get("error") or result.get("reminder", result))
    if action == "cancel" and len(parts) > 1:
        result = cli.tool_registry.execute("reminder_cancel", {"reminder_id": parts[1].strip()})
        return str(result.get("error") or result)
    if action == "export" and len(parts) > 1:
        result = cli.tool_registry.execute("calendar_export_ics", {"output": parts[1].strip()})
        return str(result.get("error") or result)
    return "Usage: /reminder [list|add <title> | <when>|cancel <id>|export <file.ics>]"


def cmd_plan(args: str, ctx: Dict) -> str:
    objective = args.strip()
    if not objective:
        return "Usage: /plan <objective>"
    return "PLAN ONLY\n1. Inspect the workspace and relevant files\n2. Identify constraints and risks\n3. Propose the smallest implementation steps\n4. Define verification commands\n\nObjective: " + objective + "\nNo files were changed."


def cmd_doctor(args: str, ctx: Dict) -> str:
    cli = ctx.get("cli")
    if not cli:
        return "Raven CLI unavailable"
    checks = {"backend": bool(cli.backend), "tools": len(cli.tool_registry.list()), "workspace": str(cli.project_tools.root), "skills": len(cli._available_skill_names())}
    return "\n".join(f"{key}: {value}" for key, value in checks.items())


def cmd_timeline(args: str, ctx: Dict) -> str:
    path = Path.home() / ".raven" / "audit.log"
    if not path.exists():
        return "No Raven activity recorded yet"
    return "\n".join(path.read_text(encoding="utf-8").splitlines()[-30:])


def cmd_cost(args: str, ctx: Dict) -> str:
    cli = ctx.get("cli")
    if not cli or not cli.agent:
        return "No active agent context"
    text = "\n".join(str(message.get("content", "")) for message in cli.agent.messages)
    result = cli.tool_registry.execute("context_budget", {"text": text})
    return str(result)


def cmd_approve(args: str, ctx: Dict) -> str:
    return "Sensitive actions use a human-only confirmation code. Raven never accepts approval from model output."


def cmd_watch(args: str, ctx: Dict) -> str:
    cli = ctx.get("cli")
    if not cli:
        return "Workspace unavailable"
    result = cli.tool_registry.execute("project_map", {"max_depth": 2})
    return str(result)


def cmd_projects(args: str, ctx: Dict) -> str:
    cli = ctx.get("cli")
    return str(cli.project_tools.root) if cli else "Workspace unavailable"
