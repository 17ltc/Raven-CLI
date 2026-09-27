"""
File tools available to the agent, sandboxed to a configured workspace
directory.

SECURITY: write_file is unrestricted (within the workspace). delete_file is
NOT — it always stops and asks the human operator for interactive
confirmation in the terminal before doing anything, regardless of what the
model says, how it phrases the request, or which model/backend is running.
This is enforced here in Python, not in the prompt, specifically because a
weak or free-tier model cannot be trusted to reliably honor a
prompt-only instruction. There is no argument or config flag that skips
this — that's intentional.
"""
from __future__ import annotations

from pathlib import Path
from datetime import datetime
import shutil

from rich.console import Console

console = Console()


class FileTools:
    MAX_WRITE_BYTES = 10 * 1024 * 1024  # 10 MB — generous for reports/notes/exports,
    # small enough that a model stuck in a bad loop can't quietly fill the disk.

    def __init__(self, workspace_root: Path, unrestricted: bool = False):
        self.workspace_root = workspace_root.resolve()
        self.unrestricted = unrestricted
        self.undo_root = self.workspace_root / ".raven_undo"
        if not self.unrestricted:
            self.workspace_root.mkdir(parents=True, exist_ok=True)

    def _resolve(self, path_str: str) -> Path:
        if self.unrestricted:
            # In unrestricted mode, allow absolute paths and paths outside workspace
            candidate = Path(path_str).resolve()
        else:
            # In restricted mode, only allow paths within workspace
            candidate = (self.workspace_root / path_str).resolve()
            if candidate != self.workspace_root and self.workspace_root not in candidate.parents:
                raise PermissionError(
                    f"Refused: '{path_str}' resolves outside the workspace ({self.workspace_root})."
                )
        return candidate

    def write_file(self, path: str, content: str, mode: str = "overwrite") -> dict:
        try:
            size = len(content.encode("utf-8", errors="ignore"))
            if size > self.MAX_WRITE_BYTES:
                return {
                    "error": (
                        f"Refused: content is {size} bytes, over the "
                        f"{self.MAX_WRITE_BYTES} byte limit for a single write_file "
                        "call. Split it into smaller writes (e.g. mode='append')."
                    )
                }
            p = self._resolve(path)
            p.parent.mkdir(parents=True, exist_ok=True)
            if p.exists() and p.is_file():
                backup = self.undo_root / f"{p.name}.{datetime.now().strftime('%Y%m%d%H%M%S%f')}.bak"
                backup.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(p, backup)
                (backup.with_suffix(backup.suffix + ".path")).write_text(
                    str(p.relative_to(self.workspace_root)), encoding="utf-8"
                )
            if mode == "append" and p.exists():
                existing_size = p.stat().st_size
                if existing_size + size > self.MAX_WRITE_BYTES:
                    return {
                        "error": (
                            f"Refused: appending would bring '{path}' to "
                            f"{existing_size + size} bytes, over the "
                            f"{self.MAX_WRITE_BYTES} byte limit."
                        )
                    }
                with open(p, "a", encoding="utf-8") as f:
                    f.write(content)
            else:
                p.write_text(content, encoding="utf-8")
            return {"status": "written", "path": str(p), "bytes": len(content)}
        except Exception as e:
            return {"error": str(e)}

    def undo_file(self, path: str) -> dict:
        try:
            target = self._resolve(path)
            backups = []
            for backup in self.undo_root.glob(f"{target.name}.*.bak"):
                marker = backup.with_suffix(backup.suffix + ".path")
                if marker.exists() and marker.read_text(encoding="utf-8") == str(target.relative_to(self.workspace_root)):
                    backups.append(backup)
            if not backups:
                return {"error": f"No undo version found for {path}"}
            backup = max(backups, key=lambda item: item.stat().st_mtime_ns)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(backup, target)
            return {"status": "restored", "path": str(target), "from": str(backup)}
        except Exception as e:
            return {"error": str(e)}

    def list_workspace(self) -> dict:
        files = [str(p.relative_to(self.workspace_root)) for p in self.workspace_root.rglob("*") if p.is_file()]
        return {"workspace": str(self.workspace_root), "files": files}

    def delete_file(self, path: str) -> dict:
        try:
            p = self._resolve(path)
        except Exception as e:
            return {"error": str(e)}

        if not p.exists():
            return {"error": f"File does not exist: {p}"}

        console.print(f"\n[bold red]SECURITY GATE[/bold red] — the agent is asking to DELETE this file:")
        console.print(f"  [bold]{p}[/bold]")
        answer = console.input("[bold yellow]Autoriser la suppression ? [y/N]: [/bold yellow]").strip().lower()
        if answer != "y":
            return {"status": "denied", "message": "L'utilisateur n'a pas autorisé cette suppression."}

        try:
            p.unlink()
        except Exception as e:
            return {"error": f"Deletion failed: {e}"}
        return {"status": "deleted", "path": str(p)}
