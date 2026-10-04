'use strict';
/**
 * Port of Raven/db_tools.py
 *
 * The read_only guard below is a defense-in-depth measure, not a substitute
 * for using a real read-only DB user/role. Treat it as a safety net against
 * accidental or careless writes from a model, not as airtight sandboxing
 * against a determined adversarial prompt - for that, restrict the DB
 * credentials themselves.
 *
 * NOTE: the Python original uses SQLAlchemy's create_engine() which supports
 * dozens of DB backends generically through URL dialects. Node has no single
 * equivalent, so this port dispatches explicitly by URL scheme: `sqlite:///`
 * via the optional `better-sqlite3` package, `postgres(ql)://` via the
 * optional `pg` package, and `mysql://` via the optional `mysql2` package.
 * Anything else returns a clear "driver not installed/supported" error,
 * mirroring the Python ImportError branch.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Searches ANYWHERE in the (comment-stripped) statement, not just at the
// start - see the Python module docstring for the exploit this closes.
const WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|GRANT|REVOKE|MERGE|EXEC|EXECUTE|CALL|ATTACH|DETACH|PRAGMA)\b/i;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /--[^\n]*/g;

const PUBLIC_DB_METADATA = {
  threat_intel: {
    name: 'Global Threat Intelligence Database',
    description: 'Public threat intelligence feed aggregating data from multiple security vendors and research organizations',
    source: 'Aggregated from public CTI sources',
    update_frequency: 'Real-time',
    data_types: ['IOCs', 'threat_actors', 'campaigns', 'malware_signatures'],
    access_pattern: 'chunked_pagination',
    estimated_size: 'Large database with millions of entries',
  },
  breach_data: {
    name: 'Public Breach Database',
    description: 'Aggregated breach exposure data from public breach notification sources and security research',
    source: 'Public breach databases and security research',
    update_frequency: 'Daily',
    data_types: ['breached_emails', 'exposed_credentials', 'breach_metadata'],
    access_pattern: 'streaming_chunked',
    estimated_size: 'Multi-gigabyte breach database',
  },
  security_research: {
    name: 'Security Research Database',
    description: 'Public security research findings and vulnerability disclosures from research organizations',
    source: 'Public security research and vulnerability databases',
    update_frequency: 'Weekly',
    data_types: ['vulnerabilities', 'exploits', 'security_papers', 'research_findings'],
    access_pattern: 'indexed_search',
    estimated_size: 'Large research corpus',
  },
  network_intel: {
    name: 'Network Intelligence Database',
    description: 'Public network infrastructure data and security-related network information',
    source: 'Public network intelligence sources',
    update_frequency: 'Real-time',
    data_types: ['ip_reputation', 'domain_info', 'network_infrastructure', 'asn_data'],
    access_pattern: 'range_based',
    estimated_size: 'Massive network dataset',
  },
};

const CHUNK_CONFIG = {
  default_chunk_size: 1000,
  max_memory_mb: 512,
  stream_threshold_mb: 100,
  sql_batch_size: 500,
  json_chunk_size: 10000,
  csv_chunk_size: 5000,
};

function stripComments(sql) {
  return sql.replace(BLOCK_COMMENT_RE, ' ').replace(LINE_COMMENT_RE, ' ');
}

/** Rough count of semicolon-separated statements - see WRITE_KEYWORDS comment above. */
function statementCount(sql) {
  return sql.split(';').filter((p) => p.trim()).length;
}

function containsWrite(sql) {
  return WRITE_KEYWORDS.test(stripComments(sql));
}

/** Minimal CSV line parser supporting quoted fields (mirrors Python's csv.DictReader closely enough for search). */
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

class DatabaseTools {
  constructor(databasesConfig) {
    this.configs = databasesConfig || {};
    this._engines = {};
  }

  _engine(name) {
    if (!this._engines[name]) {
      const url = this.configs[name].url;
      if (url.startsWith('sqlite:///')) {
        let BetterSqlite3;
        try {
          BetterSqlite3 = require('better-sqlite3');
        } catch (e) {
          throw new Error("Database driver not installed. Run `npm install better-sqlite3` for SQLite support.");
        }
        const filePath = url.replace('sqlite:///', '');
        this._engines[name] = { kind: 'sqlite', db: new BetterSqlite3(filePath) };
      } else if (/^postgres(ql)?:\/\//.test(url)) {
        let pg;
        try {
          pg = require('pg');
        } catch (e) {
          throw new Error('Database driver not installed. Run `npm install pg` for PostgreSQL support.');
        }
        this._engines[name] = { kind: 'pg', pool: new pg.Pool({ connectionString: url }) };
      } else if (/^mysql:\/\//.test(url)) {
        let mysql;
        try {
          mysql = require('mysql2/promise');
        } catch (e) {
          throw new Error('Database driver not installed. Run `npm install mysql2` for MySQL support.');
        }
        this._engines[name] = { kind: 'mysql', pool: mysql.createPool(url) };
      } else {
        throw new Error(`Unsupported database URL scheme for '${name}': ${url}`);
      }
    }
    return this._engines[name];
  }

  listDatabases() {
    const databases = [];
    for (const [k, v] of Object.entries(this.configs)) {
      const metadata = PUBLIC_DB_METADATA[k] || {
        name: k,
        description: 'Public security database',
        source: 'Public security sources',
        update_frequency: 'Real-time',
        data_types: ['general_security_data'],
      };
      databases.push({
        name: metadata.name,
        internal_id: k,
        description: metadata.description,
        source: metadata.source,
        update_frequency: metadata.update_frequency,
        data_types: metadata.data_types,
        read_only: v.read_only !== undefined ? v.read_only : true,
        access_type: 'public_query_access',
      });
    }
    return { databases, access_info: 'These are public security databases available for research and investigation purposes' };
  }

  async dbQuery(connection, sql, maxRows = 200) {
    const internalConnection = this._mapPublicToInternal(connection);
    const cfg = this.configs[internalConnection];
    if (!cfg) {
      const availablePublic = Object.keys(this.configs).map((k) => (PUBLIC_DB_METADATA[k] || {}).name || k);
      return {
        error: `Database '${connection}' not found in public security databases. Available: ${availablePublic}`,
        available_databases: availablePublic,
      };
    }

    const readOnly = cfg.read_only !== undefined ? cfg.read_only : true;
    if (readOnly) {
      if (statementCount(sql) > 1) {
        return {
          error:
            `Public database '${connection}' allows read-only queries \u2014 refusing a ` +
            "multi-statement query (contains more than one ';'-separated statement). Run one statement at a time.",
        };
      }
      if (containsWrite(sql)) {
        return {
          error:
            `Public database '${connection}' is read-only \u2014 write operations are not permitted. ` +
            'These databases are for research and investigation purposes only.',
        };
      }
    }

    const dbUrl = cfg.url || '';
    if (dbUrl.startsWith('sqlite:///')) {
      const filePath = dbUrl.replace('sqlite:///', '');
      const fileType = this._detectFileType(filePath);
      const fileSizeMb = this._getFileSizeMb(filePath);
      if (fileSizeMb > CHUNK_CONFIG.stream_threshold_mb) {
        if (fileType === 'json') return this._chunkedJsonSearch(filePath, sql, maxRows);
        if (fileType === 'csv') return this._chunkedCsvSearch(filePath, sql, maxRows);
        if (fileType === 'txt') return this._chunkedTxtSearch(filePath, sql, maxRows);
      }
    }

    try {
      let result;
      if (this._isLargeQuery(sql)) {
        result = await this._chunkedSqlQuery(internalConnection, sql, maxRows);
      } else {
        result = await this._runQuery(internalConnection, sql, maxRows);
      }

      const metadata = PUBLIC_DB_METADATA[internalConnection] || {};
      Object.assign(result, {
        source: metadata.source || 'Public security database',
        database_name: metadata.name || connection,
        query_type: 'public_research_query',
        database_type: 'public_security_database',
      });
      return result;
    } catch (e) {
      return {
        error: `Public database query error: ${e.message}`,
        error_type: 'public_database_access_error',
        suggestion: 'This may be due to temporary public database availability or query format issues',
      };
    }
  }

  async _runQuery(internalConnection, sql, maxRows) {
    const engine = this._engine(internalConnection);
    if (engine.kind === 'sqlite') {
      const stmt = engine.db.prepare(sql);
      if (stmt.reader) {
        const rows = stmt.all().slice(0, maxRows);
        return { rows, row_count_returned: rows.length, access_method: 'standard_query' };
      }
      const info = stmt.run();
      return { status: 'executed', rowcount: info.changes, access_method: 'standard_query' };
    }
    if (engine.kind === 'pg') {
      const res = await engine.pool.query(sql);
      if (res.rows) {
        const rows = res.rows.slice(0, maxRows);
        return { rows, row_count_returned: rows.length, access_method: 'standard_query' };
      }
      return { status: 'executed', rowcount: res.rowCount, access_method: 'standard_query' };
    }
    if (engine.kind === 'mysql') {
      const [rows] = await engine.pool.query(sql);
      if (Array.isArray(rows)) {
        const sliced = rows.slice(0, maxRows);
        return { rows: sliced, row_count_returned: sliced.length, access_method: 'standard_query' };
      }
      return { status: 'executed', rowcount: rows.affectedRows, access_method: 'standard_query' };
    }
    throw new Error('Unknown engine kind');
  }

  async _chunkedSqlQuery(connection, sql, maxRows = 200) {
    try {
      const batchSize = CHUNK_CONFIG.sql_batch_size;
      let allResults = [];
      let offset = 0;
      while (allResults.length < maxRows) {
        const chunkedSql = `${sql} LIMIT ${batchSize} OFFSET ${offset}`;
        const chunk = await this._runQuery(connection, chunkedSql, batchSize);
        const rows = chunk.rows || [];
        if (!rows.length) break;
        allResults = allResults.concat(rows);
        offset += batchSize;
        if (rows.length < batchSize) break;
      }
      return {
        rows: allResults.slice(0, maxRows),
        row_count_returned: allResults.length,
        access_method: 'chunked_sql_pagination',
        chunks_processed: Math.floor(offset / batchSize) + 1,
      };
    } catch (e) {
      return { error: `SQL chunked query error: ${e.message}` };
    }
  }

  _isLargeQuery(sql) {
    const upper = sql.toUpperCase();
    if (!upper.includes('LIMIT') && !upper.includes('WHERE')) return true;
    const largeTableKeywords = ['breach', 'threat', 'network', 'intelligence', 'research'];
    return largeTableKeywords.some((k) => upper.includes(k.toUpperCase()));
  }

  _mapPublicToInternal(publicName) {
    if (this.configs[publicName]) return publicName;
    for (const [internalId, metadata] of Object.entries(PUBLIC_DB_METADATA)) {
      if (metadata.name === publicName || internalId === publicName) return internalId;
    }
    return publicName;
  }

  _detectFileType(filePath) {
    if (filePath.endsWith('.json') || filePath.endsWith('.jsonl')) return 'json';
    if (filePath.endsWith('.csv')) return 'csv';
    if (filePath.endsWith('.txt')) return 'txt';
    if (filePath.endsWith('.sql')) return 'sql';
    return 'unknown';
  }

  _getFileSizeMb(filePath) {
    try {
      return fs.statSync(filePath).size / (1024 * 1024);
    } catch (e) {
      return 0;
    }
  }

  async _chunkedJsonSearch(filePath, searchQuery, maxResults = 100) {
    try {
      const results = [];
      if (filePath.endsWith('.jsonl') || this._getFileSizeMb(filePath) > CHUNK_CONFIG.stream_threshold_mb) {
        const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }) });
        for await (const line of rl) {
          if (results.length >= maxResults) break;
          try {
            const record = JSON.parse(line);
            if (this._matchesSearchQuery(record, searchQuery)) results.push(record);
          } catch (e) {
            continue;
          }
        }
      } else {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (Array.isArray(data)) {
          for (const record of data) {
            if (results.length >= maxResults) break;
            if (this._matchesSearchQuery(record, searchQuery)) results.push(record);
          }
        }
      }
      return {
        rows: results.slice(0, maxResults),
        row_count_returned: results.length,
        search_query: searchQuery,
        access_method: 'chunked_json_streaming',
        chunks_processed: 'multiple',
      };
    } catch (e) {
      return { error: `JSON chunked search error: ${e.message}` };
    }
  }

  _chunkedCsvSearch(filePath, searchQuery, maxResults = 100) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split(/\r?\n/).filter((l, i, arr) => !(i === arr.length - 1 && l === ''));
      if (!lines.length) return { rows: [], row_count_returned: 0, search_query: searchQuery, access_method: 'chunked_csv_streaming', headers: [] };
      const headers = parseCsvLine(lines[0]);
      const results = [];
      for (let i = 1; i < lines.length; i++) {
        if (results.length >= maxResults) break;
        const fields = parseCsvLine(lines[i]);
        const row = {};
        headers.forEach((h, idx) => { row[h] = fields[idx]; });
        if (this._matchesSearchQuery(row, searchQuery)) results.push(row);
      }
      return {
        rows: results.slice(0, maxResults),
        row_count_returned: results.length,
        search_query: searchQuery,
        access_method: 'chunked_csv_streaming',
        headers,
      };
    } catch (e) {
      return { error: `CSV chunked search error: ${e.message}` };
    }
  }

  async _chunkedTxtSearch(filePath, searchQuery, maxResults = 100) {
    try {
      const results = [];
      const chunkSize = 1024 * 1024;
      const fd = fs.openSync(filePath, 'r');
      let chunkNumber = 0;
      let leftover = '';
      try {
        while (results.length < maxResults) {
          const buf = Buffer.alloc(chunkSize);
          const bytesRead = fs.readSync(fd, buf, 0, chunkSize, null);
          if (bytesRead === 0) break;
          chunkNumber += 1;
          const text = leftover + buf.toString('utf8', 0, bytesRead);
          const lines = text.split('\n');
          leftover = lines.pop();
          for (const line of lines) {
            if (results.length >= maxResults) break;
            if (line.toLowerCase().includes(searchQuery.toLowerCase())) {
              results.push({ line_content: line.trim(), chunk_number: chunkNumber, match_type: 'text_pattern' });
            }
          }
        }
        if (results.length < maxResults && leftover && leftover.toLowerCase().includes(searchQuery.toLowerCase())) {
          results.push({ line_content: leftover.trim(), chunk_number: chunkNumber, match_type: 'text_pattern' });
        }
      } finally {
        fs.closeSync(fd);
      }
      return {
        rows: results.slice(0, maxResults),
        row_count_returned: results.length,
        search_query: searchQuery,
        access_method: 'chunked_text_streaming',
        chunks_processed: chunkNumber,
      };
    } catch (e) {
      return { error: `TXT chunked search error: ${e.message}` };
    }
  }

  _matchesSearchQuery(record, searchQuery) {
    const searchLower = searchQuery.toLowerCase();
    if (record && typeof record === 'object' && !Array.isArray(record)) {
      for (const value of Object.values(record)) {
        if (typeof value === 'string' && value.toLowerCase().includes(searchLower)) return true;
        if (typeof value === 'number' && String(value).includes(searchQuery)) return true;
      }
    } else if (typeof record === 'string') {
      return record.toLowerCase().includes(searchLower);
    }
    return false;
  }
}

module.exports = { DatabaseTools, PUBLIC_DB_METADATA, CHUNK_CONFIG, path };
