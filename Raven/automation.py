"""Persistent reminders and lightweight calendar interoperability."""
from __future__ import annotations

import json
import re
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .confirmation import HumanConfirmation


class AutomationStore:
    def __init__(self, path: Path | None = None):
        self.path = path or (Path.home() / ".raven" / "automations.json")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _read(self) -> list[dict]:
        if not self.path.exists():
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
        except (OSError, json.JSONDecodeError):
            return []

    def _write(self, data: list[dict]) -> None:
        temp = self.path.with_suffix(".tmp")
        temp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        temp.replace(self.path)

    def list(self, include_done: bool = False) -> list[dict]:
        data = self._read()
        return data if include_done else [item for item in data if item.get("status") == "active"]

    def create(self, title: str, when: str, prompt: str = "", recurrence: str = "") -> dict:
        run_at = parse_when(when)
        if run_at is None:
            return {"success": False, "error": "Invalid time. Use ISO datetime, 'in 20m', or 'tomorrow 09:00'."}
        item = {"id": uuid.uuid4().hex[:10], "title": title, "prompt": prompt or title, "run_at": run_at.isoformat(), "recurrence": recurrence, "status": "active", "created_at": datetime.now(timezone.utc).isoformat(), "last_run": None}
        with self._lock:
            data = self._read(); data.append(item); self._write(data)
        return {"success": True, "reminder": item}

    def cancel(self, reminder_id: str) -> dict:
        with self._lock:
            data = self._read()
            for item in data:
                if item.get("id") == reminder_id:
                    item["status"] = "cancelled"; self._write(data)
                    return {"success": True, "reminder": item}
        return {"success": False, "error": "Reminder not found"}

    def due(self) -> list[dict]:
        now = datetime.now(timezone.utc)
        due = []
        with self._lock:
            data = self._read()
            changed = False
            for item in data:
                if item.get("status") != "active": continue
                try: run_at = datetime.fromisoformat(item["run_at"])
                except (KeyError, ValueError): continue
                if run_at <= now:
                    due.append(dict(item)); item["last_run"] = now.isoformat()
                    if item.get("recurrence"):
                        item["run_at"] = next_occurrence(run_at, item["recurrence"]).isoformat()
                    else: item["status"] = "done"
                    changed = True
            if changed: self._write(data)
        return due

    def export_ics(self, output: str) -> dict:
        target = Path(output).expanduser().resolve()
        if not HumanConfirmation().require(f"export reminders to {target}"):
            return {"success": False, "status": "denied"}
        lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Raven CLI//EN"]
        for item in self.list():
            dt = datetime.fromisoformat(item["run_at"]).astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            lines += ["BEGIN:VEVENT", f"UID:{item['id']}@raven", f"DTSTART:{dt}", f"SUMMARY:{ics_escape(item['title'])}", f"DESCRIPTION:{ics_escape(item.get('prompt', ''))}", "END:VEVENT"]
        lines.append("END:VCALENDAR")
        target.write_text("\r\n".join(lines) + "\r\n", encoding="utf-8")
        return {"success": True, "path": str(target), "count": len(self.list())}


def parse_when(value: str) -> datetime | None:
    now = datetime.now(timezone.utc)
    text = value.strip().lower()
    match = re.fullmatch(r"in\s+(\d+)\s*(m|h|d)", text)
    if match:
        amount = int(match.group(1)); unit = match.group(2)
        delta = {"m": {"minutes": amount}, "h": {"hours": amount}, "d": {"days": amount}}[unit]
        return now + timedelta(**delta)
    if text.startswith("tomorrow"):
        clock = text.replace("tomorrow", "").strip() or "09:00"
        try: hour, minute = map(int, clock.split(":", 1)); local = datetime.now().astimezone() + timedelta(days=1); return local.replace(hour=hour, minute=minute, second=0, microsecond=0).astimezone(timezone.utc)
        except ValueError: return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return (parsed if parsed.tzinfo else parsed.astimezone()).astimezone(timezone.utc)
    except ValueError: return None


def next_occurrence(previous: datetime, recurrence: str) -> datetime:
    value = recurrence.lower().strip()
    if value in {"hourly", "hour"}: return previous + timedelta(hours=1)
    if value in {"daily", "day"}: return previous + timedelta(days=1)
    if value in {"weekly", "week"}: return previous + timedelta(days=7)
    match = re.fullmatch(r"every\s+(\d+)\s*(m|h|d)", value)
    if match: return previous + timedelta(**({"minutes": int(match.group(1))} if match.group(2) == "m" else {"hours": int(match.group(1))} if match.group(2) == "h" else {"days": int(match.group(1))}))
    return previous + timedelta(days=1)


def ics_escape(value: str) -> str:
    return str(value).replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def register_automation_tools(registry: dict) -> None:
    store = AutomationStore()
    registry["reminder_create"] = {"fn": store.create, "description": "Create a persistent reminder. Args: {title, when, prompt?, recurrence?}"}
    registry["reminder_list"] = {"fn": store.list, "description": "List active reminders. Args: {include_done?: bool}"}
    registry["reminder_cancel"] = {"fn": store.cancel, "description": "Cancel a reminder. Args: {reminder_id}"}
    registry["reminder_due"] = {"fn": lambda: {"due": store.due()}, "description": "Collect reminders due now and advance recurring reminders. Args: {}"}
    registry["calendar_export_ics"] = {"fn": store.export_ics, "description": "Export Raven reminders to an ICS calendar file. Args: {output}"}
