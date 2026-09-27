"""
Core Agent Module

The AI agent that orchestrates tool calls, manages context, and provides responses.
This is the brain of Raven - reusable across all interfaces.
"""

import json
import re
from typing import Dict, List, Optional, Callable
from dataclasses import dataclass
from pathlib import Path

from .config import CoreConfig


TOOL_BLOCK_RE = re.compile(r"```tool\s*\n(.*?)\n```", re.DOTALL)
THINKING_BLOCK_RE = re.compile(r"```thinking\s*\n(.*?)\n```", re.DOTALL)
TASK_BLOCK_RE = re.compile(r"```task\s*\n(.*?)\n```", re.DOTALL)


@dataclass
class ToolCall:
    """Represents a tool call"""
    name: str
    arguments: Dict
    result: Optional[Dict] = None
    error: Optional[str] = None


@dataclass
class Message:
    """Represents a message in the conversation"""
    role: str  # user, assistant, system
    content: str
    tool_calls: List[ToolCall] = None
    timestamp: Optional[str] = None


class Agent:
    """Core AI Agent - reusable across all interfaces"""
    
    def __init__(
        self,
        config: CoreConfig,
        tool_registry: 'ToolRegistry',
        backend_client,
        max_iterations: int = 32,
        show_thinking: bool = True,
        skills_root: Path = None,
        skill_loader_callback: Callable = None
    ):
        self.config = config
        self.tool_registry = tool_registry
        self.backend = backend_client
        self.max_iterations = max_iterations
        self.show_thinking = show_thinking
        self.messages: List[Message] = []
        self.skills_root = skills_root
        self.skill_loader_callback = skill_loader_callback
        self.loaded_skills = set()
        self._initialize_system_prompt()
    
    def _initialize_system_prompt(self):
        """Initialize system prompt"""
        self.messages.append(Message(
            role="system",
            content=self._build_system_prompt()
        ))
    
    def _build_system_prompt(self) -> str:
        """Build system prompt from configuration"""
        # This would be loaded from skills
        base_prompt = """You are Raven, an intelligent assistant with dynamic skill loading.

You have the ability to detect when additional skills might be needed and can request them automatically.

Before using any tool or giving a final answer, you MUST provide your reasoning in a ```thinking block.
- State what you already know
- Plan which independent sources to cross-check
- Once you have results, evaluate if they corroborate or contradict each other
- Use the Admiralty Code: rate source reliability (A-F) and information credibility (1-6)

Skill Detection:
If you detect that the user's request requires expertise you don't currently have (e.g., frontend design, specialized analysis), 
you can request additional skills by using this format in your thinking:
SKILL_REQUEST: skill_name

Available skills that can be loaded:
- frontend-design: UI/UX design, component architecture, responsive layouts, accessibility
- cmd: Shell command execution with user confirmation
(plus your currently loaded skills)

Tool format:
```tool
{"name": "tool_name", "arguments": {"key": "value"}}
```

IMPORTANT - File Creation:
When you create or edit files, always use a tool block and wait for its result.
Prefer write_file for complete files and keep the JSON tool block valid and
closed before stopping. Never paste a huge unfinished tool block as a final answer.
If the user explicitly asks to create, edit, rename, delete, or inspect a local
file, do not answer with invented content, poetry, or a description of the file.
Call the appropriate file/project tool first. A request is only complete after
the tool result confirms the operation.
When you create files using the write_file or create_file tool:
- DO NOT show the full file content in your response
- Simply confirm that the file was created at the returned path.
- Only show file content if the user specifically asks to see it
- This keeps conversations clean and focused

After using tools, provide your final answer with confidence level."""
        
        return base_prompt
    
    def add_message(self, role: str, content: str, tool_calls: List[ToolCall] = None):
        """Add a message to the conversation"""
        self.messages.append(Message(
            role=role,
            content=content,
            tool_calls=tool_calls
        ))
    
    def process(self, user_input: str, callback: Optional[Callable] = None) -> str:
        """Process user input and return response"""
        self.add_message("user", user_input)
        
        for iteration in range(self.max_iterations):
            # Get backend response
            response = self._call_backend(callback)
            self.add_message("assistant", response)
            
            # Extract thinking and tool calls
            thinking, remainder = self._extract_thinking(response)
            
            if thinking and self.show_thinking:
                if callback:
                    callback("thinking", thinking)
                
                # Check for skill requests in thinking
                skill_request = self._extract_skill_request(thinking)
                if skill_request and self.skill_loader_callback:
                    self._load_skill(skill_request)
            
            # Extract tool calls
            tool_calls = self._extract_tool_calls(remainder)
            
            if not tool_calls:
                # No more tool calls, this is the final answer
                return remainder or response
            
            # Execute tool calls
            for tool_call in tool_calls:
                if callback:
                    callback("tool_call", tool_call)
                
                result = self._execute_tool(tool_call)
                tool_call.result = result
                
                if callback:
                    callback("tool_result", result)
                
                # Add tool result as user message
                self.add_message("user", f"TOOL RESULT for {tool_call.name}:\n{json.dumps(result, indent=2, default=str)[:8000]}")
        
        return "[Raven stopped after the safety limit before producing a final synthesis. The collected tool results remain in the session history; ask for a synthesis or raise max_iterations in config.]"
    
    def _call_backend(self, callback: Optional[Callable] = None) -> str:
        """Call the backend API"""
        messages = [{"role": m.role, "content": m.content} for m in self.messages]
        on_chunk = None
        if callback:
            on_chunk = lambda chunk: callback("stream", chunk)
        return self.backend.chat(messages, on_chunk=on_chunk)
    
    def _extract_thinking(self, text: str) -> tuple:
        """Extract thinking block from response"""
        match = THINKING_BLOCK_RE.search(text)
        if match:
            thinking = match.group(1).strip()
            remainder = text[:match.start()] + text[match.end():]
            return thinking, remainder.strip()
        return "", text
    
    def _extract_tool_calls(self, text: str) -> List[ToolCall]:
        """Extract tool calls from response"""
        tool_calls = []
        for match in TOOL_BLOCK_RE.finditer(text):
            try:
                data = json.loads(match.group(1))
                tool_calls.append(ToolCall(
                    name=data.get("name"),
                    arguments=data.get("arguments", {})
                ))
            except json.JSONDecodeError:
                continue
        return tool_calls
    
    def _execute_tool(self, tool_call: ToolCall) -> Dict:
        """Execute a tool call"""
        return self.tool_registry.execute(tool_call.name, tool_call.arguments)
    
    def reset(self):
        """Reset the conversation"""
        self.messages = []
        self._initialize_system_prompt()
    
    def get_history(self) -> List[Dict]:
        """Get conversation history"""
        return [
            {
                "role": m.role,
                "content": m.content,
                "timestamp": m.timestamp
            }
            for m in self.messages
        ]
    
    def _extract_skill_request(self, thinking: str) -> Optional[str]:
        """Extract skill request from thinking block"""
        import re
        match = re.search(r'SKILL_REQUEST:\s*(\w+)', thinking)
        if match:
            skill_name = match.group(1)
            if skill_name not in self.loaded_skills:
                return skill_name
        return None
    
    def _load_skill(self, skill_name: str):
        """Load a skill dynamically"""
        if not self.skill_loader_callback:
            return
        
        try:
            success, message = self.skill_loader_callback(skill_name)
            if success:
                self.loaded_skills.add(skill_name)
                # Add a system message to inform the agent
                self.add_message("system", f"Skill '{skill_name}' has been loaded and is now available.")
            else:
                self.add_message("system", f"Failed to load skill '{skill_name}': {message}")
        except Exception as e:
            self.add_message("system", f"Error loading skill '{skill_name}': {str(e)}")
