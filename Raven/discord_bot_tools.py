from __future__ import annotations

from typing import Any
import json
import os
from pathlib import Path
import requests

from .confirmation import HumanConfirmation


class DiscordTools:
    """Read-only Discord bot client scoped to configured guild and channels."""

    API = "https://discord.com/api/v10"

    def __init__(self, token: str, guild_id: str = "", channel_ids: list[str] | None = None, console=None):
        self.token = token
        self.guild_id = guild_id
        self.channel_ids = set(channel_ids or [])
        self.confirmation = HumanConfirmation(console)

    def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        response = requests.get(
            self.API + path,
            headers={"Authorization": f"Bot {self.token}"},
            params=params or {},
            timeout=20,
        )
        if response.status_code >= 400:
            return {"error": f"Discord API {response.status_code}: {response.text[:300]}"}
        return response.json()

    def _approved(self, action: str) -> bool:
        return self.confirmation.require(action)

    def list_guilds(self) -> dict:
        if not self._approved("list Discord servers accessible to the bot"):
            return {"status": "denied"}
        guilds = self._get("/users/@me/guilds")
        if isinstance(guilds, dict) and guilds.get("error"):
            return guilds
        return {"guilds": [{"id": g.get("id"), "name": g.get("name")} for g in guilds]}

    def configure_scope(self, guild_id: str, channel_ids: list[str]) -> dict:
        if not guild_id or not channel_ids:
            return {"error": "guild_id and at least one channel_id are required"}
        if not guild_id.isdigit() or any(not str(channel).isdigit() for channel in channel_ids):
            return {"error": "Discord IDs must contain digits only"}
        if not self._approved(f"save Discord scope guild={guild_id} channels={len(channel_ids)}"):
            return {"status": "denied"}
        config_path = Path.home() / ".raven" / "config.json"
        try:
            data = json.loads(config_path.read_text(encoding="utf-8")) if config_path.exists() else {}
            discord = data.setdefault("discord", {})
            discord.update({"enabled": True, "token_env": "DISCORD_BOT_TOKEN", "guild_id": guild_id, "channel_ids": list(channel_ids)})
            config_path.parent.mkdir(parents=True, exist_ok=True)
            config_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
            self.guild_id = guild_id
            self.channel_ids = set(channel_ids)
            return {"status": "saved", "guild_id": guild_id, "channel_ids": channel_ids}
        except Exception as exc:
            return {"error": str(exc)}

    def guild_channels(self) -> dict:
        if not self.guild_id:
            return {"error": "No Discord server configured. Use discord_list_guilds then discord_configure_scope."}
        if not self._approved("list Discord channels"):
            return {"status": "denied"}
        channels = self._get(f"/guilds/{self.guild_id}/channels")
        if isinstance(channels, dict) and channels.get("error"):
            return channels
        return {
            "channels": [
                {"id": c.get("id"), "name": c.get("name"), "type": c.get("type")}
                for c in channels if c.get("type") in (0, 5, 10, 11, 12)
            ]
        }

    def lookup_user(self, user_id: str) -> dict:
        if not self._approved(f"look up Discord user {user_id}"):
            return {"status": "denied"}
        return self._get(f"/users/{user_id}")

    def search_messages(self, query: str, channel_id: str = "", author_id: str = "", limit: int = 50) -> dict:
        if not query.strip():
            return {"error": "query is required"}
        if channel_id and self.channel_ids and channel_id not in self.channel_ids:
            return {"error": "channel is outside the configured Discord scope"}
        if not self._approved(f"search Discord messages for {query[:80]!r}"):
            return {"status": "denied"}
        targets = [channel_id] if channel_id else sorted(self.channel_ids)
        if not targets:
            return {"error": "configure channel_ids or provide a channel_id"}
        matches = []
        for target in targets:
            before = None
            for _ in range(4):
                params = {"limit": min(max(limit, 1), 100)}
                if before:
                    params["before"] = before
                messages = self._get(f"/channels/{target}/messages", params)
                if isinstance(messages, dict) and messages.get("error"):
                    return messages
                if not messages:
                    break
                for message in messages:
                    content = message.get("content", "")
                    author = message.get("author", {})
                    if query.lower() in content.lower() and (not author_id or author.get("id") == author_id):
                        matches.append({
                            "id": message.get("id"),
                            "channel_id": target,
                            "author_id": author.get("id"),
                            "author_name": author.get("username"),
                            "timestamp": message.get("timestamp"),
                            "content": content,
                        })
                        if len(matches) >= min(limit, 100):
                            return {"count": len(matches), "messages": matches}
                before = messages[-1].get("id")
        return {"count": len(matches), "messages": matches}
