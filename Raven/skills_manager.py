from __future__ import annotations

import re
import shutil
from dataclasses import dataclass
from pathlib import Path

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)

SKILL_TEMPLATE = """---
name: {name}
description: {description}
---

# {title}

## Scope and ground rules

Describe what this skill covers, and just as importantly, what it explicitly
does NOT cover. Be concrete about any ethical/legal boundaries relevant to
this domain (authorization requirements, privacy limits, etc.) — this section
is what keeps the agent from drifting into things it shouldn't do.

## Workflow

1. Step one...
2. Step two...

## Reference material

Put longer reference tables, source lists, or templates in `references/*.md`
— they get auto-loaded alongside this file.
"""


@dataclass
class SkillInfo:
    name: str
    description: str
    path: Path


def _parse_frontmatter(skill_md_text: str) -> dict:
    match = FRONTMATTER_RE.match(skill_md_text)
    if not match:
        return {}
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            fields[key.strip()] = value.strip()
    return fields


def list_skills(skills_root: Path) -> list[SkillInfo]:
    """Discover all skills under skills_root (each is a subfolder with a SKILL.md)."""
    if not skills_root.exists():
        return []
    out = []
    for entry in sorted(skills_root.iterdir()):
        skill_md = entry / "SKILL.md"
        if entry.is_dir() and skill_md.exists():
            fm = _parse_frontmatter(skill_md.read_text(encoding="utf-8"))
            out.append(SkillInfo(
                name=fm.get("name", entry.name),
                description=fm.get("description", "(no description)"),
                path=entry,
            ))
    return out


def find_skill(skills_root: Path, name: str) -> SkillInfo | None:
    for info in list_skills(skills_root):
        if info.name == name or info.path.name == name:
            return info
    return None


def validate_skill(skill_dir: Path) -> list[str]:
    """Return a list of problems (empty list = valid)."""
    problems = []
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        return [f"No SKILL.md in {skill_dir}"]
    fm = _parse_frontmatter(skill_md.read_text(encoding="utf-8"))
    if "name" not in fm:
        problems.append("Missing 'name' in frontmatter")
    if "description" not in fm:
        problems.append("Missing 'description' in frontmatter")
    elif len(fm["description"]) < 20:
        problems.append("'description' is too short to be useful for triggering — describe when to use this skill")
    return problems


def create_skill(skills_root: Path, name: str, description: str) -> Path:
    skills_root.mkdir(parents=True, exist_ok=True)
    skill_dir = skills_root / name
    if skill_dir.exists():
        raise FileExistsError(f"Skill '{name}' already exists at {skill_dir}")
    (skill_dir / "references").mkdir(parents=True)
    title = name.replace("-", " ").replace("_", " ").title()
    content = SKILL_TEMPLATE.format(name=name, description=description, title=title)
    (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")
    return skill_dir


def delete_skill(skills_root: Path, name: str) -> None:
    info = find_skill(skills_root, name)
    if not info:
        raise FileNotFoundError(f"No skill named '{name}' in {skills_root}")
    shutil.rmtree(info.path)


def duplicate_skill(skills_root: Path, source_name: str, new_name: str) -> Path:
    """Handy for forking the bundled skill into a custom variant before editing it."""
    info = find_skill(skills_root, source_name)
    if not info:
        raise FileNotFoundError(f"No skill named '{source_name}' in {skills_root}")
    dest = skills_root / new_name
    if dest.exists():
        raise FileExistsError(f"Skill '{new_name}' already exists at {dest}")
    shutil.copytree(info.path, dest)
    return dest
