from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Optional

from rich.console import Console

from .backend import ChatBackend
from .enhanced_display import EnhancedDisplay, ThinkingIndicator
from .style import DIM_GRAY, print_thinking
from .tools import TOOLS as DEFAULT_TOOLS, run_tool

TOOL_BLOCK_RE = re.compile(r"```tool\s*\n(.*?)\n```", re.DOTALL)
THINKING_BLOCK_RE = re.compile(r"```thinking\s*\n(.*?)\n```", re.DOTALL)
TASK_BLOCK_RE = re.compile(r"```task\s*\n(.*?)\n```", re.DOTALL)


@dataclass
class AgentSession:
    backend: ChatBackend
    system_prompt: str
    registry: dict = field(default_factory=lambda: DEFAULT_TOOLS)
    max_iterations: int = 12
    show_thinking: bool = True
    console: Console = field(default_factory=Console)
    messages: list[dict] = field(default_factory=list)
    task_manager: Optional[object] = None  # TaskManager instance
    enhanced_display: Optional[EnhancedDisplay] = None

    def __post_init__(self):
        if not self.messages:
            self.messages = [{"role": "system", "content": self.system_prompt}]
        self.enhanced_display = EnhancedDisplay(self.console)

    def _extract_thinking(self, text: str) -> tuple[str | None, str]:
        """Pulls out a ```thinking block if present, returns (thinking_or_None,
        remainder_with_thinking_removed). The remainder is what gets checked
        for a tool call or treated as the final answer."""
        match = THINKING_BLOCK_RE.search(text)
        if not match:
            return None, text
        thinking = match.group(1).strip()
        remainder = (text[:match.start()] + text[match.end():]).strip()
        return thinking, remainder

    def _extract_tool_call(self, text: str):
        """Returns (call_dict_or_None, attempted_but_malformed: bool)."""
        match = TOOL_BLOCK_RE.search(text)
        if not match:
            return None, False
        try:
            return json.loads(match.group(1)), False
        except json.JSONDecodeError:
            return None, True

    def _extract_task_call(self, text: str):
        """Extract parallel task calls from ```task blocks."""
        match = TASK_BLOCK_RE.search(text)
        if not match:
            return None, False
        try:
            return json.loads(match.group(1)), False
        except json.JSONDecodeError:
            return None, True

    def ask(self, user_message: str) -> str:
        self.messages.append({"role": "user", "content": user_message})

        for i in range(self.max_iterations):
            reply = self.backend.chat(self.messages)
            self.messages.append({"role": "assistant", "content": reply})

            thinking, remainder = self._extract_thinking(reply)
            if thinking and self.show_thinking:
                # Use enhanced display for thinking
                formatted_thinking = self.enhanced_display.format_thinking_block(thinking)
                self.console.print(formatted_thinking)

            # Check for parallel task calls first
            task_call, task_malformed = self._extract_task_call(remainder)
            if task_call and not task_malformed:
                self._handle_parallel_tasks(task_call)
                # Remove task block from remainder for tool call processing
                remainder = TASK_BLOCK_RE.sub("", remainder).strip()

            call, malformed = self._extract_tool_call(remainder)

            if call is None and not malformed and task_call is None:
                # Use enhanced display for final response
                formatted_response = self.enhanced_display.format_response(remainder or reply)
                return formatted_response

            if malformed or task_malformed:
                self.console.print(f"[{DIM_GRAY}]  -> malformed block, asking model to retry[/{DIM_GRAY}]")
                self.messages.append({
                    "role": "user",
                    "content": (
                        "Your block wasn't valid JSON, so nothing ran. "
                        "Reply again — thinking block first, then either a valid "
                        '```tool block ({"name": "...", "arguments": {...}}), '
                        '```task block for parallel tasks, or your final answer.'
                    ),
                })
                continue

            # Handle tool call if present
            if call:
                name = call.get("name")
                args = call.get("arguments", {}) or {}
                if not name:
                    self.messages.append({
                        "role": "user",
                        "content": 'Your ```tool block is missing a "name" field. Retry with {"name": "...", "arguments": {...}}.',
                    })
                    continue

                # Use enhanced display for tool call
                formatted_tool = self.enhanced_display.format_tool_call(name, args)
                self.console.print(formatted_tool)
                
                result = run_tool(name, args, registry=self.registry)
                result_str = json.dumps(result, indent=2, default=str)[:8000]

                self.messages.append({
                    "role": "user",
                    "content": f"TOOL RESULT for {name}:\n{result_str}",
                })

        return "[stopped: reached max tool-call iterations without a final answer]"

    def _handle_parallel_tasks(self, task_call: dict):
        """Handle parallel task execution."""
        if not self.task_manager:
            self.console.print("[yellow]Task manager not available for parallel execution[/yellow]")
            return

        tasks = task_call.get("tasks", [])
        if not tasks:
            return

        self.console.print(f"[cyan]→ Starting {len(tasks)} parallel tasks...[/cyan]")

        task_ids = []
        for task_def in tasks:
            task_name = task_def.get("name", "unnamed_task")
            task_desc = task_def.get("description", "")
            
            # Create a simple wrapper function for the task
            def task_wrapper(tool_name, tool_args):
                return run_tool(tool_name, tool_args, registry=self.registry)
            
            tool_name = task_def.get("tool")
            tool_args = task_def.get("arguments", {})
            
            if not tool_name:
                self.console.print(f"[red]Skipping task {task_name}: missing tool name[/red]")
                continue
            
            task_id = self.task_manager.create_task(
                name=task_name,
                description=task_desc,
                func=task_wrapper,
                args=(tool_name, tool_args)
            )
            task_ids.append(task_id)

        # Submit all tasks
        self.task_manager.submit_batch(task_ids)
        self.console.print(f"[green]done[/green] {len(task_ids)} tasks submitted for parallel execution")
