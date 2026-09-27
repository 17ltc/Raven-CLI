"""
Core Commands Module

Command system with registration and execution - reusable across all interfaces.
"""

from typing import Dict, Callable, Optional, List
from dataclasses import dataclass


@dataclass
class Command:
    """Represents a command"""
    name: str
    description: str
    handler: Callable
    args_help: str = ""
    examples: List[str] = None
    
    def __post_init__(self):
        if self.examples is None:
            self.examples = []


class CommandSystem:
    """Command system with registration"""
    
    def __init__(self):
        self.commands: Dict[str, Command] = {}
        self.aliases: Dict[str, str] = {}
    
    def register(self, name: str, description: str, handler: Callable, args_help: str = "", examples: List[str] = None, aliases: List[str] = None):
        """Register a command"""
        command = Command(
            name=name,
            description=description,
            handler=handler,
            args_help=args_help,
            examples=examples or []
        )
        
        self.commands[name] = command
        
        if aliases:
            for alias in aliases:
                self.aliases[alias] = name
    
    def unregister(self, name: str):
        """Unregister a command"""
        if name in self.commands:
            del self.commands[name]
        
        # Remove aliases
        self.aliases = {k: v for k, v in self.aliases.items() if v != name}
    
    def get(self, name: str) -> Optional[Command]:
        """Get a command by name or alias"""
        if name in self.commands:
            return self.commands[name]
        if name in self.aliases:
            return self.commands[self.aliases[name]]
        return None
    
    def execute(self, name: str, args: str = "", context: Dict = None) -> str:
        """Execute a command"""
        command = self.get(name)
        if not command:
            return f"Unknown command: {name}"
        
        try:
            return command.handler(args, context or {})
        except Exception as e:
            return f"Error executing command: {e}"
    
    def list(self) -> List[Command]:
        """List all commands"""
        return list(self.commands.values())
    
    def get_help(self, name: str = None) -> str:
        """Get help for a command or all commands"""
        if name:
            command = self.get(name)
            if not command:
                return f"Unknown command: {name}"
            
            help_text = f"Command: /{command.name}\n"
            help_text += f"Description: {command.description}\n"
            if command.args_help:
                help_text += f"Usage: /{command.name} {command.args_help}\n"
            if command.examples:
                help_text += "Examples:\n"
                for example in command.examples:
                    help_text += f"  {example}\n"
            return help_text
        else:
            help_text = "Available commands:\n"
            for command in self.list():
                help_text += f"  /{command.name} - {command.description}\n"
            help_text += "\nUse /help <command> for detailed help."
            return help_text
