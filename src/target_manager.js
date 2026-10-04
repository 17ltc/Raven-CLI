'use strict';
/**
 * Investigation target manager used internally by the tool registry.
 * Port of Raven/target_manager/target_manager.py
 *
 * NOTE: distinct from src/core/targets.js (core/targets.py), which backs the
 * /target CLI command family. Both exist in the original project.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const chalk = require('chalk');

function slugify(name) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^[-_]+|[-_]+$/g, '').slice(0, 80);
  if (!slug) throw new Error('Target name must contain letters or numbers');
  return slug;
}

class TargetManager {
  constructor(basePath = null, log = null) {
    this.basePath = basePath || path.join(process.cwd(), 'targets');
    this.log = log || ((msg) => console.log(msg));
  }

  _targetPath(targetName) {
    const root = path.resolve(this.basePath);
    const target = path.resolve(root, slugify(targetName));
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Invalid target path');
    return target;
  }

  createTarget(name, initialIdentifiers = {}) {
    fs.mkdirSync(this.basePath, { recursive: true });
    const targetPath = this._targetPath(name);
    if (fs.existsSync(targetPath)) {
      throw new Error(`Target '${name}' already exists at ${targetPath}`);
    }
    fs.mkdirSync(targetPath, { recursive: true });
    fs.mkdirSync(path.join(targetPath, 'research'), { recursive: true });
    fs.mkdirSync(path.join(targetPath, 'evidence'), { recursive: true });
    fs.mkdirSync(path.join(targetPath, 'reports'), { recursive: true });

    const now = new Date().toISOString();
    const targetInfo = {
      name,
      created_at: now,
      last_updated: now,
      identifiers: initialIdentifiers || {},
      notes: '',
      related_targets: [],
      metadata: {},
    };
    this._saveTargetInfo(targetPath, targetInfo);
    this.log(`${chalk.green('+')} Target '${name}' created at ${targetPath}`);
    return targetInfo;
  }

  getTarget(name) {
    const targetPath = this._targetPath(name);
    if (!fs.existsSync(targetPath)) return null;
    return this._loadTargetInfo(targetPath);
  }

  addIdentifier(targetName, identifierType, value) {
    const targetInfo = this.getTarget(targetName);
    if (!targetInfo) throw new Error(`Target '${targetName}' not found`);

    if (!targetInfo.identifiers[identifierType]) targetInfo.identifiers[identifierType] = [];
    if (!targetInfo.identifiers[identifierType].includes(value)) {
      targetInfo.identifiers[identifierType].push(value);
      targetInfo.last_updated = new Date().toISOString();
      this._saveTargetInfo(this._targetPath(targetName), targetInfo);
      this.log(`${chalk.green('+')} Added ${identifierType}: ${value} to target '${targetName}'`);
    }
    return targetInfo;
  }

  addNote(targetName, note) {
    const targetInfo = this.getTarget(targetName);
    if (!targetInfo) throw new Error(`Target '${targetName}' not found`);

    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    targetInfo.notes += `\n[${stamp}] ${note}`;
    targetInfo.last_updated = new Date().toISOString();
    this._saveTargetInfo(this._targetPath(targetName), targetInfo);
    this.log(`${chalk.green('+')} Note added to target '${targetName}'`);
    return targetInfo;
  }

  saveResearch(targetName, researchType, content, filename = null) {
    const targetInfo = this.getTarget(targetName);
    if (!targetInfo) throw new Error(`Target '${targetName}' not found`);

    const targetPath = this._targetPath(targetName);
    const researchPath = path.join(targetPath, 'research');

    if (!filename) {
      const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
      filename = `${researchType}_${ts}.md`;
    }

    const filePath = path.join(researchPath, filename);
    fs.writeFileSync(filePath, content, 'utf8');

    targetInfo.last_updated = new Date().toISOString();
    this._saveTargetInfo(targetPath, targetInfo);
    this.log(`${chalk.green('done')} Research saved to ${filePath}`);
    return filePath;
  }

  autoAssociateIdentifier(identifier, identifierType = 'email') {
    const existing = this.findTargetByIdentifier(identifierType, identifier);
    if (existing) return existing.name;

    if (identifierType === 'email' && identifier.includes('@')) {
      const potentialName = identifier
        .split('@')[0]
        .replace(/\./g, ' ')
        .replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
      try {
        const newTarget = this.createTarget(potentialName, { [identifierType]: [identifier] });
        return newTarget.name;
      } catch (e) {
        for (let i = 2; i < 10; i++) {
          try {
            const newTarget = this.createTarget(`${potentialName}_${i}`, { [identifierType]: [identifier] });
            return newTarget.name;
          } catch (e2) {
            continue;
          }
        }
      }
    }
    return null;
  }

  linkTargets(targetName1, targetName2, relation = 'related') {
    const target1 = this.getTarget(targetName1);
    const target2 = this.getTarget(targetName2);
    if (!target1 || !target2) {
      const missing = [
        [targetName1, target1],
        [targetName2, target2],
      ]
        .filter(([, t]) => !t)
        .map(([n]) => n);
      throw new Error(`Targets not found: ${missing.join(', ')}`);
    }

    if (!target1.related_targets.includes(targetName2)) {
      target1.related_targets.push(targetName2);
      target1.last_updated = new Date().toISOString();
      this._saveTargetInfo(this._targetPath(targetName1), target1);
    }
    if (!target2.related_targets.includes(targetName1)) {
      target2.related_targets.push(targetName1);
      target2.last_updated = new Date().toISOString();
      this._saveTargetInfo(this._targetPath(targetName2), target2);
    }
    this.log(`${chalk.green('+')} Linked '${targetName1}' and '${targetName2}' as ${relation}`);
  }

  findTargetByIdentifier(identifierType, value) {
    if (!fs.existsSync(this.basePath)) return null;
    for (const entry of fs.readdirSync(this.basePath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const info = this._loadTargetInfo(path.join(this.basePath, entry.name));
      if (info && info.identifiers[identifierType] && info.identifiers[identifierType].includes(value)) {
        return info;
      }
    }
    return null;
  }

  listTargets() {
    const targets = [];
    if (!fs.existsSync(this.basePath)) return targets;
    for (const entry of fs.readdirSync(this.basePath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const info = this._loadTargetInfo(path.join(this.basePath, entry.name));
      if (info) targets.push(info);
    }
    return targets;
  }

  getTargetSummary(targetName) {
    const targetInfo = this.getTarget(targetName);
    if (!targetInfo) return chalk.red(`Target '${targetName}' not found`);

    let summary = `${chalk.bold.cyan(`Target: ${targetInfo.name}`)}\n`;
    summary += `${chalk.dim(`Created: ${targetInfo.created_at}`)}\n`;
    summary += `${chalk.dim(`Last updated: ${targetInfo.last_updated}`)}\n\n`;

    if (Object.keys(targetInfo.identifiers).length) {
      summary += `${chalk.bold('Identifiers:')}\n`;
      for (const [idType, values] of Object.entries(targetInfo.identifiers)) {
        summary += `  ${idType}: ${values.join(', ')}\n`;
      }
      summary += '\n';
    }

    if (targetInfo.related_targets.length) {
      summary += `${chalk.bold('Related targets:')} ${targetInfo.related_targets.join(', ')}\n\n`;
    }

    if (targetInfo.notes) {
      summary += `${chalk.bold('Notes:')}\n`;
      summary += `${targetInfo.notes}\n`;
    }

    return summary;
  }

  _loadTargetInfo(targetPath) {
    const infoFile = path.join(targetPath, 'target_info.yaml');
    if (!fs.existsSync(infoFile)) return null;
    try {
      const data = yaml.load(fs.readFileSync(infoFile, 'utf8'));
      return {
        name: data.name,
        created_at: data.created_at,
        last_updated: data.last_updated,
        identifiers: data.identifiers || {},
        notes: data.notes || '',
        related_targets: data.related_targets || [],
        metadata: data.metadata || {},
      };
    } catch (e) {
      this.log(chalk.red(`Error loading target info from ${targetPath}: ${e.message}`));
      return null;
    }
  }

  _saveTargetInfo(targetPath, targetInfo) {
    const infoFile = path.join(targetPath, 'target_info.yaml');
    fs.writeFileSync(infoFile, yaml.dump(targetInfo));
  }
}

module.exports = { TargetManager };
