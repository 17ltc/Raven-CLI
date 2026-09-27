"""
Core Tools Module

Tool registry and execution system - reusable across all interfaces.
"""

import json
from typing import Dict, Callable, Any, Optional, List
from dataclasses import dataclass


@dataclass
class Tool:
    """Represents a tool"""
    name: str
    description: str
    fn: Callable
    schema: Optional[Dict] = None


class ToolRegistry:
    """Central tool registry"""
    
    def __init__(self):
        self.tools: Dict[str, Tool] = {}
    
    def register(self, name: str, description: str, fn: Callable, schema: Optional[Dict] = None):
        """Register a tool"""
        self.tools[name] = Tool(name=name, description=description, fn=fn, schema=schema)
    
    def unregister(self, name: str):
        """Unregister a tool"""
        if name in self.tools:
            del self.tools[name]
    
    def get(self, name: str) -> Optional[Tool]:
        """Get a tool by name"""
        return self.tools.get(name)
    
    def list(self) -> List[Tool]:
        """List all tools"""
        return list(self.tools.values())
    
    def execute(self, name: str, arguments: Dict) -> Dict:
        """Execute a tool"""
        tool = self.get(name)
        if not tool:
            return {"error": f"Tool '{name}' not found"}
        
        try:
            result = tool.fn(**arguments)
            if isinstance(result, dict):
                return result
            return {"result": result}
        except Exception as e:
            return {"error": str(e)}
    
    def get_schema(self) -> Dict:
        """Get tool schema for LLM"""
        return {
            name: {
                "description": tool.description,
                "parameters": tool.schema or {}
            }
            for name, tool in self.tools.items()
        }


# Built-in tools
def register_built_in_tools(registry: ToolRegistry, config):
    """Register built-in tools"""
    from ..tools import build_registry
    # Convert CoreConfig to dictionary if needed
    if hasattr(config, 'to_dict'):
        config_dict = config.to_dict()
    else:
        config_dict = config
    tool_dict = build_registry(config_dict)
    
    for name, tool_info in tool_dict.items():
        registry.register(
            name=name,
            description=tool_info["description"],
            fn=tool_info["fn"]
        )
    
    return registry
