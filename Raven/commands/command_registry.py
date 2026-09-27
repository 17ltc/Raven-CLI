from __future__ import annotations

from typing import Callable, Dict, List, Optional
from dataclasses import dataclass
from rich.console import Console


@dataclass
class Command:
    name: str
    description: str
    handler: Callable
    args_help: str = ""
    examples: List[str] = None

    def __post_init__(self):
        if self.examples is None:
            self.examples = []


class CommandRegistry:
    def __init__(self, console: Console = None):
        self.console = console or Console()
        self._commands: Dict[str, Command] = {}
        self._aliases: Dict[str, str] = {}

    def register(self, command: Command = None, aliases: List[str] = None, **kwargs):
        """Register a command with optional aliases.
        
        Can accept either a Command object or keyword arguments to create one:
        - register(command=Command(...))
        - register(name="cmd", description="desc", handler=func, ...)
        """
        if command is None:
            # Create Command from kwargs
            command = Command(**kwargs)
        
        self._commands[command.name] = command
        if aliases:
            for alias in aliases:
                self._aliases[alias] = command.name

    def get_command(self, name: str) -> Optional[Command]:
        """Get a command by name or alias."""
        if name in self._commands:
            return self._commands[name]
        if name in self._aliases:
            return self._commands[self._aliases[name]]
        return None

    def list_commands(self) -> List[Command]:
        """List all registered commands."""
        return list(self._commands.values())

    def get_completions(self, prefix: str) -> List[str]:
        """Get command completions for a given prefix."""
        completions = []
        for cmd_name in self._commands.keys():
            if cmd_name.startswith(prefix):
                completions.append(cmd_name)
        for alias in self._aliases.keys():
            if alias.startswith(prefix):
                completions.append(alias)
        return sorted(completions)

    def get_help_text(self, command_name: str = None) -> str:
        """Get help text for a specific command or all commands."""
        if command_name:
            cmd = self.get_command(command_name)
            if not cmd:
                return f"Unknown command: {command_name}"
            
            help_text = f"[bold cyan]/{cmd.name}[/bold cyan] - {cmd.description}\n"
            if cmd.args_help:
                help_text += f"[dim]Usage: /{cmd.name} {cmd.args_help}[/dim]\n"
            if cmd.examples:
                help_text += "\n[bold]Examples:[/bold]\n"
                for example in cmd.examples:
                    help_text += f"  {example}\n"
            return help_text
        else:
            help_text = "[bold cyan]Available commands:[/bold cyan]\n"
            for cmd in self.list_commands():
                help_text += f"  [cyan]/{cmd.name}[/cyan] - {cmd.description}\n"
            help_text += "\n[dim]Use /help <command> for detailed help on a specific command.[/dim]"
            return help_text
