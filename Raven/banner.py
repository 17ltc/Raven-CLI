from __future__ import annotations

from rich.console import Console
from rich.live import Live
import time

from .style import PRIMARY_COLOR, SECONDARY_COLOR, TEXT_SECONDARY, gradient_text

# Custom Raven mark — hand-provided, not generated. Kept verbatim.
LOGO = r"""
███████▄  ▄███████▄ ███   ███ ████████ ███▄▄  ███
███   ███ ███   ███ ███   ███ ███      ███▀██▄███
████████  █████████ ███▄ ▄███ ███▀▀▀   ███  ▀▀███
███   ███ ███   ███  ▀█████▀  ███▄▄▄▄▄ ███    ███
▀▀▀   ▀▀▀ ▀▀▀   ▀▀▀    ▀▀▀    ▀▀▀▀▀▀▀▀ ▀▀▀    ▀▀▀
"""

def render_logo() -> str:
    return LOGO.strip("\n")


def print_banner(console: Console, version: str, subtitle: str = "") -> None:
    # Give the logo a short aqua pulse when the session starts.
    console.clear()
    console.print("\n\n\n")
    with Live(console=console, refresh_per_second=12) as live:
        for phase in (0.0, 0.5, 1.0, 0.5):
            live.update(gradient_text(render_logo(), PRIMARY_COLOR, SECONDARY_COLOR if phase else PRIMARY_COLOR))
            time.sleep(0.07)
    console.print()
    console.print(f"[{SECONDARY_COLOR}]Raven CLI[/{SECONDARY_COLOR}]  [{PRIMARY_COLOR}]v{version}[/{PRIMARY_COLOR}]")
    console.print("\n\n\n")
