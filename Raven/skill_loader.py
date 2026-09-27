from __future__ import annotations

from pathlib import Path

from .tools import TOOLS as DEFAULT_TOOLS

TOOL_PROTOCOL = """
## Reasoning & tool-use protocol

This works the same regardless of which model is running you — it does not
rely on any provider's native function-calling or "thinking" feature, so it
works identically on Ollama, LM Studio, OpenRouter, NVIDIA NIM, or anything
else. Follow it every single turn, no exceptions.

### Step 1 — always think first, out loud, visibly

Before calling a tool or answering, write a ```thinking block. This is not
optional and not just for hard questions — the human operator watches this
stream to see your reasoning, so it should be genuine and specific, not a
one-line formality. Use it to:

- State what you already know and what's still unverified.
- Name which independent sources you intend to check or cross-check next,
  and why those specifically.
- Once you have results from more than one source, explicitly compare them:
  do they agree, partially agree, or conflict? A claim seen in only one
  place is NOT the same confidence level as one confirmed independently in
  two or more places — say so plainly rather than quietly treating both the
  same way.
- Apply the source-reliability / information-credibility grading and the
  other analytic-tradecraft principles described in the skill's
  `analytic-tradecraft` reference if it's loaded — grade sources, don't just
  collect them.
- Actively look for evidence that would contradict your current working
  conclusion, not just evidence that supports it.

```thinking
<your actual reasoning, a few sentences to a short paragraph>
```

### Step 2 — then act

Immediately after the thinking block, either:

a) Call a tool:
```tool
{"name": "<tool_name>", "arguments": {"<arg>": "<value>"}}
```
You'll get a message starting with "TOOL RESULT:" with the JSON result.
Only one tool call per turn. Never invent a tool result — wait for the real one.

b) Or, once you have enough cross-checked information, give your final
answer as plain text/Markdown after the thinking block, with no ```tool
block. State your confidence and which parts rest on how much corroboration.

### Available tools
{tool_list}
"""


def _tool_list_block(registry: dict) -> str:
    lines = []
    # Handle both dict and ToolRegistry objects
    if hasattr(registry, 'tools'):
        # ToolRegistry object
        for tool in registry.list():
            lines.append(f"- **{tool.name}**: {tool.description}")
    else:
        # Dictionary
        for name, spec in registry.items():
            lines.append(f"- **{name}**: {spec['description']}")
    return "\n".join(lines)


def _load_single_skill(skill_dir: Path) -> str:
    """Load SKILL.md and all reference files from one skill folder."""
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        raise FileNotFoundError(f"No SKILL.md found in {skill_dir}")

    parts = [skill_md.read_text(encoding="utf-8")]

    refs_dir = skill_dir / "references"
    if refs_dir.exists():
        for ref_file in sorted(refs_dir.glob("*.md")):
            parts.append(f"\n\n---\n# Reference: {ref_file.name}\n\n{ref_file.read_text(encoding='utf-8')}")

    return "\n".join(parts)


def load_skill(skill_dir: Path, registry: dict | None = None) -> str:
    """Load a single skill, with the tool protocol appended."""
    return load_skills([skill_dir], registry=registry)


def load_skills(skill_dirs: list[Path], registry: dict | None = None) -> str:
    """Load one or more skill folders and concatenate them into one system prompt,
    with the shared tool protocol appended once at the end. Order matters if skills
    give conflicting instructions — later ones are listed after earlier ones, so
    mention precedence in a skill's own text if you need to be explicit about it."""
    if not skill_dirs:
        raise ValueError("At least one skill directory is required.")

    registry = registry if registry is not None else DEFAULT_TOOLS

    sections = []
    for i, skill_dir in enumerate(skill_dirs):
        header = f"\n\n{'=' * 60}\n# SKILL {i + 1}/{len(skill_dirs)}: {skill_dir.name}\n{'=' * 60}\n"
        sections.append(header + _load_single_skill(skill_dir))

    sections.append(TOOL_PROTOCOL.replace("{tool_list}", _tool_list_block(registry)))
    return "\n".join(sections)
