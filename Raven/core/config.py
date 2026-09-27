"""
Core Configuration Module

Centralized configuration management for all Raven applications.
Settings are stored in ~/.raven/config.json and can be managed via API or UI.
"""

import json
from pathlib import Path
from typing import Dict, Any, Optional
from dataclasses import dataclass, field, asdict


@dataclass
class BackendConfig:
    """Backend configuration"""
    type: str = "ollama"  # ollama, openrouter, custom, omniroute
    base_url: str = ""
    api_key: str = ""
    model: str = "llama3.1"
    temperature: float = 0.3
    max_tokens: int = 16384
    timeout: int = 300  # Increased to 5 minutes to avoid timeouts


@dataclass
class DatabaseConfig:
    """Database configuration"""
    name: str
    url: str
    read_only: bool = True
    type: str = "auto"  # auto, sqlite, postgres, mysql, json, csv, txt


@dataclass
class WorkspaceConfig:
    """Workspace configuration"""
    path: str = "./workspace"
    max_size_mb: int = 1024
    unrestricted: bool = False  # If True, allow file operations anywhere (use with caution)


@dataclass
class BrowserConfig:
    """Browser configuration"""
    enabled: bool = False
    headless: bool = True
    user_data_dir: Optional[str] = None


@dataclass
class DiscordConfig:
    """Read-only Discord bot scope."""
    enabled: bool = False
    token_env: str = "DISCORD_BOT_TOKEN"
    guild_id: str = ""
    channel_ids: list[str] = field(default_factory=list)


@dataclass
class APIKeysConfig:
    """External API keys"""
    virustotal: str = ""
    abuseipdb: str = ""
    shodan: str = ""
    openrouter: str = ""
    nvidia: str = ""


@dataclass
class TaskConfig:
    """Task configuration"""
    max_concurrent: int = 10
    queue_size: int = 100
    timeout: int = 300


@dataclass
class CoreConfig:
    """Main configuration class"""
    backend: BackendConfig = field(default_factory=BackendConfig)
    databases: Dict[str, DatabaseConfig] = field(default_factory=dict)
    workspace: WorkspaceConfig = field(default_factory=WorkspaceConfig)
    browser: BrowserConfig = field(default_factory=BrowserConfig)
    discord: DiscordConfig = field(default_factory=DiscordConfig)
    api_keys: APIKeysConfig = field(default_factory=APIKeysConfig)
    tasks: TaskConfig = field(default_factory=TaskConfig)
    show_thinking: bool = True
    max_iterations: int = 32
    auto_save: bool = True
    enabled_skills: list[str] = field(default_factory=list)
    integrations: Dict[str, Any] = field(default_factory=dict)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary"""
        return asdict(self)
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'CoreConfig':
        """Create from dictionary"""
        backend_data = data.get('backend', {})
        if isinstance(backend_data, dict):
            backend = BackendConfig(**backend_data)
        else:
            backend = BackendConfig()
        
        databases = {}
        for name, db_data in data.get('databases', {}).items():
            databases[name] = DatabaseConfig(**db_data)
        
        workspace = WorkspaceConfig(**data.get('workspace', {}))
        browser = BrowserConfig(**data.get('browser', {}))
        discord = DiscordConfig(**data.get('discord', {}))
        api_keys = APIKeysConfig(**data.get('api_keys', {}))
        tasks = TaskConfig(**data.get('tasks', {}))
        
        return cls(
            backend=backend,
            databases=databases,
            workspace=workspace,
            browser=browser,
            discord=discord,
            api_keys=api_keys,
            tasks=tasks,
            show_thinking=data.get('show_thinking', True),
            max_iterations=data.get('max_iterations', 32),
            auto_save=data.get('auto_save', True),
            enabled_skills=data.get('enabled_skills', []),
            integrations=data.get('integrations', {})
        )


class ConfigManager:
    """Configuration manager with persistence"""
    
    def __init__(self, config_path: Optional[Path] = None):
        self.config_path = config_path or Path.home() / ".raven" / "config.json"
        self.config: CoreConfig = CoreConfig()
        self._load()
    
    def _load(self):
        """Load configuration from file"""
        if self.config_path.exists():
            try:
                with open(self.config_path, 'r') as f:
                    data = json.load(f)
                self.config = CoreConfig.from_dict(data)
            except Exception as e:
                print(f"Warning: Failed to load config, using defaults: {e}")
    
    def save(self):
        """Save configuration to file"""
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.config_path, 'w') as f:
            json.dump(self.config.to_dict(), f, indent=2)
    
    def get(self) -> CoreConfig:
        """Get current configuration"""
        return self.config
    
    def update(self, **kwargs):
        """Update configuration"""
        for key, value in kwargs.items():
            if hasattr(self.config, key):
                setattr(self.config, key, value)
        self.save()
    
    def set_backend(self, backend_type: str, base_url: str = "", api_key: str = "", model: str = ""):
        """Set backend configuration"""
        self.config.backend.type = backend_type
        if base_url:
            self.config.backend.base_url = base_url
        if api_key:
            self.config.backend.api_key = api_key
        if model:
            self.config.backend.model = model
        self.save()
    
    def add_database(self, name: str, url: str, read_only: bool = True):
        """Add database configuration"""
        self.config.databases[name] = DatabaseConfig(name=name, url=url, read_only=read_only)
        self.save()
    
    def remove_database(self, name: str):
        """Remove database configuration"""
        if name in self.config.databases:
            del self.config.databases[name]
            self.save()
    
    def set_api_key(self, service: str, key: str):
        """Set API key for external service"""
        if hasattr(self.config.api_keys, service):
            setattr(self.config.api_keys, service, key)
            self.save()
    
    def reset(self):
        """Reset to default configuration"""
        self.config = CoreConfig()
        self.save()
