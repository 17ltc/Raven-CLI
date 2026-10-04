'use strict';
/** Port of Raven/skills_manager.py */

const fs = require('fs');
const path = require('path');

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/;

const SKILL_TEMPLATE = `---
name: {name}
description: {description}
---

# {title}

## Scope and ground rules

Describe what this skill covers, and just as importantly, what it explicitly
does NOT cover. Be concrete about any ethical/legal boundaries relevant to
this domain (authorization requirements, privacy limits, etc.) - this section
is what keeps the agent from drifting into things it shouldn't do.

## Workflow

1. Step one...
2. Step two...

## Reference material

Put longer reference tables, source lists, or templates in \`references/*.md\`
- they get auto-loaded alongside this file.
`;

function parseFrontmatter(skillMdText) {
  const match = FRONTMATTER_RE.exec(skillMdText);
  if (!match) return {};
  const fields = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx !== -1) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      fields[key] = value;
    }
  }
  return fields;
}

/** Discover all skills under skillsRoot (each is a subfolder with a SKILL.md). */
function listSkills(skillsRoot) {
  if (!fs.existsSync(skillsRoot)) return [];
  const out = [];
  const entries = fs.readdirSync(skillsRoot).sort();
  for (const entryName of entries) {
    const entryPath = path.join(skillsRoot, entryName);
    const skillMd = path.join(entryPath, 'SKILL.md');
    if (fs.statSync(entryPath).isDirectory() && fs.existsSync(skillMd)) {
      const fm = parseFrontmatter(fs.readFileSync(skillMd, 'utf8'));
      out.push({ name: fm.name || entryName, description: fm.description || '(no description)', path: entryPath });
    }
  }
  return out;
}

function findSkill(skillsRoot, name) {
  for (const info of listSkills(skillsRoot)) {
    if (info.name === name || path.basename(info.path) === name) return info;
  }
  return null;
}

/** Return a list of problems (empty list = valid). */
function validateSkill(skillDir) {
  const problems = [];
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) return [`No SKILL.md in ${skillDir}`];
  const fm = parseFrontmatter(fs.readFileSync(skillMd, 'utf8'));
  if (!('name' in fm)) problems.push("Missing 'name' in frontmatter");
  if (!('description' in fm)) {
    problems.push("Missing 'description' in frontmatter");
  } else if (fm.description.length < 20) {
    problems.push("'description' is too short to be useful for triggering - describe when to use this skill");
  }
  return problems;
}

function toTitleCase(s) {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function createSkill(skillsRoot, name, description) {
  fs.mkdirSync(skillsRoot, { recursive: true });
  const skillDir = path.join(skillsRoot, name);
  if (fs.existsSync(skillDir)) {
    throw new Error(`Skill '${name}' already exists at ${skillDir}`);
  }
  fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
  const title = toTitleCase(name.replace(/-/g, ' ').replace(/_/g, ' '));
  const content = SKILL_TEMPLATE.replace('{name}', name).replace('{description}', description).replace('{title}', title);
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf8');
  return skillDir;
}

function deleteSkill(skillsRoot, name) {
  const info = findSkill(skillsRoot, name);
  if (!info) throw new Error(`No skill named '${name}' in ${skillsRoot}`);
  fs.rmSync(info.path, { recursive: true, force: true });
}

/** Handy for forking the bundled skill into a custom variant before editing it. */
function duplicateSkill(skillsRoot, sourceName, newName) {
  const info = findSkill(skillsRoot, sourceName);
  if (!info) throw new Error(`No skill named '${sourceName}' in ${skillsRoot}`);
  const dest = path.join(skillsRoot, newName);
  if (fs.existsSync(dest)) throw new Error(`Skill '${newName}' already exists at ${dest}`);
  fs.cpSync(info.path, dest, { recursive: true });
  return dest;
}

module.exports = { listSkills, findSkill, validateSkill, createSkill, deleteSkill, duplicateSkill, parseFrontmatter };
