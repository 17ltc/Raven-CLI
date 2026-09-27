from __future__ import annotations

import shlex
from typing import Optional, Tuple
from rich.console import Console

from .command_registry import CommandRegistry


class CommandHandler:
    def __init__(self, registry: CommandRegistry, console: Console = None):
        self.registry = registry
        self.console = console or Console()

    def parse_input(self, user_input: str) -> Tuple[Optional[str], Optional[str]]:
        """Parse user input to extract command and arguments.
        Returns (command_name, arguments) or (None, None) if not a command."""
        user_input = user_input.strip()
        
        if not user_input.startswith('/'):
            return None, None
        
        # Remove the leading /
        command_part = user_input[1:].strip()
        
        if not command_part:
            return None, None
        
        # Split command and arguments
        try:
            parts = shlex.split(command_part)
            command_name = parts[0] if parts else None
            args = ' '.join(parts[1:]) if len(parts) > 1 else None
            return command_name, args
        except ValueError:
            # Handle malformed quotes
            return None, None

    def execute(self, user_input: str) -> bool:
        """Execute a command from user input.
        Returns True if command was executed, False if not a command."""
        command_name, args = self.parse_input(user_input)
        
        if command_name is None:
            return False
        
        command = self.registry.get_command(command_name)
        
        if not command:
            self.console.print(f"[red]Unknown command: /{command_name}[/red]")
            self.console.print(f"[dim]Type /help for available commands.[/dim]")
            return True
        
        try:
            result = command.handler(args or "", self.console)
            if result:
                self.console.print(result)
        except Exception as e:
            self.console.print(f"[red]Error executing command /{command_name}:[/red] {e}")
        
        return True

    def get_completions(self, prefix: str) -> list[str]:
        """Get command completions for the current input."""
        if not prefix.startswith('/'):
            return []
        
        command_part = prefix[1:]
        completions = self.registry.get_completions(command_part)
        return [f"/{cmd}" for cmd in completions]
