"""Provider and protocol compatibility layer for Raven.

Integrations are opt-in. Credentials are referenced by environment variable
names; this module never writes secret values to Raven configuration.
"""
from __future__ import annotations

import json
import os
import queue
import secrets
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Callable


class EventBus:
    def __init__(self):
        self._listeners: dict[str, list[Callable[[dict], None]]] = {}
        self._lock = threading.Lock()

    def subscribe(self, event: str, callback: Callable[[dict], None]) -> None:
        with self._lock:
            self._listeners.setdefault(event, []).append(callback)

    def publish(self, event: str, payload: dict | None = None) -> int:
        with self._lock:
            listeners = list(self._listeners.get(event, [])) + list(self._listeners.get("*", []))
        for callback in listeners:
            try: callback(payload or {})
            except Exception: pass
        return len(listeners)


@dataclass
class Integration:
    name: str
    enabled: bool = False
    token_env: str = ""
    capabilities_list: list[str] = field(default_factory=list)

    def health_check(self) -> dict:
        token = bool(os.environ.get(self.token_env)) if self.token_env else True
        return {"name": self.name, "enabled": self.enabled, "credentials_present": token, "capabilities": self.capabilities_list}


class IntegrationManager:
    KNOWN = {
        "github": ["issues", "pull_requests", "reviews"],
        "gitlab": ["issues", "merge_requests", "pipelines"],
        "bitbucket": ["repositories", "pull_requests"],
        "google_calendar": ["events", "reminders"],
        "outlook_calendar": ["events", "reminders"],
        "slack": ["search", "messages", "notifications"],
        "telegram": ["messages", "notifications"],
        "twilio": ["sms"],
        "sentry": ["issues", "events", "releases"],
        "linear": ["issues", "projects", "comments"],
        "notion": ["pages", "databases", "search"],
        "docker": ["containers", "images", "logs"],
        "kubernetes": ["pods", "services", "deployments"],
        "jenkins": ["jobs", "builds"],
    }

    def __init__(self, config: dict | None = None):
        self.config = config or {}
        self.bus = EventBus()

    def list(self) -> list[dict]:
        configured = self.config.get("integrations", {})
        result = []
        for name, capabilities in self.KNOWN.items():
            item = configured.get(name, {}) if isinstance(configured, dict) else {}
            result.append({"name": name, "enabled": bool(item.get("enabled", False)), "capabilities": capabilities, "token_env": item.get("token_env", "")})
        return result

    def health(self, name: str = "") -> dict:
        items = self.list()
        if name:
            items = [item for item in items if item["name"] == name]
        for item in items:
            token_env = item.get("token_env")
            item["credentials_present"] = bool(os.environ.get(token_env)) if token_env else not item["enabled"]
        return {"integrations": items}


class MCPClient:
    """Minimal MCP JSON-RPC client for a configured stdio server."""
    def __init__(self, command: list[str], env: dict | None = None):
        self.command = command
        self.env = {**os.environ, **(env or {})}

    def describe(self) -> dict:
        return {"transport": "stdio", "command": self.command, "status": "configured"}


class WebhookInbox:
    def __init__(self, secret: str = ""):
        self.secret = secret
        self.events: queue.Queue[dict] = queue.Queue(maxsize=1000)

    def receive(self, payload: dict, provided_secret: str = "") -> dict:
        if self.secret and not secrets.compare_digest(self.secret, provided_secret):
            return {"accepted": False, "error": "invalid webhook secret"}
        event = {"payload": payload}
        try: self.events.put_nowait(event)
        except queue.Full: return {"accepted": False, "error": "webhook queue is full"}
        return {"accepted": True}

    def next(self) -> dict | None:
        try: return self.events.get_nowait()
        except queue.Empty: return None


def export_conversation(messages: list[dict], output: str, fmt: str = "json") -> dict:
    target = Path(output).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    if fmt == "jsonl":
        content = "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in messages)
    elif fmt == "md":
        content = "\n\n".join(f"## {item.get('role', 'message').title()}\n\n{item.get('content', '')}" for item in messages)
    else:
        content = json.dumps(messages, indent=2, ensure_ascii=False)
    target.write_text(content, encoding="utf-8")
    return {"success": True, "path": str(target), "format": fmt, "messages": len(messages)}


def register_integration_tools(registry: dict, config: dict) -> None:
    manager = IntegrationManager(config)
    inbox = WebhookInbox()
    registry["integration_list"] = {"fn": lambda: manager.list(), "description": "List supported Raven integrations and capabilities."}
    registry["integration_health"] = {"fn": manager.health, "description": "Check configured integration health. Args: {name?: str}"}
    registry["event_publish"] = {"fn": manager.bus.publish, "description": "Publish an internal Raven event. Args: {event: str, payload?: dict}"}
    registry["webhook_next"] = {"fn": lambda: inbox.next() or {"status": "empty"}, "description": "Read the next local webhook event."}
    registry["conversation_export"] = {"fn": export_conversation, "description": "Export messages as JSON, JSONL or Markdown. Args: {messages, output, fmt?: str}"}

