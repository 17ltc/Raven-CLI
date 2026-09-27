from __future__ import annotations

import time
import threading
from typing import Optional, Callable
from rich.console import Console
from rich.live import Live
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TimeRemainingColumn
from rich.panel import Panel
from rich.text import Text
from rich.table import Table


class RavenUI:
    def __init__(self, console: Console = None):
        self.console = console or Console()
        self._spinner = None
        self._progress = None
        self._live_display = None

    def show_thinking_animation(self, message: str = "Thinking..."):
        """Show an animated thinking indicator."""
        with self.console.status(f"[bold cyan]{message}[/bold cyan]") as status:
            while True:
                time.sleep(0.1)
                break

    def show_progress(self, task_name: str, total: int = 100):
        """Show a progress bar for long operations."""
        self._progress = Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
            TimeRemainingColumn(),
            console=self.console
        )
        
        task = self._progress.add_task(f"[cyan]{task_name}[/cyan]", total=total)
        return self._progress, task

    def show_typing_animation(self, text: str, speed: float = 0.02):
        """Show text appearing character by character."""
        for char in text:
            self.console.print(char, end="")
            time.sleep(speed)
        self.console.print()

    def show_panel(self, content: str, title: str = "", style: str = "cyan"):
        """Show content in a styled panel."""
        panel = Panel(
            content,
            title=f"[bold {style}]{title}[/bold {style}]" if title else "",
            border_style=style
        )
        self.console.print(panel)

    def show_table(self, data: list, headers: list, title: str = ""):
        """Show data in a formatted table."""
        table = Table(title=title)
        for header in headers:
            table.add_column(header)
        
        for row in data:
            table.add_row(*[str(cell) for cell in row])
        
        self.console.print(table)

    def show_success(self, message: str):
        """Show a success message."""
        self.console.print(f"[green]+[/green] {message}")

    def show_error(self, message: str):
        """Show an error message."""
        self.console.print(f"[red]X[/red] {message}")

    def show_warning(self, message: str):
        """Show a warning message."""
        self.console.print(f"[yellow]![/yellow] {message}")

    def show_info(self, message: str):
        """Show an info message."""
        self.console.print(f"[blue]i[/blue] {message}")

    def clear_line(self):
        """Clear the current line."""
        self.console.print("\r" + " " * 100 + "\r", end="")

    def show_loading(self, message: str, dots: int = 3):
        """Show a loading animation with dots."""
        for i in range(dots):
            self.console.print(f"\r[cyan]{message}{'.' * (i + 1)}[/cyan]", end="")
            time.sleep(0.2)
        self.console.print("\r" + " " * 50 + "\r", end="")


class ThinkingIndicator:
    def __init__(self, console: Console = None):
        self.console = console or Console()
        self._running = False
        self._thread = None

    def start(self, message: str = "Thinking"):
        """Start the thinking animation."""
        self._running = True
        self._thread = threading.Thread(target=self._animate, args=(message,))
        self._thread.daemon = True
        self._thread.start()

    def stop(self):
        """Stop the thinking animation."""
        self._running = False
        if self._thread:
            self._thread.join()

    def _animate(self, message: str):
        """Animation loop."""
        frames = ["|", "/", "-", "\\"]
        i = 0
        while self._running:
            self.console.print(f"\r[cyan]{frames[i % len(frames)]} {message}[/cyan]", end="")
            time.sleep(0.1)
            i += 1
        self.console.print("\r" + " " * 50 + "\r", end="")


class ResponseCounter:
    def __init__(self, console: Console = None):
        self.console = console or Console()
        self._count = 0
        self._start_time = None

    def start(self):
        """Start the response counter."""
        self._count = 0
        self._start_time = time.time()

    def increment(self):
        """Increment the character count."""
        self._count += 1

    def stop(self):
        """Stop the counter and show stats."""
        if self._start_time:
            elapsed = time.time() - self._start_time
            chars_per_sec = self._count / elapsed if elapsed > 0 else 0
            self.console.print(f"[dim]Generated {self._count} chars in {elapsed:.2f}s ({chars_per_sec:.0f} chars/s)[/dim]")


class EnhancedDisplay:
    def __init__(self, console: Console = None):
        self.console = console or Console()
        self.ui = RavenUI(console)
        self.thinking = ThinkingIndicator(console)
        self.counter = ResponseCounter(console)

    def show_welcome(self):
        """Show a beautiful welcome message."""
        welcome_text = """
[bold cyan]Welcome to Raven v1.0.0-alpha[/bold cyan]

[dim]Advanced OSINT Platform with AI-powered investigation[/dim]

[dim]Type --help to see available commands or start chatting directly.[/dim]
"""
        self.console.print(welcome_text)

    def show_startup_progress(self, steps: list):
        """Show startup progress with animation."""
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            console=self.console
        ) as progress:
            for step in steps:
                task = progress.add_task(f"[cyan]{step}[/cyan]", total=100)
                for i in range(100):
                    progress.update(task, advance=1)
                    time.sleep(0.01)

    def format_thinking_block(self, thinking: str) -> str:
        """Format thinking block with enhanced styling."""
        lines = thinking.split('\n')
        formatted = "[dim][bold]Thinking Process:[/bold][/dim]\n"
        for line in lines:
            formatted += f"[dim]  {line}[/dim]\n"
        return formatted

    def format_tool_call(self, tool_name: str, args: dict) -> str:
        """Format tool call with enhanced styling."""
        args_str = ", ".join(f"{k}={v}" for k, v in args.items())
        return f"[dim][bold]{tool_name}[/bold]({args_str})[/dim]"

    def format_response(self, response: str) -> str:
        """Format final response with enhanced styling."""
        return f"[bold green][bold]Response:[/bold green]\n{response}"
