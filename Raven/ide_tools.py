"""Safe project and IDE helpers used by Raven.

The module deliberately keeps inspection separate from mutation. Mutating
operations require an explicit human challenge and stay inside the workspace.
"""
from __future__ import annotations

import ast
import difflib
import hashlib
import json
import os
import re
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

from .confirmation import HumanConfirmation


IGNORED = {".git", ".venv", "venv", "node_modules", "__pycache__", ".raven_undo", ".raven_sessions"}
MAX_FILE = 2 * 1024 * 1024


class IDETools:
    def __init__(self, root: Path):
        self.root = root.resolve()

    def _path(self, value: str) -> Path:
        path = (self.root / value).resolve()
        if path != self.root and self.root not in path.parents:
            raise PermissionError("Path is outside the workspace")
        return path

    def _files(self):
        for path in self.root.rglob("*"):
            if path.is_file() and not any(part in IGNORED for part in path.relative_to(self.root).parts):
                yield path

    def _confirm(self, action: str) -> bool:
        return HumanConfirmation().require(action)

    def project_symbols(self, query: str = "", kind: str = "all") -> dict:
        result = []
        for path in self._files():
            if path.suffix == ".py":
                try:
                    tree = ast.parse(path.read_text(encoding="utf-8"))
                except (OSError, UnicodeDecodeError, SyntaxError):
                    continue
                for node in ast.walk(tree):
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        node_kind = "class" if isinstance(node, ast.ClassDef) else "function"
                        if kind != "all" and kind != node_kind:
                            continue
                        if query and query.lower() not in node.name.lower():
                            continue
                        result.append({"name": node.name, "kind": node_kind, "file": str(path.relative_to(self.root)), "line": node.lineno})
            elif path.suffix in {".js", ".jsx", ".ts", ".tsx"}:
                try:
                    text = path.read_text(encoding="utf-8")
                except (OSError, UnicodeDecodeError):
                    continue
                pattern = r"(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)"
                for match in re.finditer(pattern, text):
                    if not query or query.lower() in match.group(1).lower():
                        result.append({"name": match.group(1), "kind": "symbol", "file": str(path.relative_to(self.root)), "line": text.count("\n", 0, match.start()) + 1})
        return {"root": str(self.root), "symbols": result[:500], "count": len(result)}

    def project_dependencies(self) -> dict:
        files = {}
        for name in ("package.json", "pyproject.toml", "requirements.txt", "poetry.lock", "package-lock.json"):
            path = self.root / name
            if path.exists():
                try:
                    files[name] = path.read_text(encoding="utf-8")[:MAX_FILE]
                except OSError:
                    pass
        return {"files": list(files), "manifests": files}

    def project_map(self, max_depth: int = 4, max_entries: int = 2000) -> dict:
        entries = []
        for path in sorted(self.root.rglob("*")):
            if len(entries) >= max_entries:
                break
            relative = path.relative_to(self.root)
            if any(part in IGNORED for part in relative.parts) or len(relative.parts) > max_depth:
                continue
            entries.append({"path": str(relative), "directory": path.is_dir()})
        return {"root": str(self.root), "entries": entries, "truncated": len(entries) >= max_entries}

    def file_history(self, path: str, limit: int = 20) -> dict:
        return self._git(["log", f"-{max(1, min(limit, 100))}", "--", path])

    def _git(self, args: list[str]) -> dict:
        try:
            result = subprocess.run(["git", *args], cwd=self.root, capture_output=True, text=True, timeout=30)
            return {"success": result.returncode == 0, "output": result.stdout[-20000:], "error": result.stderr[-5000:], "returncode": result.returncode}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    def safe_edit(self, path: str, old_content: str, new_content: str) -> dict:
        target = self._path(path)
        if not target.is_file():
            return {"success": False, "error": "File not found"}
        current = target.read_text(encoding="utf-8")
        if old_content not in current:
            return {"success": False, "error": "Old content not found"}
        updated = current.replace(old_content, new_content, 1)
        diff = "".join(difflib.unified_diff(current.splitlines(True), updated.splitlines(True), fromfile=path, tofile=path))
        if not self._confirm(f"edit {path}\n{diff[:4000]}"):
            return {"success": False, "status": "denied"}
        target.write_text(updated, encoding="utf-8")
        return {"success": True, "path": path, "diff": diff}

    def multi_file_edit(self, edits: list[dict]) -> dict:
        preview = []
        prepared = []
        for edit in edits[:50]:
            result = self.safe_edit_preview(edit)
            if "error" in result:
                return result
            prepared.append(result)
            preview.append(result["diff"][:1500])
        if not self._confirm("edit multiple files\n" + "\n".join(preview)[:8000]):
            return {"success": False, "status": "denied"}
        for item in prepared:
            item["path_obj"].write_text(item["updated"], encoding="utf-8")
        return {"success": True, "files": [item["path"] for item in prepared]}

    def safe_edit_preview(self, edit: dict) -> dict:
        path = str(edit.get("path", ""))
        target = self._path(path)
        if not target.is_file():
            return {"error": f"File not found: {path}"}
        current = target.read_text(encoding="utf-8")
        old = str(edit.get("old_content", ""))
        if old not in current:
            return {"error": f"Old content not found: {path}"}
        updated = current.replace(old, str(edit.get("new_content", "")), 1)
        return {"path": path, "path_obj": target, "updated": updated, "diff": "".join(difflib.unified_diff(current.splitlines(True), updated.splitlines(True), fromfile=path, tofile=path))}

    def git_review(self) -> dict:
        return self._git(["diff", "--stat"])

    def git_branch_summary(self) -> dict:
        return self._git(["branch", "-vv"])

    def git_conflict_helper(self) -> dict:
        result = self._git(["status", "--short"])
        result["conflicts"] = [line for line in result.get("output", "").splitlines() if line.startswith(("UU", "AA", "DD", "AU", "UA"))]
        return result

    def secret_scanner(self) -> dict:
        patterns = {"private_key": r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "token": r"(?i)(api[_-]?key|secret|token)\s*[:=]\s*['\"][^'\"]{12,}"}
        findings = []
        for path in self._files():
            try:
                text = path.read_text(encoding="utf-8")[:MAX_FILE]
            except (OSError, UnicodeDecodeError):
                continue
            for name, pattern in patterns.items():
                if re.search(pattern, text):
                    findings.append({"file": str(path.relative_to(self.root)), "type": name})
        return {"findings": findings, "count": len(findings)}

    def dependency_vulnerability_scan(self) -> dict:
        return {"status": "available", "note": "Use the project's configured package manager audit command through execute_command after human confirmation.", "manifests": self.project_dependencies()["files"]}

    def workspace_snapshot(self, label: str = "snapshot") -> dict:
        snapshot_dir = self.root / ".raven_snapshots"
        if not self._confirm(f"create workspace snapshot: {label}"):
            return {"success": False, "status": "denied"}
        snapshot_dir.mkdir(exist_ok=True)
        data = {"label": label, "created_at": datetime.now().isoformat(), "files": {str(p.relative_to(self.root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in self._files()}}
        target = snapshot_dir / f"{datetime.now().strftime('%Y%m%d%H%M%S')}-{re.sub(r'[^A-Za-z0-9_-]', '-', label)}.json"
        target.write_text(json.dumps(data, indent=2), encoding="utf-8")
        return {"success": True, "path": str(target), "file_count": len(data["files"])}

    def memory_search(self, query: str) -> dict:
        memory = self.root / ".raven_memory.jsonl"
        if not memory.exists():
            return {"matches": []}
        matches = []
        for line in memory.read_text(encoding="utf-8").splitlines():
            if query.lower() in line.lower():
                try: matches.append(json.loads(line))
                except json.JSONDecodeError: matches.append({"text": line})
        return {"matches": matches[-100:]}

    def memory_save(self, text: str, category: str = "note") -> dict:
        if not self._confirm("save project memory"):
            return {"success": False, "status": "denied"}
        target = self.root / ".raven_memory.jsonl"
        with target.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"created_at": datetime.now().isoformat(), "category": category, "text": text}, ensure_ascii=False) + "\n")
        return {"success": True, "path": str(target)}

    def context_budget(self, text: str = "") -> dict:
        return {"characters": len(text), "estimated_tokens": max(1, len(text) // 4), "recommended_limit": 12000}

    def system_status(self) -> dict:
        return {"cwd": str(self.root), "python": os.sys.executable, "platform": os.name, "git": self._git(["status", "--short"])}


def register_ide_tools(registry: dict, root: Path) -> None:
    tools = IDETools(root)
    entries = {
        "project_symbols": (tools.project_symbols, "Find classes and functions in the project."),
        "project_dependencies": (tools.project_dependencies, "Inspect dependency manifests."),
        "project_map": (tools.project_map, "Build a bounded project map."),
        "file_history": (tools.file_history, "Show Git history for a file."),
        "safe_edit": (tools.safe_edit, "Edit one file with diff preview and human confirmation."),
        "multi_file_edit": (tools.multi_file_edit, "Edit multiple files with one human confirmation."),
        "git_review": (tools.git_review, "Review the current Git diff summary."),
        "git_branch_summary": (tools.git_branch_summary, "List local Git branches and tracking state."),
        "git_conflict_helper": (tools.git_conflict_helper, "Find unresolved Git conflicts."),
        "secret_scanner": (tools.secret_scanner, "Scan project text for likely secrets without revealing values."),
        "dependency_vulnerability_scan": (tools.dependency_vulnerability_scan, "Inspect manifests and explain how to run an audit."),
        "workspace_snapshot": (tools.workspace_snapshot, "Create a hash snapshot of workspace files with confirmation."),
        "memory_search": (tools.memory_search, "Search project memory."),
        "memory_save": (tools.memory_save, "Save a project decision or note with confirmation."),
        "context_budget": (tools.context_budget, "Estimate context size."),
        "system_status": (tools.system_status, "Show Raven workspace and Git status."),
    }
    for name, (fn, description) in entries.items():
        registry[name] = {"fn": fn, "description": description}
