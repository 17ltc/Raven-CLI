from __future__ import annotations

from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from pathlib import Path

from ..session_manager import SessionManager
from ..target_manager import TargetManager
from ..task_manager import TaskManager
from ..config import DEFAULT_SETTINGS_PATH, load_settings


def register_builtin_commands(registry, session_manager: SessionManager, target_manager: TargetManager, task_manager: TaskManager = None):
    """Register all built-in commands with the registry."""
    
    # Help command
    registry.register(
        name="help",
        description="Show help for commands",
        handler=lambda args, console: cmd_help(args, console, registry),
        args_help="[command]",
        examples=["/help", "/help target"]
    )
    
    # Settings command
    registry.register(
        name="settings",
        description="Show or edit settings",
        handler=lambda args, console: cmd_settings(args, console),
        args_help="[action]",
        examples=["/settings", "/settings show", "/settings edit"]
    )
    
    # History command
    registry.register(
        name="history",
        description="Show conversation history",
        handler=lambda args, console: cmd_history(args, console, session_manager),
        args_help="[limit]",
        examples=["/history", "/history 20"]
    )
    
    # Session commands
    registry.register(
        name="session",
        description="Manage sessions (create, list, load, delete, export)",
        handler=lambda args, console: cmd_session(args, console, session_manager),
        args_help="<action> [args]",
        examples=["/session list", "/session create my_session", "/session load 20240101_120000", "/session delete 20240101_120000"]
    )
    
    # Target commands
    registry.register(
        name="target",
        description="Manage investigation targets",
        handler=lambda args, console: cmd_target(args, console, target_manager),
        args_help="<action> [args]",
        examples=["/target create Mathieu", "/target list", "/target info Mathieu", "/target add Mathieu email arigato@yopmail.com"]
    )
    
    # Task commands
    if task_manager:
        registry.register(
            name="task",
            description="Manage parallel tasks",
            handler=lambda args, console: cmd_task(args, console, task_manager),
            args_help="<action> [args]",
            examples=["/task list", "/task status task_0001", "/task cancel task_0001"]
        )
    
    # Clear command
    registry.register(
        name="clear",
        description="Clear the terminal screen",
        handler=lambda args, console: cmd_clear(args, console),
        examples=["/clear"]
    )
    
    # Search command
    registry.register(
        name="search",
        description="Search through session history",
        handler=lambda args, console: cmd_search(args, console, session_manager),
        args_help="<query> [session_id]",
        examples=["/search email", "/search mathieu 20240101_120000"]
    )
    
    # Tools command
    registry.register(
        name="tools",
        description="List available tools",
        handler=lambda args, console: cmd_tools(args, console),
        examples=["/tools"]
    )


def cmd_help(args: str, console: Console, registry) -> str:
    """Handle help command."""
    if args and args.strip():
        return registry.get_help_text(args.strip())
    return registry.get_help_text()


def cmd_settings(args: str, console: Console) -> str:
    """Handle settings command."""
    action = args.strip().lower() if args and args.strip() else "show"
    
    if action == "show":
        settings_path = DEFAULT_SETTINGS_PATH
        if not settings_path.exists():
            return f"[yellow]Settings file not found at {settings_path}[/yellow]"
        
        try:
            config = load_settings(settings_path)
            output = f"[bold cyan]Settings:[/bold cyan] {settings_path}\n\n"
            
            for key, value in config.items():
                if isinstance(value, dict):
                    output += f"[bold]{key}:[/bold]\n"
                    for subkey, subvalue in value.items():
                        output += f"  {subkey}: {subvalue}\n"
                else:
                    output += f"[bold]{key}:[/bold] {value}\n"
            
            return output
        except Exception as e:
            return f"[red]Error loading settings:[/red] {e}"
    
    elif action == "edit":
        settings_path = DEFAULT_SETTINGS_PATH
        console.print(f"[cyan]To edit settings, open the file:[/cyan] {settings_path}")
        console.print("[dim]After editing, restart Raven for changes to take effect.[/dim]")
        return ""
    
    elif action == "path":
        return f"Settings file: [cyan]{DEFAULT_SETTINGS_PATH}[/cyan]"
    
    else:
        return """[bold cyan]Settings Commands:[/bold cyan]

  [cyan]/settings show[/cyan]    - Show current settings
  [cyan]/settings edit[/cyan]    - Show path to settings file for editing
  [cyan]/settings path[/cyan]    - Show settings file path
"""


def cmd_history(args: str, console: Console, session_manager: SessionManager) -> str:
    """Handle history command."""
    try:
        limit = int(args.strip()) if args and args.strip() else 10
    except ValueError:
        return "[red]Invalid limit. Usage: /history [limit][/red]"
    
    history = session_manager.get_history(limit)
    if not history:
        return "[yellow]No history available[/yellow]"
    
    output = "[bold cyan]Recent conversation history:[/bold cyan]\n\n"
    for entry in history:
        role_color = "green" if entry.role == "user" else "blue"
        output += f"[{role_color}]{entry.role.upper()}[/{role_color}] [{entry.timestamp}]\n"
        output += f"{entry.content[:200]}{'...' if len(entry.content) > 200 else ''}\n\n"
    
    return output


def cmd_session(args: str, console: Console, session_manager: SessionManager) -> str:
    """Handle session command."""
    if not args or not args.strip():
        return cmd_session_help(console)
    
    parts = args.strip().split()
    action = parts[0].lower()
    action_args = ' '.join(parts[1:]) if len(parts) > 1 else None
    
    if action == "list":
        session_manager.display_sessions_table()
        return ""
    
    elif action == "create":
        name = action_args if action_args else None
        session = session_manager.create_session(name)
        return f"Created session: {session.name} (ID: {session.session_id})"
    
    elif action == "load":
        if not action_args:
            return "[red]Usage: /session load <session_id>[/red]"
        session = session_manager.load_session(action_args)
        if session:
            return f"Loaded session: {session.name}"
        return "[red]Failed to load session[/red]"
    
    elif action == "delete":
        if not action_args:
            return "[red]Usage: /session delete <session_id>[/red]"
        if session_manager.delete_session(action_args):
            return f"Deleted session: {action_args}"
        return f"[red]Session {action_args} not found[/red]"
    
    elif action == "export":
        if not action_args:
            return "[red]Usage: /session export <session_id> [format][/red]"
        export_parts = action_args.split()
        session_id = export_parts[0]
        format = export_parts[1] if len(export_parts) > 1 else "json"
        try:
            path = session_manager.export_session(session_id, format)
            return f"Exported session to: {path}"
        except Exception as e:
            return f"[red]Error exporting session:[/red] {e}"
    
    elif action == "current":
        current = session_manager.get_current_session()
        if current:
            return f"Current session: {current.name} (ID: {current.session_id})"
        return "[yellow]No current session active[/yellow]"
    
    else:
        return cmd_session_help(console)


def cmd_session_help(console: Console) -> str:
    """Show session command help."""
    return """[bold cyan]Session Commands:[/bold cyan]

  [cyan]/session list[/cyan]                    - List all sessions
  [cyan]/session create [name][/cyan]          - Create a new session
  [cyan]/session load <session_id>[/cyan]      - Load a session
  [cyan]/session delete <session_id>[/cyan]    - Delete a session
  [cyan]/session export <session_id> [format][/cyan] - Export session (json/md)
  [cyan]/session current[/cyan]                 - Show current session
"""


def cmd_target(args: str, console: Console, target_manager: TargetManager) -> str:
    """Handle target command."""
    if not args or not args.strip():
        return cmd_target_help(console)
    
    parts = args.strip().split()
    action = parts[0].lower()
    action_args = ' '.join(parts[1:]) if len(parts) > 1 else None
    
    if action == "list":
        targets = target_manager.list_targets()
        if not targets:
            return "[yellow]No targets found[/yellow]"
        
        table = Table(title="Targets")
        table.add_column("Name", style="cyan")
        table.add_column("Created", style="dim")
        table.add_column("Identifiers", style="green")
        
        for target in targets:
            id_count = sum(len(ids) for ids in target.identifiers.values())
            table.add_row(
                target.name,
                target.created_at[:10],
                str(id_count)
            )
        
        console.print(table)
        return ""
    
    elif action == "create":
        if not action_args:
            return "[red]Usage: /target create <name>[/red]"
        try:
            target = target_manager.create_target(action_args)
            return f"Created target: {target.name}"
        except FileExistsError as e:
            return f"[red]{e}[/red]"
    
    elif action == "info":
        if not action_args:
            return "[red]Usage: /target info <name>[/red]"
        return target_manager.get_target_summary(action_args)
    
    elif action == "add":
        if not action_args or len(parts) < 4:
            return "[red]Usage: /target add <target_name> <type> <value>[/red]"
        target_name = parts[1]
        id_type = parts[2]
        value = ' '.join(parts[3:])
        try:
            target_manager.add_identifier(target_name, id_type, value)
            return f"Added {id_type} to {target_name}"
        except FileNotFoundError as e:
            return f"[red]{e}[/red]"
    
    elif action == "note":
        if not action_args or len(parts) < 3:
            return "[red]Usage: /target note <target_name> <note_text>[/red]"
        target_name = parts[1]
        note = ' '.join(parts[2:])
        try:
            target_manager.add_note(target_name, note)
            return f"Added note to {target_name}"
        except FileNotFoundError as e:
            return f"[red]{e}[/red]"
    
    elif action == "link":
        if not action_args or len(parts) < 3:
            return "[red]Usage: /target link <target1> <target2>[/red]"
        target1 = parts[1]
        target2 = parts[2]
        try:
            target_manager.link_targets(target1, target2)
            return f"Linked {target1} and {target2}"
        except FileNotFoundError as e:
            return f"[red]{e}[/red]"
    
    elif action == "find":
        if not action_args or len(parts) < 3:
            return "[red]Usage: /target find <type> <value>[/red]"
        id_type = parts[1]
        value = parts[2]
        target = target_manager.find_target_by_identifier(id_type, value)
        if target:
            return f"Found target: {target.name}\n{target_manager.get_target_summary(target.name)}"
        return f"[yellow]No target found with {id_type}: {value}[/yellow]"
    
    else:
        return cmd_target_help(console)


def cmd_target_help(console: Console) -> str:
    """Show target command help."""
    return """[bold cyan]Target Commands:[/bold cyan]

  [cyan]/target list[/cyan]                          - List all targets
  [cyan]/target create <name>[/cyan]                - Create a new target
  [cyan]/target info <name>[/cyan]                  - Show target details
  [cyan]/target add <name> <type> <value>[/cyan]    - Add identifier (email, phone, etc.)
  [cyan]/target note <name> <note>[/cyan]           - Add a note to target
  [cyan]/target link <target1> <target2>[/cyan]     - Link two targets
  [cyan]/target find <type> <value>[/cyan]          - Find target by identifier
"""


def cmd_task(args: str, console: Console, task_manager: TaskManager) -> str:
    """Handle task command."""
    if not args or not args.strip():
        return cmd_task_help(console)
    
    parts = args.strip().split()
    action = parts[0].lower()
    action_args = ' '.join(parts[1:]) if len(parts) > 1 else None
    
    if action == "list":
        status_filter = None
        if action_args:
            from ..task_manager import TaskStatus
            try:
                status_filter = TaskStatus(action_args.lower())
            except ValueError:
                return f"[red]Invalid status: {action_args}[/red]"
        
        task_manager.display_tasks(status_filter)
        return ""
    
    elif action == "status":
        if not action_args:
            return "[red]Usage: /task status <task_id>[/red]"
        task = task_manager.get_task(action_args)
        if not task:
            return f"[red]Task {action_args} not found[/red]"
        
        output = f"[bold cyan]Task: {task.name}[/bold cyan] ([cyan]{task.task_id}[/cyan])\n"
        output += f"[dim]Status: {task.status.value}[/dim]\n"
        output += f"[dim]Created: {task.created_at}[/dim]\n"
        if task.started_at:
            output += f"[dim]Started: {task.started_at}[/dim]\n"
        if task.completed_at:
            output += f"[dim]Completed: {task.completed_at}[/dim]\n"
        if task.description:
            output += f"\n[bold]Description:[/bold] {task.description}\n"
        if task.dependencies:
            output += f"[bold]Dependencies:[/bold] {', '.join(task.dependencies)}\n"
        if task.result:
            output += f"\n[bold]Result:[/bold]\n{task.result}\n"
        if task.error:
            output += f"\n[red]Error:[/red] {task.error}\n"
        
        return output
    
    elif action == "cancel":
        if not action_args:
            return "[red]Usage: /task cancel <task_id>[/red]"
        if task_manager.cancel_task(action_args):
            return f"Task {action_args} cancelled"
        return f"[red]Failed to cancel task {action_args}[/red]"
    
    elif action == "stats":
        stats = task_manager.get_statistics()
        output = "[bold cyan]Task Statistics:[/bold cyan]\n"
        for key, value in stats.items():
            output += f"  {key}: {value}\n"
        return output
    
    elif action == "clear":
        count = task_manager.clear_completed()
        return f"Cleared {count} completed tasks"
    
    else:
        return cmd_task_help(console)


def cmd_task_help(console: Console) -> str:
    """Show task command help."""
    return """[bold cyan]Task Commands:[/bold cyan]

  [cyan]/task list [status][/cyan]           - List tasks (pending/running/completed/failed/cancelled)
  [cyan]/task status <task_id>[/cyan]        - Show detailed task status
  [cyan]/task cancel <task_id>[/cyan]        - Cancel a running task
  [cyan]/task stats[/cyan]                   - Show task statistics
  [cyan]/task clear[/cyan]                   - Clear completed tasks
"""


def cmd_clear(args: str, console: Console) -> str:
    """Handle clear command."""
    console.clear()
    return ""


def cmd_search(args: str, console: Console, session_manager: SessionManager) -> str:
    """Handle search command."""
    if not args or not args.strip():
        return "[red]Usage: /search <query> [session_id][/red]"
    
    parts = args.strip().split()
    query = parts[0]
    session_id = parts[1] if len(parts) > 1 else None
    
    results = session_manager.search_history(query, session_id)
    
    if not results:
        return f"[yellow]No results found for '{query}'[/yellow]"
    
    output = f"[bold cyan]Found {len(results)} results for '{query}':[/bold cyan]\n\n"
    for result in results:
        output += f"[dim]Session: {result['session_name']} ({result['session_id']})[/dim]\n"
        output += f"[{result['role'].upper()}] {result['timestamp']}\n"
        output += f"{result['content'][:150]}{'...' if len(result['content']) > 150 else ''}\n\n"
    
    return output


def cmd_tools(args: str, console: Console) -> str:
    """Handle tools command."""
    from ..tools import TOOLS, build_registry
    from ..config import load_settings, DEFAULT_SETTINGS_PATH
    
    # Build registry to get all available tools
    config = load_settings(DEFAULT_SETTINGS_PATH)
    registry = build_registry(config)
    
    output = "[bold cyan]Available Tools:[/bold cyan]\n\n"
    
    # Group tools by category
    tool_categories = {
        "Web & Network": ["web_search", "web_fetch", "whois_lookup", "dns_lookup", "reverse_dns", "crtsh_lookup"],
        "Reputation": ["virustotal_lookup", "abuseipdb_lookup", "shodan_lookup"],
        "File Operations": ["write_file", "list_workspace", "delete_file"],
        "Command Execution": ["execute_command"],
        "Target Management": ["target_create", "target_add_identifier", "target_find", "target_save_research", "target_auto_associate"],
        "Advanced": ["advanced_ip_lookup", "self_reflection"]
    }
    
    for category, tool_names in tool_categories.items():
        category_tools = []
        for tool_name in tool_names:
            if tool_name in registry:
                tool_info = registry[tool_name]
                category_tools.append(f"  [cyan]{tool_name}[/cyan]: {tool_info['description']}")
        
        if category_tools:
            output += f"[bold]{category}:[/bold]\n"
            output += "\n".join(category_tools) + "\n\n"
    
    # Add remaining tools not in categories
    uncategorized = []
    for tool_name, tool_info in registry.items():
        if not any(tool_name in tools for tools in tool_categories.values()):
            uncategorized.append(f"  [cyan]{tool_name}[/cyan]: {tool_info['description']}")
    
    if uncategorized:
        output += "[bold]Other:[/bold]\n"
        output += "\n".join(uncategorized) + "\n\n"
    
    output += f"[dim]Total tools available: {len(registry)}[/dim]"
    
    return output
