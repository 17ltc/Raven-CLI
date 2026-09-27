from __future__ import annotations

import subprocess
import sys
from typing import Dict, Optional
from rich.console import Console

try:
    from rich.prompt import Confirm
except ImportError:
    # Fallback if rich.prompt is not available
    class Confirm:
        @staticmethod
        def ask(question: str, default: bool = False) -> bool:
            console = Console()
            console.print(question)
            response = input(f"[y/N]: ").strip().lower()
            return response in ['y', 'yes']


class CommandExecutor:
    def __init__(self, console: Console = None):
        self.console = console or Console()

    def execute_command(self, command: str, timeout: int = 30) -> Dict:
        """Execute a shell command with user confirmation.
        
        Args:
            command: The shell command to execute
            timeout: Maximum execution time in seconds
            
        Returns:
            Dict with 'success', 'stdout', 'stderr', 'return_code' keys
        """
        # Ask for confirmation
        if not self._confirm_command(command):
            return {
                'success': False,
                'stdout': '',
                'stderr': 'Command cancelled by user',
                'return_code': -1
            }
        
        try:
            # Execute the command
            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout
            )
            
            return {
                'success': result.returncode == 0,
                'stdout': result.stdout,
                'stderr': result.stderr,
                'return_code': result.returncode
            }
            
        except subprocess.TimeoutExpired:
            return {
                'success': False,
                'stdout': '',
                'stderr': f'Command timed out after {timeout} seconds',
                'return_code': -1
            }
        except Exception as e:
            return {
                'success': False,
                'stdout': '',
                'stderr': str(e),
                'return_code': -1
            }

    def _confirm_command(self, command: str) -> bool:
        """Ask user for confirmation before executing command."""
        self.console.print("\n[bold yellow]⚠ COMMAND EXECUTION REQUEST[/bold yellow]\n")
        self.console.print(f"[cyan]Command:[/cyan] {command}")
        
        # Analyze potential risks
        risk_level = self._assess_risk(command)
        self.console.print(f"[cyan]Risk Level:[/cyan] {risk_level}")
        
        if risk_level in ["medium", "high"]:
            self.console.print("[red]⚠ WARNING: This command has potential risks![/red]")
        
        self.console.print()
        
        return Confirm.ask("[bold]Execute this command?[/bold]", default=False)

    def _assess_risk(self, command: str) -> str:
        """Assess the risk level of a command."""
        command_lower = command.lower()
        
        # High risk commands
        high_risk_patterns = [
            'rm -rf', 'del /f', 'format', 'diskpart',
            'dd if=', 'mkfs', 'shutdown', 'reboot',
            '> /dev/', 'chmod 777', 'chown root',
            'iptables -f', 'iptables --flush'
        ]
        
        for pattern in high_risk_patterns:
            if pattern in command_lower:
                return "high"
        
        # Medium risk commands
        medium_risk_patterns = [
            'rm ', 'del ', 'rmdir ', 'mv ', 'move ',
            'chmod ', 'chown ', 'useradd ', 'userdel ',
            'apt install', 'yum install', 'pip install',
            'npm install', 'reg delete', 'schtasks'
        ]
        
        for pattern in medium_risk_patterns:
            if pattern in command_lower:
                return "medium"
        
        # Low risk commands
        low_risk_patterns = [
            'ls ', 'dir ', 'cat ', 'type ', 'echo ',
            'pwd', 'cd ', 'grep ', 'find ', 'head ',
            'tail ', 'wc ', 'sort ', 'uniq ', 'ping ',
            'curl ', 'wget ', 'git status', 'git log',
            'git diff', 'ps ', 'top', 'df ', 'free ',
            'netstat', 'ifconfig', 'ipconfig', 'nslookup'
        ]
        
        for pattern in low_risk_patterns:
            if pattern in command_lower:
                return "low"
        
        # Unknown commands - treat as medium risk
        return "medium"

    def explain_command(self, command: str) -> str:
        """Provide a brief explanation of what a command does."""
        explanations = {
            'ls': 'List directory contents',
            'dir': 'List directory contents (Windows)',
            'cd': 'Change directory',
            'pwd': 'Print working directory',
            'cat': 'Display file contents',
            'type': 'Display file contents (Windows)',
            'grep': 'Search text patterns',
            'find': 'Search for files',
            'rm': 'Remove files or directories',
            'del': 'Delete files (Windows)',
            'cp': 'Copy files',
            'copy': 'Copy files (Windows)',
            'mv': 'Move/rename files',
            'move': 'Move/rename files (Windows)',
            'mkdir': 'Create directory',
            'chmod': 'Change file permissions',
            'chown': 'Change file owner',
            'ps': 'List running processes',
            'top': 'Display system processes',
            'kill': 'Terminate processes',
            'ping': 'Test network connectivity',
            'curl': 'Transfer data from URLs',
            'wget': 'Download files',
            'git': 'Version control system',
            'pip': 'Python package manager',
            'npm': 'Node.js package manager',
            'docker': 'Container management',
            'ssh': 'Secure shell connection',
            'tar': 'Archive files',
            'zip': 'Compress files',
        }
        
        # Try to match the first word of the command
        first_word = command.split()[0] if command.split() else ""
        return explanations.get(first_word, "Custom shell command")
