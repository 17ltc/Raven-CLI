from __future__ import annotations

import secrets
import sys
from rich.console import Console


class HumanConfirmation:
    """Human-only approval gate; model arguments are never trusted as approval."""

    def __init__(self, console: Console | None = None):
        self.console = console or Console()

    def require(self, action: str) -> bool:
        challenge = "RAVEN-" + secrets.token_hex(3).upper()
        self.console.print(f"\nDiscord read request: {action}")
        self.console.print(f"Type exactly {challenge} to continue, or press Enter to deny.")
        try:
            answer = self.console.input("Confirmation: ").strip()
        except (EOFError, KeyboardInterrupt):
            return False
        return secrets.compare_digest(answer, challenge)
