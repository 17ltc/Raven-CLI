"""
Core Sessions Module

Session management with persistence - reusable across all interfaces.
"""

import json
from pathlib import Path
from typing import List, Optional, Dict
from datetime import datetime
from dataclasses import dataclass, asdict


@dataclass
class SessionEntry:
    """Represents a single entry in a session"""
    role: str
    content: str
    timestamp: str
    tool_calls: Optional[List[Dict]] = None


@dataclass
class Session:
    """Represents a conversation session"""
    id: str
    name: str
    created_at: str
    entries: List[SessionEntry]
    metadata: Dict = None
    
    def __post_init__(self):
        if self.metadata is None:
            self.metadata = {}


class SessionManager:
    """Session manager with persistence"""
    
    def __init__(self, base_path: Optional[Path] = None):
        self.base_path = base_path or Path.home() / ".raven" / "sessions"
        self.base_path.mkdir(parents=True, exist_ok=True)
        self._current_session: Optional[Session] = None
    
    def create(self, name: str) -> Session:
        """Create a new session"""
        session_id = datetime.now().strftime("%Y%m%d_%H%M%S")
        session = Session(
            id=session_id,
            name=name,
            created_at=datetime.now().isoformat(),
            entries=[]
        )
        self._save_session(session)
        self._current_session = session
        return session
    
    def load(self, session_id: str) -> Optional[Session]:
        """Load a session by ID"""
        session_file = self.base_path / f"{session_id}.json"
        if not session_file.exists():
            return None
        
        with open(session_file, 'r') as f:
            data = json.load(f)
        
        session = Session(
            id=data["id"],
            name=data["name"],
            created_at=data["created_at"],
            entries=[SessionEntry(**entry) for entry in data["entries"]],
            metadata=data.get("metadata", {})
        )
        self._current_session = session
        return session
    
    def save(self):
        """Save current session"""
        if self._current_session:
            self._save_session(self._current_session)
    
    def _save_session(self, session: Session):
        """Save session to file"""
        session_file = self.base_path / f"{session.id}.json"
        with open(session_file, 'w') as f:
            json.dump(asdict(session), f, indent=2, default=str)
    
    def add_entry(self, role: str, content: str, tool_calls: Optional[List[Dict]] = None):
        """Add an entry to current session"""
        if not self._current_session:
            self.create("default")
        
        entry = SessionEntry(
            role=role,
            content=content,
            timestamp=datetime.now().isoformat(),
            tool_calls=tool_calls
        )
        self._current_session.entries.append(entry)
        self.save()
    
    def list(self) -> List[Session]:
        """List all sessions"""
        sessions = []
        for session_file in self.base_path.glob("*.json"):
            with open(session_file, 'r') as f:
                data = json.load(f)
            sessions.append(Session(
                id=data["id"],
                name=data["name"],
                created_at=data["created_at"],
                entries=[],
                metadata=data.get("metadata", {})
            ))
        return sorted(sessions, key=lambda s: s.created_at, reverse=True)
    
    def delete(self, session_id: str) -> bool:
        """Delete a session"""
        session_file = self.base_path / f"{session_id}.json"
        if session_file.exists():
            session_file.unlink()
            if self._current_session and self._current_session.id == session_id:
                self._current_session = None
            return True
        return False
    
    def get_current(self) -> Optional[Session]:
        """Get current session"""
        return self._current_session
    
    def export(self, session_id: str, format: str = "json") -> str:
        """Export session to string"""
        session = self.load(session_id)
        if not session:
            raise FileNotFoundError(f"Session {session_id} not found")
        
        if format == "json":
            return json.dumps(asdict(session), indent=2, default=str)
        elif format == "md":
            return self._to_markdown(session)
        else:
            raise ValueError(f"Unsupported format: {format}")
    
    def _to_markdown(self, session: Session) -> str:
        """Convert session to markdown"""
        md = f"# Session: {session.name}\n\n"
        md += f"Created: {session.created_at}\n\n"
        
        for entry in session.entries:
            md += f"## {entry.role.upper()} - {entry.timestamp}\n\n"
            md += f"{entry.content}\n\n"
        
        return md
