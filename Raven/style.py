from __future__ import annotations

from rich.console import Console
from rich.text import Text
from rich.live import Live
from rich.spinner import Spinner
import time
import threading

# Simplified 2-color palette - clean and modern
PRIMARY_COLOR = "#063B5C"      # Deep water blue
SECONDARY_COLOR = "#22D3C5"    # Clear aqua
ACCENT_COLOR = SECONDARY_COLOR

# Text colors derived from the 2-color scheme
TEXT_PRIMARY = SECONDARY_COLOR
TEXT_SECONDARY = SECONDARY_COLOR
TEXT_DIM = PRIMARY_COLOR

# Border and separator colors
BORDER_COLOR = PRIMARY_COLOR
HIGHLIGHT_COLOR = SECONDARY_COLOR


def _hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _lerp_color(start_hex: str, end_hex: str, t: float) -> str:
    s, e = _hex_to_rgb(start_hex), _hex_to_rgb(end_hex)
    r = tuple(round(s[i] + (e[i] - s[i]) * t) for i in range(3))
    return f"#{r[0]:02x}{r[1]:02x}{r[2]:02x}"


def gradient_text(content: str, start_hex: str, end_hex: str) -> Text:
    """Color each line of `content` along a gradient from start_hex to end_hex,
    top to bottom."""
    lines = content.split("\n")
    n = max(len(lines) - 1, 1)
    out = Text()
    for i, line in enumerate(lines):
        color = _lerp_color(start_hex, end_hex, i / n)
        out.append(line, style=color)
        if i < len(lines) - 1:
            out.append("\n")
    return out


def print_gradient(console: Console, content: str, start_hex: str, end_hex: str) -> None:
    console.print(gradient_text(content, start_hex, end_hex))


def print_thinking(console: Console, content: str, thinking_time: float = 0.0) -> None:
    """Render the model's reasoning with animated thinking indicator and timing."""
    import textwrap
    
    # Show thinking time if provided
    if thinking_time > 0:
        time_str = f"{thinking_time:.1f}s"
        console.print(f"[{PRIMARY_COLOR}]thinking {time_str}[/{PRIMARY_COLOR}]")
    
    width = max((console.width or 100) - 3, 20)
    source_lines = content.strip("\n").split("\n")
    
    for i, line in enumerate(source_lines):
        wrapped = textwrap.wrap(line, width=width) or [""]
        for sub in wrapped:
            # Use primary color for the thinking indicator
            console.print(f"[{PRIMARY_COLOR}]│[/{PRIMARY_COLOR}] [{TEXT_SECONDARY}]{sub}[/{TEXT_SECONDARY}]")


def print_thinking_animation(console: Console, message: str = "Thinking") -> Live:
    """Show animated thinking indicator while processing."""
    spinner = Spinner("dots", text=f"[{PRIMARY_COLOR}]{message}[/{PRIMARY_COLOR}]")
    live = Live(spinner, console=console, refresh_per_second=10)
    return live


def print_tool_call(console: Console, tool_name: str, arguments: dict) -> None:
    """Render tool call with subtle animation effect."""
    import json
    
    # Animated tool call indicator
    console.print(f"[{PRIMARY_COLOR}]tool[/{PRIMARY_COLOR}] [{TEXT_PRIMARY}]{tool_name}[/{TEXT_PRIMARY}]")
    
    # Format arguments nicely
    if arguments:
        args_str = json.dumps(arguments, indent=2, default=str)
        # Show only first few lines to keep it clean
        args_lines = args_str.split('\n')[:3]
        for line in args_lines:
            console.print(f"  [{TEXT_DIM}]{line}[/{TEXT_DIM}]")
        if len(args_str.split('\n')) > 3:
            console.print(f"  [{TEXT_DIM}]...[/{TEXT_DIM}]")


def print_tool_result(console: Console, result: dict) -> None:
    """Render tool result with success/failure indication."""
    if "error" in result:
        console.print(f"[{PRIMARY_COLOR}]error[/{PRIMARY_COLOR}] {result['error']}")
    elif "success" in result and result["success"]:
        console.print(f"[{PRIMARY_COLOR}]done[/{PRIMARY_COLOR}]")
    else:
        console.print(f"[{PRIMARY_COLOR}]result[/{PRIMARY_COLOR}]")


def print_user_message(console: Console, message: str) -> None:
    """Render user message with clean styling."""
    console.print(f"[{TEXT_PRIMARY}]You:[/{TEXT_PRIMARY}] [{TEXT_SECONDARY}]{message}[/{TEXT_SECONDARY}]")


def print_ai_message(console: Console, message: str) -> None:
    """Render AI message with clean styling."""
    console.print(f"[{PRIMARY_COLOR}]Raven:[/{PRIMARY_COLOR}]")
    console.print(f"[{TEXT_SECONDARY}]{message}[/{TEXT_SECONDARY}]")


def print_separator(console: Console) -> None:
    """Print a subtle separator line."""
    console.print(f"[{BORDER_COLOR}]{'─' * (console.width or 80)}[/{BORDER_COLOR}]")


def print_typing_indicator(console: Console) -> None:
    """Show typing indicator for async responses."""
    console.print(f"[{PRIMARY_COLOR}]▌[/{PRIMARY_COLOR}]", end="")


class ThinkingTimer:
    """Context manager to measure and display thinking time."""
    
    def __init__(self, console: Console):
        self.console = console
        self.start_time = None
        self.end_time = None
    
    def __enter__(self):
        self.start_time = time.time()
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        self.end_time = time.time()
        elapsed = self.end_time - self.start_time
        if elapsed > 0.1:  # Only show if it took noticeable time
            self.console.print(f"[{TEXT_DIM}]thinking {elapsed:.1f}s[/{TEXT_DIM}]")
        return False


def animate_text_fade(console: Console, text: str, color: str) -> None:
    """Animate text appearing with a fade effect."""
    from rich.syntax import Syntax
    
    # Simple fade-in effect by printing character by character
    for i, char in enumerate(text):
        console.print(char, end="", style=color)
        if i % 3 == 0:  # Small delay every few characters
            time.sleep(0.01)
    console.print()  # New line at end


def display_user_message(console: Console, message: str) -> None:
    """Display user message with clean styling."""
    console.print(f"[{TEXT_PRIMARY}]You:[/{TEXT_PRIMARY}] [{TEXT_SECONDARY}]{message}[/{TEXT_SECONDARY}]")


def display_ai_message(console: Console, message: str) -> None:
    """Display AI message with clean styling."""
    console.print(f"[{PRIMARY_COLOR}]Raven:[/{PRIMARY_COLOR}]")
    console.print(f"[{TEXT_SECONDARY}]{message}[/{TEXT_SECONDARY}]")
