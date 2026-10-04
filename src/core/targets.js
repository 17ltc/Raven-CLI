'use strict';
/**
 * Core Targets Module
 * Port of Raven/core/targets.py
 *
 * NOTE: this is the "investigation target" manager exposed via raven.core
 * (used by the /target CLI command family). There is a second, distinct
 * TargetManager used internally by the tool registry - see
 * src/target_manager.js (port of Raven/target_manager/target_manager.py).
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

class TargetManager {
  constructor(basePath = null) {
    this.basePath = basePath || path.join(process.cwd(), 'targets');
    fs.mkdirSync(this.basePath, { recursive: true });
    this._targets = new Map();
    this._loadAll();
  }

  _targetPath(name) {
    return path.join(this.basePath, name);
  }

  _targetInfoPath(name) {
    return path.join(this._targetPath(name), 'target_info.yaml');
  }

  create(name) {
    const targetPath = this._targetPath(name);
    fs.mkdirSync(targetPath, { recursive: true });
    fs.mkdirSync(path.join(targetPath, 'research'), { recursive: true });
    fs.mkdirSync(path.join(targetPath, 'evidence'), { recursive: true });
    fs.mkdirSync(path.join(targetPath, 'reports'), { recursive: true });

    const target = {
      name,
      identifiers: [],
      created_at: new Date().toISOString(),
      notes: [],
      research: [],
      links: [],
    };
    this._targets.set(name, target);
    this._saveTarget(target);
    return target;
  }

  get(name) {
    return this._targets.get(name) || null;
  }

  list() {
    return Array.from(this._targets.values());
  }

  delete(name) {
    if (!this._targets.has(name)) return false;
    fs.rmSync(this._targetPath(name), { recursive: true, force: true });
    this._targets.delete(name);
    return true;
  }

  addIdentifier(name, identifierType, value, source = 'manual') {
    const target = this.get(name);
    if (!target) return false;
    target.identifiers.push({ type: identifierType, value, source, added_at: new Date().toISOString() });
    this._saveTarget(target);
    return true;
  }

  addNote(name, note) {
    const target = this.get(name);
    if (!target) return false;
    target.notes.push(note);
    this._saveTarget(target);
    return true;
  }

  addResearch(name, researchData) {
    const target = this.get(name);
    if (!target) return false;
    researchData.timestamp = new Date().toISOString();
    target.research.push(researchData);
    this._saveTarget(target);
    return true;
  }

  link(name1, name2, relation = 'related') {
    const t1 = this.get(name1);
    const t2 = this.get(name2);
    if (!t1 || !t2) return false;
    if (!t1.links.includes(name2)) t1.links.push(name2);
    if (!t2.links.includes(name1)) t2.links.push(name1);
    this._saveTarget(t1);
    this._saveTarget(t2);
    return true;
  }

  findByIdentifier(identifierType, value) {
    for (const target of this._targets.values()) {
      for (const identifier of target.identifiers) {
        if (identifier.type === identifierType && identifier.value === value) return target;
      }
    }
    return null;
  }

  _saveTarget(target) {
    const infoPath = this._targetInfoPath(target.name);
    const dict = {
      name: target.name,
      created_at: target.created_at,
      identifiers: target.identifiers,
      notes: target.notes,
      research: target.research,
      links: target.links,
    };
    fs.writeFileSync(infoPath, yaml.dump(dict));
  }

  _loadAll() {
    if (!fs.existsSync(this.basePath)) return;
    for (const entry of fs.readdirSync(this.basePath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const infoPath = path.join(this.basePath, entry.name, 'target_info.yaml');
      if (!fs.existsSync(infoPath)) continue;
      const data = yaml.load(fs.readFileSync(infoPath, 'utf8')) || {};
      const identifiers = [];
      for (const idData of data.identifiers || []) {
        if (typeof idData === 'string') {
          identifiers.push({ type: 'email', value: idData, source: 'manual', added_at: new Date().toISOString() });
        } else if (idData && typeof idData === 'object') {
          identifiers.push(idData);
        }
      }
      const target = {
        name: data.name,
        identifiers,
        created_at: data.created_at,
        notes: data.notes || [],
        research: data.research || [],
        links: data.links || [],
      };
      this._targets.set(target.name, target);
    }
  }
}

module.exports = { TargetManager };
