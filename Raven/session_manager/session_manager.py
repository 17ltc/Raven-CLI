from __future__ import annotations

import json
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional
from dataclasses import dataclass, asdict
from rich.console import Console
from rich.table import Table


@dataclass
class SessionEntry:
    timestamp: str
    role: str  # 'user' or 'assistant'
    content: str
    tool_calls: List[Dict] = None

    def __post_init__(self):
        if self.tool_calls is None:
            self.tool_calls = []


@dataclass
class Session:
    session_id: str
    name: str
    created_at: str
    last_updated: str
    entries: List[SessionEntry]
    metadata: Dict = None

    def __post_init__(self):
        if self.metadata is None:
            self.metadata = {}


class SessionManager:
    def __init__(self, base_path: Path = None, console: Console = None):
        self.base_path = base_path or Path.cwd() / ".raven_sessions"
        self.console = console or Console()
        self.base_path.mkdir(parents=True, exist_ok=True)
        self._current_session: Optional[Session] = None

    def create_session(self, name: str = None) -> Session:
        """Create a new session."""
        session_id = datetime.now().strftime('%Y%m%d_%H%M%S')
        if not name:
            name = f"session_{session_id}"
        
        now = datetime.now().isoformat()
        session = Session(
            session_id=session_id,
            name=name,
            created_at=now,
            last_updated=now,
            entries=[],
            metadata={}
        )
        
        self._current_session = session
        self._save_session(session)
        
        self.console.print(f"[green]+[/green] Session '{name}' created (ID: {session_id})")
        return session

    def load_session(self, session_id: str) -> Optional[Session]:
        """Load a session by ID."""
        session_file = self.base_path / f"{session_id}.json"
        if not session_file.exists():
            self.console.print(f"[red]Session {session_id} not found[/red]")
            return None
        
        session = self._load_session_file(session_file)
        if session:
            self._current_session = session
            self.console.print(f"[green]+[/green] Loaded session '{session.name}' (ID: {session_id})")
        
        return session

    def get_current_session(self) -> Optional[Session]:
        """Get the current active session."""
        return self._current_session

    def add_entry(self, role: str, content: str, tool_calls: List[Dict] = None):
        """Add an entry to the current session."""
        if not self._current_session:
            # Auto-create session if none exists
            self.create_session()
        
        entry = SessionEntry(
            timestamp=datetime.now().isoformat(),
            role=role,
            content=content,
            tool_calls=tool_calls or []
        )
        
        self._current_session.entries.append(entry)
        self._current_session.last_updated = datetime.now().isoformat()
        self._save_session(self._current_session)

    def get_history(self, limit: int = 10) -> List[SessionEntry]:
        """Get recent history from current session."""
        if not self._current_session:
            return []
        return self._current_session.entries[-limit:]

    def list_sessions(self) -> List[Session]:
        """List all sessions."""
        sessions = []
        for session_file in sorted(self.base_path.glob("*.json")):
            session = self._load_session_file(session_file)
            if session:
                sessions.append(session)
        return sessions

    def delete_session(self, session_id: str) -> bool:
        """Delete a session by ID."""
        session_file = self.base_path / f"{session_id}.json"
        if not session_file.exists():
            return False
        
        session_file.unlink()
        if self._current_session and self._current_session.session_id == session_id:
            self._current_session = None
        
        self.console.print(f"[green]+[/green] Session {session_id} deleted")
        return True

    def export_session(self, session_id: str, format: str = "json") -> Path:
        """Export a session to a file."""
        session = self._load_session_file(self.base_path / f"{session_id}.json")
        if not session:
            raise FileNotFoundError(f"Session {session_id} not found")
        
        export_path = self.base_path / f"{session_id}_export.{format}"
        
        if format == "json":
            export_path.write_text(json.dumps(asdict(session), indent=2, default=str), encoding='utf-8')
        elif format == "md":
            markdown = self._session_to_markdown(session)
            export_path.write_text(markdown, encoding='utf-8')
        else:
            raise ValueError(f"Unsupported format: {format}")
        
        self.console.print(f"[green]done[/green] Session exported to {export_path}")
        return export_path

    def search_history(self, query: str, session_id: str = None) -> List[Dict]:
        """Search through session history for a query."""
        sessions_to_search = []
        if session_id:
            session = self._load_session_file(self.base_path / f"{session_id}.json")
            if session:
                sessions_to_search.append(session)
        else:
            sessions_to_search = self.list_sessions()
        
        results = []
        query_lower = query.lower()
        
        for session in sessions_to_search:
            for entry in session.entries:
                if query_lower in entry.content.lower():
                    results.append({
                        'session_id': session.session_id,
                        'session_name': session.name,
                        'timestamp': entry.timestamp,
                        'role': entry.role,
                        'content': entry.content
                    })
        
        return results

    def display_sessions_table(self):
        """Display a formatted table of all sessions."""
        sessions = self.list_sessions()
        if not sessions:
            self.console.print("[yellow]No sessions found[/yellow]")
            return
        
        table = Table(title="Sessions")
        table.add_column("ID", style="cyan")
        table.add_column("Name", style="green")
        table.add_column("Created", style="dim")
        table.add_column("Last Updated", style="dim")
        table.add_column("Entries", style="yellow")
        
        for session in sessions:
            table.add_row(
                session.session_id,
                session.name,
                session.created_at[:19],
                session.last_updated[:19],
                str(len(session.entries))
            )
        
        self.console.print(table)

    def _load_session_file(self, session_file: Path) -> Optional[Session]:
        """Load a session from a file."""
        try:
            with open(session_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            return Session(**data)
        except Exception as e:
            self.console.print(f"[red]Error loading session from {session_file}:[/red] {e}")
            return None

    def _save_session(self, session: Session):
        """Save a session to a file."""
        session_file = self.base_path / f"{session.session_id}.json"
        with open(session_file, 'w', encoding='utf-8') as f:
            json.dump(asdict(session), f, indent=2, default=str)

    def _session_to_markdown(self, session: Session) -> str:
        """Convert a session to markdown format."""
        md = f"# Session: {session.name}\n\n"
        md += f"**Session ID:** {session.session_id}\n"
        md += f"**Created:** {session.created_at}\n"
        md += f"**Last Updated:** {session.last_updated}\n\n"
        md += "---\n\n"
        
        for entry in session.entries:
            md += f"## {entry.role.upper()} - {entry.timestamp}\n\n"
            md += f"{entry.content}\n\n"
            
            if entry.tool_calls:
                md += "**Tool Calls:**\n"
                for tool_call in entry.tool_calls:
                    md += f"- {tool_call}\n"
                md += "\n"
            
            md += "---\n\n"
        
        return md
