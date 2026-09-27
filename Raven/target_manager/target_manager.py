from __future__ import annotations

import json
import yaml
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, asdict
from rich.console import Console


@dataclass
class TargetInfo:
    name: str
    created_at: str
    last_updated: str
    identifiers: Dict[str, List[str]]  # email, phone, username, etc.
    notes: str = ""
    related_targets: List[str] = None
    metadata: Dict[str, Any] = None

    def __post_init__(self):
        if self.related_targets is None:
            self.related_targets = []
        if self.metadata is None:
            self.metadata = {}


class TargetManager:
    def __init__(self, base_path: Path = None, console: Console = None):
        self.base_path = base_path or Path.cwd() / "targets"
        self.console = console or Console()
        self.base_path.mkdir(parents=True, exist_ok=True)

    def _get_target_path(self, target_name: str) -> Path:
        """Get the path to a target's folder."""
        return self.base_path / target_name.lower().replace(" ", "_")

    def create_target(self, name: str, initial_identifiers: Dict[str, List[str]] = None) -> TargetInfo:
        """Create a new target with the given name and optional identifiers."""
        target_path = self._get_target_path(name)
        
        if target_path.exists():
            raise FileExistsError(f"Target '{name}' already exists at {target_path}")
        
        target_path.mkdir(parents=True, exist_ok=True)
        
        # Create subdirectories
        (target_path / "research").mkdir(exist_ok=True)
        (target_path / "evidence").mkdir(exist_ok=True)
        (target_path / "reports").mkdir(exist_ok=True)
        
        # Create target info
        now = datetime.now().isoformat()
        target_info = TargetInfo(
            name=name,
            created_at=now,
            last_updated=now,
            identifiers=initial_identifiers or {},
            notes="",
            related_targets=[],
            metadata={}
        )
        
        self._save_target_info(target_path, target_info)
        
        self.console.print(f"[green]+[/green] Target '{name}' created at {target_path}")
        return target_info

    def get_target(self, name: str) -> Optional[TargetInfo]:
        """Get target information by name."""
        target_path = self._get_target_path(name)
        if not target_path.exists():
            return None
        
        return self._load_target_info(target_path)

    def add_identifier(self, target_name: str, identifier_type: str, value: str) -> TargetInfo:
        """Add an identifier (email, phone, etc.) to a target."""
        target_info = self.get_target(target_name)
        if not target_info:
            raise FileNotFoundError(f"Target '{target_name}' not found")
        
        if identifier_type not in target_info.identifiers:
            target_info.identifiers[identifier_type] = []
        
        if value not in target_info.identifiers[identifier_type]:
            target_info.identifiers[identifier_type].append(value)
            target_info.last_updated = datetime.now().isoformat()
            
            target_path = self._get_target_path(target_name)
            self._save_target_info(target_path, target_info)
            
            self.console.print(f"[green]+[/green] Added {identifier_type}: {value} to target '{target_name}'")
        
        return target_info

    def add_note(self, target_name: str, note: str) -> TargetInfo:
        """Add a note to a target."""
        target_info = self.get_target(target_name)
        if not target_info:
            raise FileNotFoundError(f"Target '{target_name}' not found")
        
        target_info.notes += f"\n[{datetime.now().strftime('%Y-%m-%d %H:%M')}] {note}"
        target_info.last_updated = datetime.now().isoformat()
        
        target_path = self._get_target_path(target_name)
        self._save_target_info(target_path, target_info)
        
        self.console.print(f"[green]+[/green] Note added to target '{target_name}'")
        return target_info

    def save_research(self, target_name: str, research_type: str, content: str, filename: str = None) -> Path:
        """Save research content to a target's research folder."""
        target_info = self.get_target(target_name)
        if not target_info:
            raise FileNotFoundError(f"Target '{target_name}' not found")
        
        target_path = self._get_target_path(target_name)
        research_path = target_path / "research"
        
        if not filename:
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            filename = f"{research_type}_{timestamp}.md"
        
        file_path = research_path / filename
        file_path.write_text(content, encoding='utf-8')
        
        target_info.last_updated = datetime.now().isoformat()
        self._save_target_info(target_path, target_info)
        
        self.console.print(f"[green]done[/green] Research saved to {file_path}")
        return file_path

    def auto_associate_identifier(self, identifier: str, identifier_type: str = "email") -> Optional[str]:
        """Automatically find or create a target based on an identifier."""
        # First try to find existing target
        existing_target = self.find_target_by_identifier(identifier_type, identifier)
        if existing_target:
            return existing_target.name
        
        # Extract potential name from email
        if identifier_type == "email" and "@" in identifier:
            potential_name = identifier.split("@")[0].replace(".", " ").title()
            try:
                new_target = self.create_target(potential_name, {identifier_type: [identifier]})
                return new_target.name
            except FileExistsError:
                # Target name exists, try appending number
                for i in range(2, 10):
                    try:
                        new_target = self.create_target(f"{potential_name}_{i}", {identifier_type: [identifier]})
                        return new_target.name
                    except FileExistsError:
                        continue
        
        return None

    def link_targets(self, target_name1: str, target_name2: str, relation: str = "related"):
        """Create a relationship between two targets."""
        target1 = self.get_target(target_name1)
        target2 = self.get_target(target_name2)
        
        if not target1 or not target2:
            missing = [name for name, target in [(target_name1, target1), (target_name2, target2)] if not target]
            raise FileNotFoundError(f"Targets not found: {', '.join(missing)}")
        
        if target_name2 not in target1.related_targets:
            target1.related_targets.append(target_name2)
            target1.last_updated = datetime.now().isoformat()
            self._save_target_info(self._get_target_path(target_name1), target1)
        
        if target_name1 not in target2.related_targets:
            target2.related_targets.append(target_name1)
            target2.last_updated = datetime.now().isoformat()
            self._save_target_info(self._get_target_path(target_name2), target2)
        
        self.console.print(f"[green]+[/green] Linked '{target_name1}' and '{target_name2}' as {relation}")

    def find_target_by_identifier(self, identifier_type: str, value: str) -> Optional[TargetInfo]:
        """Find a target by identifier (email, phone, etc.)."""
        for target_path in self.base_path.iterdir():
            if target_path.is_dir():
                target_info = self._load_target_info(target_path)
                if target_info:
                    if identifier_type in target_info.identifiers:
                        if value in target_info.identifiers[identifier_type]:
                            return target_info
        return None

    def list_targets(self) -> List[TargetInfo]:
        """List all targets."""
        targets = []
        for target_path in self.base_path.iterdir():
            if target_path.is_dir():
                target_info = self._load_target_info(target_path)
                if target_info:
                    targets.append(target_info)
        return targets

    def get_target_summary(self, target_name: str) -> str:
        """Get a formatted summary of a target."""
        target_info = self.get_target(target_name)
        if not target_info:
            return f"[red]Target '{target_name}' not found[/red]"
        
        summary = f"[bold cyan]Target: {target_info.name}[/bold cyan]\n"
        summary += f"[dim]Created: {target_info.created_at}[/dim]\n"
        summary += f"[dim]Last updated: {target_info.last_updated}[/dim]\n\n"
        
        if target_info.identifiers:
            summary += "[bold]Identifiers:[/bold]\n"
            for id_type, values in target_info.identifiers.items():
                summary += f"  {id_type}: {', '.join(values)}\n"
            summary += "\n"
        
        if target_info.related_targets:
            summary += f"[bold]Related targets:[/bold] {', '.join(target_info.related_targets)}\n\n"
        
        if target_info.notes:
            summary += "[bold]Notes:[/bold]\n"
            summary += target_info.notes + "\n"
        
        return summary

    def _load_target_info(self, target_path: Path) -> Optional[TargetInfo]:
        """Load target info from the target directory."""
        info_file = target_path / "target_info.yaml"
        if not info_file.exists():
            return None
        
        try:
            with open(info_file, 'r', encoding='utf-8') as f:
                data = yaml.safe_load(f)
            return TargetInfo(**data)
        except Exception as e:
            self.console.print(f"[red]Error loading target info from {target_path}:[/red] {e}")
            return None

    def _save_target_info(self, target_path: Path, target_info: TargetInfo):
        """Save target info to the target directory."""
        info_file = target_path / "target_info.yaml"
        with open(info_file, 'w', encoding='utf-8') as f:
            yaml.dump(asdict(target_info), f, default_flow_style=False)
