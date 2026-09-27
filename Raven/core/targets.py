"""
Core Targets Module

Target management for investigations - reusable across all interfaces.
"""

import json
import yaml
from pathlib import Path
from typing import Dict, List, Optional
from datetime import datetime
from dataclasses import dataclass, asdict


@dataclass
class TargetIdentifier:
    """Represents an identifier for a target"""
    type: str  # email, phone, username, ip, domain, etc.
    value: str
    source: str = "manual"
    added_at: str = None
    
    def __post_init__(self):
        if self.added_at is None:
            self.added_at = datetime.now().isoformat()


@dataclass
class Target:
    """Represents an investigation target"""
    name: str
    identifiers: List[TargetIdentifier]
    created_at: str
    notes: List[str] = None
    research: List[Dict] = None
    links: List[str] = None
    
    def __post_init__(self):
        if self.notes is None:
            self.notes = []
        if self.research is None:
            self.research = []
        if self.links is None:
            self.links = []


class TargetManager:
    """Target manager with persistence"""
    
    def __init__(self, base_path: Optional[Path] = None):
        self.base_path = base_path or Path.cwd() / "targets"
        self.base_path.mkdir(parents=True, exist_ok=True)
        self._targets: Dict[str, Target] = {}
        self._load_all()
    
    def _get_target_path(self, name: str) -> Path:
        """Get target folder path"""
        return self.base_path / name
    
    def _get_target_info_path(self, name: str) -> Path:
        """Get target info file path"""
        return self._get_target_path(name) / "target_info.yaml"
    
    def create(self, name: str) -> Target:
        """Create a new target"""
        target_path = self._get_target_path(name)
        target_path.mkdir(parents=True, exist_ok=True)
        
        # Create subdirectories
        (target_path / "research").mkdir(exist_ok=True)
        (target_path / "evidence").mkdir(exist_ok=True)
        (target_path / "reports").mkdir(exist_ok=True)
        
        target = Target(
            name=name,
            identifiers=[],
            created_at=datetime.now().isoformat()
        )
        
        self._targets[name] = target
        self._save_target(target)
        return target
    
    def get(self, name: str) -> Optional[Target]:
        """Get a target by name"""
        return self._targets.get(name)
    
    def list(self) -> List[Target]:
        """List all targets"""
        return list(self._targets.values())
    
    def delete(self, name: str) -> bool:
        """Delete a target"""
        if name not in self._targets:
            return False
        
        target_path = self._get_target_path(name)
        # Delete folder
        import shutil
        shutil.rmtree(target_path, ignore_errors=True)
        
        del self._targets[name]
        return True
    
    def add_identifier(self, name: str, identifier_type: str, value: str, source: str = "manual") -> bool:
        """Add an identifier to a target"""
        target = self.get(name)
        if not target:
            return False
        
        identifier = TargetIdentifier(type=identifier_type, value=value, source=source)
        target.identifiers.append(identifier)
        self._save_target(target)
        return True
    
    def add_note(self, name: str, note: str) -> bool:
        """Add a note to a target"""
        target = self.get(name)
        if not target:
            return False
        
        target.notes.append(note)
        self._save_target(target)
        return True
    
    def add_research(self, name: str, research_data: Dict) -> bool:
        """Add research to a target"""
        target = self.get(name)
        if not target:
            return False
        
        research_data["timestamp"] = datetime.now().isoformat()
        target.research.append(research_data)
        self._save_target(target)
        return True
    
    def link(self, name1: str, name2: str, relation: str = "related") -> bool:
        """Link two targets"""
        target1 = self.get(name1)
        target2 = self.get(name2)
        
        if not target1 or not target2:
            return False
        
        if name2 not in target1.links:
            target1.links.append(name2)
        if name1 not in target2.links:
            target2.links.append(name1)
        
        self._save_target(target1)
        self._save_target(target2)
        return True
    
    def find_by_identifier(self, identifier_type: str, value: str) -> Optional[Target]:
        """Find target by identifier"""
        for target in self._targets.values():
            for identifier in target.identifiers:
                if identifier.type == identifier_type and identifier.value == value:
                    return target
        return None
    
    def _save_target(self, target: Target):
        """Save target to file"""
        info_path = self._get_target_info_path(target.name)
        
        # Convert to dict for YAML
        target_dict = {
            "name": target.name,
            "created_at": target.created_at,
            "identifiers": [asdict(id) for id in target.identifiers],
            "notes": target.notes,
            "research": target.research,
            "links": target.links
        }
        
        with open(info_path, 'w') as f:
            yaml.dump(target_dict, f, default_flow_style=False)
    
    def _load_all(self):
        """Load all targets from disk"""
        for target_dir in self.base_path.iterdir():
            if target_dir.is_dir():
                info_path = target_dir / "target_info.yaml"
                if info_path.exists():
                    with open(info_path, 'r') as f:
                        data = yaml.safe_load(f)
                    
                    # Handle identifiers - support both dict and string formats
                    identifiers_list = []
                    for id_data in data.get("identifiers", []):
                        if isinstance(id_data, dict):
                            identifiers_list.append(TargetIdentifier(**id_data))
                        elif isinstance(id_data, str):
                            # Legacy format: just a string value
                            identifiers_list.append(TargetIdentifier(type="email", value=id_data))
                    
                    target = Target(
                        name=data["name"],
                        identifiers=identifiers_list,
                        created_at=data["created_at"],
                        notes=data.get("notes", []),
                        research=data.get("research", []),
                        links=data.get("links", [])
                    )
                    
                    self._targets[target.name] = target
