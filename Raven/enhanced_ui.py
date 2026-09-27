"""
Enhanced UI Module for Raven CLI

Provides modern, animated UI elements with a clean 2-color scheme.
Features:
- Smooth animations for thinking, tool calls, and responses
- Real-time thinking time display
- Subtle color transitions
- Clean, minimal design
"""

import time
import threading
from rich.console import Console
from rich.live import Live
from rich.spinner import Spinner
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.text import Text
from rich.panel import Panel
from rich.align import Align

from .style import (
    PRIMARY_COLOR, TEXT_PRIMARY, TEXT_SECONDARY, TEXT_DIM,
    BORDER_COLOR, HIGHLIGHT_COLOR
)


class AnimatedThinking:
    """Animated thinking indicator with timing."""
    
    def __init__(self, console: Console, message: str = "Thinking"):
        self.console = console
        self.message = message
        self.start_time = time.time()
        self.live = None
        self.spinner = Spinner("dots", text=f"[{PRIMARY_COLOR}]{message}[/{PRIMARY_COLOR}]")
    
    def start(self):
        """Start the thinking animation."""
        self.live = Live(self.spinner, console=self.console, refresh_per_second=8)
        self.live.start()
    
    def stop(self):
        """Stop the thinking animation and show elapsed time."""
        if self.live:
            self.live.stop()
            elapsed = time.time() - self.start_time
            if elapsed > 0.1:
                self.console.print(f"[{TEXT_DIM}]thinking {elapsed:.1f}s[/{TEXT_DIM}]")
    
    def __enter__(self):
        self.start()
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        self.stop()
        return False


class AnimatedToolCall:
    """Animated tool call indicator."""
    
    def __init__(self, console: Console, tool_name: str, arguments: dict):
        self.console = console
        self.tool_name = tool_name
        self.arguments = arguments
    
    def display(self):
        """Display the tool call with animation."""
        # Tool call indicator without emojis
        self.console.print(f"[{PRIMARY_COLOR}][{TEXT_SECONDARY}]Calling:[/{TEXT_SECONDARY}] [{TEXT_PRIMARY}]{self.tool_name}[/{TEXT_PRIMARY}]")
        
        # Format arguments nicely
        if self.arguments:
            import json
            args_str = json.dumps(self.arguments, indent=2, default=str)
            # Show only first few lines to keep it clean
            args_lines = args_str.split('\n')[:3]
            for line in args_lines:
                self.console.print(f"  [{TEXT_DIM}]{line}[/{TEXT_DIM}]")
            if len(args_str.split('\n')) > 3:
                self.console.print(f"  [{TEXT_DIM}]...[/{TEXT_DIM}]")


class AnimatedResponse:
    """Animated response display with typewriter effect."""
    
    def __init__(self, console: Console, response: str):
        self.console = console
        self.response = response
    
    def display(self, animate: bool = True):
        """Display the response with optional animation."""
        if animate and len(self.response) < 500:  # Only animate shorter responses
            self._typewriter_effect()
        else:
            self.console.print(self.response, style=TEXT_SECONDARY)
    
    def _typewriter_effect(self):
        """Typewriter effect for short responses."""
        import textwrap
        lines = textwrap.wrap(self.response, width=self.console.width or 80)
        
        for line in lines:
            for char in line:
                self.console.print(char, end="", style=TEXT_SECONDARY)
                time.sleep(0.005)  # Very fast for responsiveness
            self.console.print()  # New line


class ProgressIndicator:
    """Progress indicator for long operations."""
    
    def __init__(self, console: Console, description: str = "Processing"):
        self.console = console
        self.description = description
        self.progress = None
    
    def start(self):
        """Start the progress indicator."""
        self.progress = Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=self.console
        )
        self.task = self.progress.add_task(self.description, total=None)
        self.progress.start()
    
    def update(self, description: str = None):
        """Update the progress description."""
        if description:
            self.progress.update(self.task, description=description)
    
    def stop(self):
        """Stop the progress indicator."""
        if self.progress:
            self.progress.stop()


class StatusMessage:
    """Animated status messages."""
    
    @staticmethod
    def success(console: Console, message: str):
        """Display success message."""
        console.print(f"[{PRIMARY_COLOR}][/{PRIMARY_COLOR}] [{TEXT_SECONDARY}]{message}[/{TEXT_SECONDARY}]")
    
    @staticmethod
    def error(console: Console, message: str):
        """Display error message."""
        console.print(f"[{PRIMARY_COLOR}][/{PRIMARY_COLOR}] [{TEXT_SECONDARY}]{message}[/{TEXT_SECONDARY}]")
    
    @staticmethod
    def info(console: Console, message: str):
        """Display info message."""
        console.print(f"[{PRIMARY_COLOR}][/{PRIMARY_COLOR}] [{TEXT_SECONDARY}]{message}[/{TEXT_SECONDARY}]")
    
    @staticmethod
    def warning(console: Console, message: str):
        """Display warning message."""
        console.print(f"[{PRIMARY_COLOR}][/{PRIMARY_COLOR}] [{TEXT_SECONDARY}]{message}[/{TEXT_SECONDARY}]")


class InputIndicator:
    """Always-visible input indicator."""
    
    def __init__(self, console: Console):
        self.console = console
    
    def show(self, prompt: str = "You:"):
        """Show the input indicator."""
        self.console.print(f"[{TEXT_DIM}]─────────────────────────────────────────[/{TEXT_DIM}]")
        self.console.print(f"[{PRIMARY_COLOR}]{prompt}[/{PRIMARY_COLOR}]", end="")
    
    def hide(self):
        """Hide the input indicator (for cleanup)."""
        pass


class ThinkingBlock:
    """Enhanced thinking block with animations."""
    
    def __init__(self, console: Console, content: str, thinking_time: float = 0.0):
        self.console = console
        self.content = content
        self.thinking_time = thinking_time
    
    def display(self):
        """Display the thinking block with styling."""
        import textwrap
        
        # Show thinking time if provided
        if self.thinking_time > 0:
            time_str = f"{self.thinking_time:.1f}s"
            self.console.print(f"Thinking time: {time_str}")
        
        # Create a panel for the thinking content
        width = max((self.console.width or 100) - 4, 20)
        wrapped_lines = []
        for line in self.content.strip().split('\n'):
            wrapped_lines.extend(textwrap.wrap(line, width=width) or [""])
        
        if wrapped_lines:
            panel_content = "\n".join(wrapped_lines)
            panel = Panel(
                panel_content,
                title="Thinking",
                border_style=BORDER_COLOR,
                padding=(0, 1)
            )
            self.console.print(panel)
