from __future__ import annotations

import subprocess
from pathlib import Path


IGNORED_DIRS = {".git", ".venv", "venv", "node_modules", "__pycache__", ".raven_sessions"}


class ProjectTools:
    def __init__(self, root: Path):
        self.root = root.resolve()

    def files(self, pattern: str = "*") -> list[str]:
        return sorted(
            str(path.relative_to(self.root))
            for path in self.root.rglob(pattern)
            if path.is_file() and not any(part in IGNORED_DIRS for part in path.parts)
        )

    def tree(self, max_depth: int = 3) -> list[str]:
        result = []
        for path in sorted(self.root.rglob("*")):
            relative = path.relative_to(self.root)
            if any(part in IGNORED_DIRS for part in relative.parts):
                continue
            if len(relative.parts) <= max_depth:
                result.append(str(relative) + ("/" if path.is_dir() else ""))
        return result

    def read(self, path: str, start_line: int = 1, max_lines: int = 240) -> dict:
        target = (self.root / path).resolve()
        if self.root not in target.parents:
            return {"error": "File is outside the project"}
        if not target.is_file():
            return {"error": f"File not found: {path}"}
        try:
            lines = target.read_text(encoding="utf-8").splitlines()
            start = max(start_line - 1, 0)
            selected = lines[start:start + max_lines]
            return {"path": str(target.relative_to(self.root)), "start_line": start + 1, "lines": selected}
        except UnicodeDecodeError:
            return {"error": f"Not a UTF-8 text file: {path}"}

    def inspect(self) -> dict:
        files = self.files()
        extensions = {}
        for name in files:
            suffix = Path(name).suffix.lower() or "[none]"
            extensions[suffix] = extensions.get(suffix, 0) + 1
        return {"root": str(self.root), "file_count": len(files), "extensions": extensions, "tree": self.tree(2)}

    def search(self, query: str) -> list[dict]:
        results = []
        for relative in self.files():
            path = self.root / relative
            try:
                for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                    if query.lower() in line.lower():
                        results.append({"file": relative, "line": number, "text": line.strip()})
            except (OSError, UnicodeDecodeError):
                continue
        return results[:200]

    def git(self, *args: str) -> dict:
        result = subprocess.run(
            ["git", *args], cwd=self.root, capture_output=True, text=True, timeout=30
        )
        return {
            "success": result.returncode == 0,
            "output": result.stdout.strip(),
            "error": result.stderr.strip(),
            "returncode": result.returncode,
        }

    def diff_file(self, path: str) -> dict:
        target = (self.root / path).resolve()
        if self.root not in target.parents and target != self.root:
            return {"success": False, "error": "File is outside the project"}
        result = subprocess.run(
            ["git", "diff", "--", str(target.relative_to(self.root))],
            cwd=self.root,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return {"success": result.returncode == 0, "output": result.stdout, "error": result.stderr}

    def summary(self) -> str:
        files = self.files()
        important = [
            path for path in files
            if Path(path).name.lower() in {"readme.md", "pyproject.toml", "package.json", "dockerfile"}
        ]
        return f"root={self.root}; files={len(files)}; entrypoints={', '.join(important[:8]) or 'none'}"

    def context_for_query(self, query: str, limit: int = 6000) -> str:
        terms = {word.lower() for word in query.replace("/", " ").split() if len(word) > 2}
        candidates = []
        for relative in self.files():
            path = self.root / relative
            score = sum(1 for term in terms if term in relative.lower())
            if score:
                candidates.append((score, relative))
        candidates.sort(key=lambda item: (-item[0], item[1]))
        chunks = []
        used = 0
        for _, relative in candidates[:8]:
            try:
                content = (self.root / relative).read_text(encoding="utf-8")[:1800]
            except (OSError, UnicodeDecodeError):
                continue
            chunk = f"\n--- {relative} ---\n{content}"
            if used + len(chunk) > limit:
                break
            chunks.append(chunk)
            used += len(chunk)
        return self.summary() + ("\nRelevant files:" + "".join(chunks) if chunks else "")
