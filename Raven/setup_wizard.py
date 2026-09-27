from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Optional
from rich.console import Console
from rich.prompt import Prompt, Confirm
from rich.panel import Panel
from rich.table import Table
from rich import box


class SetupWizard:
    def __init__(self, config_path: Path = None):
        self.config_path = config_path or Path.home() / ".raven" / "settings.json"
        self.console = Console()
        self.config: Dict = {}

    def run(self) -> bool:
        """Run the setup wizard."""
        self.console.print()
        self.console.print(Panel.fit(
            "[bold cyan]Raven Configuration Wizard[/bold cyan]",
            border_style="cyan"
        ))
        self.console.print()
        
        # Load existing config if exists
        if self.config_path.exists():
            try:
                with open(self.config_path, 'r') as f:
                    self.config = json.load(f)
                self.console.print("[dim]Found existing configuration.[/dim]")
            except:
                self.config = {}
        
        # Ask if user wants to configure
        if not Confirm.ask("Do you want to configure Raven now?", default=True):
            if self.config:
                self.console.print("[green]Using existing configuration.[/green]")
                return True
            else:
                self.console.print("[yellow]No configuration found. Using defaults.[/yellow]")
                self._create_default_config()
                return True
        
        # Backend configuration
        self._configure_backend()
        
        # API Keys
        self._configure_api_keys()
        
        # Database configuration
        self._configure_databases()
        
        # Advanced settings
        self._configure_advanced()
        
        # Save configuration
        self._save_config()
        
        self.console.print()
        self.console.print("[green]Configuration saved successfully![/green]")
        self.console.print(f"[dim]Configuration file: {self.config_path}[/dim]")
        
        return True

    def _configure_backend(self):
        """Configure the backend."""
        self.console.print("\n[bold cyan]Backend Configuration[/bold cyan]\n")
        
        backend = Prompt.ask(
            "Choose your backend",
            choices=["ollama", "openrouter", "custom", "omniroute"],
            default=self.config.get("backend", "ollama")
        )
        self.config["backend"] = backend
        
        if backend == "ollama":
            self.config["ollama_base_url"] = Prompt.ask(
                "Ollama base URL",
                default=self.config.get("ollama_base_url", "http://localhost:11434")
            )
            self.config["model"] = Prompt.ask(
                "Model name",
                default=self.config.get("model", "llama3.1")
            )
        
        elif backend == "openrouter":
            self.config["openrouter_api_key"] = Prompt.ask(
                "OpenRouter API key",
                default=self.config.get("openrouter_api_key", "")
            )
            self.config["model"] = Prompt.ask(
                "Model name",
                default=self.config.get("model", "meta-llama/llama-3-8b-instruct:free")
            )
        
        elif backend == "omniroute":
            self.config["omniroute_base_url"] = Prompt.ask(
                "OmniRoute base URL",
                default=self.config.get("omniroute_base_url", "http://localhost:20128/v1")
            )
            self.config["omniroute_api_key"] = Prompt.ask(
                "OmniRoute API key",
                default=self.config.get("omniroute_api_key", "")
            )
            self.config["model"] = Prompt.ask(
                "Model name (with provider prefix)",
                default=self.config.get("model", "openai/llama3.1")
            )
        
        elif backend == "custom":
            self.config["custom_base_url"] = Prompt.ask(
                "Custom base URL",
                default=self.config.get("custom_base_url", "")
            )
            self.config["custom_api_key"] = Prompt.ask(
                "Custom API key (optional)",
                default=self.config.get("custom_api_key", "")
            )
            self.config["model"] = Prompt.ask(
                "Model name",
                default=self.config.get("model", "")
            )

    def _configure_api_keys(self):
        """Configure API keys for external services."""
        self.console.print("\n[bold cyan]API Keys Configuration[/bold cyan]\n")
        
        if not Confirm.ask("Configure external API keys?", default=False):
            return
        
        # VirusTotal
        vt_key = Prompt.ask(
            "VirusTotal API key (optional)",
            default=self.config.get("virustotal_api_key", "")
        )
        if vt_key:
            self.config["virustotal_api_key"] = vt_key
        
        # AbuseIPDB
        abuse_key = Prompt.ask(
            "AbuseIPDB API key (optional)",
            default=self.config.get("abuseipdb_api_key", "")
        )
        if abuse_key:
            self.config["abuseipdb_api_key"] = abuse_key
        
        # Shodan
        shodan_key = Prompt.ask(
            "Shodan API key (optional)",
            default=self.config.get("shodan_api_key", "")
        )
        if shodan_key:
            self.config["shodan_api_key"] = shodan_key

    def _configure_databases(self):
        """Configure database connections."""
        self.console.print("\n[bold cyan]Database Configuration[/bold cyan]\n")
        
        if not Confirm.ask("Configure databases?", default=False):
            return
        
        self.config["databases"] = {}
        
        while True:
            if not Confirm.ask("Add a database?", default=False):
                break
            
            db_name = Prompt.ask("Database name (internal ID)")
            db_url = Prompt.ask("Database URL (SQLite, JSON, CSV, or connection string)")
            read_only = Confirm.ask("Read-only?", default=True)
            
            self.config["databases"][db_name] = {
                "url": db_url,
                "read_only": read_only
            }

    def _configure_advanced(self):
        """Configure advanced settings."""
        self.console.print("\n[bold cyan]Advanced Settings[/bold cyan]\n")
        
        # Workspace
        self.config["workspace"] = Prompt.ask(
            "Workspace directory",
            default=self.config.get("workspace", "./workspace")
        )
        
        # Temperature
        self.config["temperature"] = float(Prompt.ask(
            "AI temperature (0.0-1.0)",
            default=str(self.config.get("temperature", "0.3"))
        ))
        
        # Max iterations
        self.config["max_iterations"] = int(Prompt.ask(
            "Max tool iterations",
            default=str(self.config.get("max_iterations", "12"))
        ))
        
        # Show thinking
        self.config["show_thinking"] = Confirm.ask(
            "Show AI thinking process?",
            default=self.config.get("show_thinking", True)
        )
        
        # Browser
        if Confirm.ask("Enable browser?", default=False):
            self.config["browser"] = {
                "enabled": True,
                "headless": Prompt.ask("Headless mode?", choices=["true", "false"], default="true") == "true"
            }
        else:
            self.config["browser"] = {"enabled": False}

    def _create_default_config(self):
        """Create default configuration."""
        self.config = {
            "backend": "ollama",
            "ollama_base_url": "http://localhost:11434",
            "model": "llama3.1",
            "temperature": 0.3,
            "max_iterations": 12,
            "show_thinking": True,
            "workspace": "./workspace",
            "browser": {"enabled": False},
            "databases": {}
        }
        self._save_config()

    def _save_config(self):
        """Save configuration to file."""
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.config_path, 'w') as f:
            json.dump(self.config, f, indent=2)

    def get_config(self) -> Dict:
        """Get the configuration."""
        return self.config


def run_setup_wizard() -> Dict:
    """Run the setup wizard and return configuration."""
    wizard = SetupWizard()
    wizard.run()
    return wizard.get_config()
