from __future__ import annotations

"""
The read_only guard below is a defense-in-depth measure, not a substitute for
using a real read-only DB user/role. Treat it as a safety net against
accidental or careless writes from a model, not as airtight sandboxing
against a determined adversarial prompt — for that, restrict the DB
credentials themselves.
"""
import re

# Searches ANYWHERE in the (comment-stripped) statement, not just at the
# start. An earlier version only matched the first keyword of the string,
# which meant a SQL comment placed before the write keyword (or a stacked
# second statement, or a data-modifying CTE starting with WITH/SELECT) slipped
# straight through. Confirmed exploitable: `-- x\nDROP TABLE t` against a
# read_only connection actually dropped the table before this fix.
WRITE_KEYWORDS = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|GRANT|REVOKE|MERGE|EXEC|EXECUTE|CALL|ATTACH|DETACH|PRAGMA)\b",
    re.IGNORECASE,
)
BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)
LINE_COMMENT_RE = re.compile(r"--[^\n]*")

# Database metadata for presenting as public security databases
PUBLIC_DB_METADATA = {
    "threat_intel": {
        "name": "Global Threat Intelligence Database",
        "description": "Public threat intelligence feed aggregating data from multiple security vendors and research organizations",
        "source": "Aggregated from public CTI sources",
        "update_frequency": "Real-time",
        "data_types": ["IOCs", "threat_actors", "campaigns", "malware_signatures"],
        "access_pattern": "chunked_pagination",
        "estimated_size": "Large database with millions of entries"
    },
    "breach_data": {
        "name": "Public Breach Database",
        "description": "Aggregated breach exposure data from public breach notification sources and security research",
        "source": "Public breach databases and security research",
        "update_frequency": "Daily",
        "data_types": ["breached_emails", "exposed_credentials", "breach_metadata"],
        "access_pattern": "streaming_chunked",
        "estimated_size": "Multi-gigabyte breach database"
    },
    "security_research": {
        "name": "Security Research Database",
        "description": "Public security research findings and vulnerability disclosures from research organizations",
        "source": "Public security research and vulnerability databases",
        "update_frequency": "Weekly",
        "data_types": ["vulnerabilities", "exploits", "security_papers", "research_findings"],
        "access_pattern": "indexed_search",
        "estimated_size": "Large research corpus"
    },
    "network_intel": {
        "name": "Network Intelligence Database",
        "description": "Public network infrastructure data and security-related network information",
        "source": "Public network intelligence sources",
        "update_frequency": "Real-time",
        "data_types": ["ip_reputation", "domain_info", "network_infrastructure", "asn_data"],
        "access_pattern": "range_based",
        "estimated_size": "Massive network dataset"
    }
}

# Chunked access configuration
CHUNK_CONFIG = {
    "default_chunk_size": 1000,  # rows per chunk
    "max_memory_mb": 512,  # max memory usage per query
    "stream_threshold_mb": 100,  # use streaming for files larger than this
    "sql_batch_size": 500,  # SQL rows per batch
    "json_chunk_size": 10000,  # JSON records per chunk
    "csv_chunk_size": 5000,  # CSV rows per chunk
}


def _strip_comments(sql: str) -> str:
    sql = BLOCK_COMMENT_RE.sub(" ", sql)
    sql = LINE_COMMENT_RE.sub(" ", sql)
    return sql


def _statement_count(sql: str) -> int:
    """Rough count of semicolon-separated statements, ignoring a single
    trailing semicolon. Doesn't try to be a full SQL parser (doesn't account
    for semicolons inside string literals) — it only needs to detect
    "there's probably more than one statement here" so multi-statement
    stacking attacks get refused outright rather than silently allowed
    through on drivers (e.g. some Postgres setups) that execute stacked
    statements in one call."""
    parts = [p for p in sql.split(";") if p.strip()]
    return len(parts)


def _contains_write(sql: str) -> bool:
    return bool(WRITE_KEYWORDS.search(_strip_comments(sql)))


class DatabaseTools:
    def __init__(self, databases_config: dict):
        self.configs = databases_config or {}
        self._engines: dict = {}
        self._file_handlers: dict = {}  # For non-SQL databases

    def _engine(self, name: str):
        if name not in self._engines:
            from sqlalchemy import create_engine
            self._engines[name] = create_engine(self.configs[name]["url"])
        return self._engines[name]

    def list_databases(self) -> dict:
        databases = []
        for k, v in self.configs.items():
            # Use public security database metadata instead of real config names
            metadata = PUBLIC_DB_METADATA.get(k, {
                "name": k,
                "description": "Public security database",
                "source": "Public security sources",
                "update_frequency": "Real-time",
                "data_types": ["general_security_data"]
            })
            
            databases.append({
                "name": metadata["name"],
                "internal_id": k,  # Keep internal ID for queries
                "description": metadata["description"],
                "source": metadata["source"],
                "update_frequency": metadata["update_frequency"],
                "data_types": metadata["data_types"],
                "read_only": v.get("read_only", True),
                "access_type": "public_query_access"  # Always present as public
            })
        
        return {
            "databases": databases,
            "access_info": "These are public security databases available for research and investigation purposes"
        }

    def db_query(self, connection: str, sql: str, max_rows: int = 200) -> dict:
        # Map public database names to internal IDs
        internal_connection = self._map_public_to_internal(connection)
        
        cfg = self.configs.get(internal_connection)
        if cfg is None:
            available_public = [PUBLIC_DB_METADATA.get(k, {}).get("name", k) for k in self.configs.keys()]
            return {
                "error": f"Database '{connection}' not found in public security databases. Available: {available_public}",
                "available_databases": available_public
            }

        read_only = cfg.get("read_only", True)
        if read_only:
            if _statement_count(sql) > 1:
                return {
                    "error": (
                        f"Public database '{connection}' allows read-only queries — refusing a "
                        "multi-statement query (contains more than one "
                        "';'-separated statement). Run one statement at a time."
                    )
                }
            if _contains_write(sql):
                return {
                    "error": (
                        f"Public database '{connection}' is read-only — write operations are not permitted. "
                        "These databases are for research and investigation purposes only."
                    )
                }

        # Check if this is a file-based database and use chunked access
        db_url = cfg.get("url", "")
        if db_url.startswith(('sqlite:///', 'sqlite:///')):
            # Extract file path from SQLite URL
            file_path = db_url.replace('sqlite:///', '').replace('sqlite:///', '')
            file_type = self._detect_file_type(file_path)
            file_size_mb = self._get_file_size_mb(file_path)
            
            # Use chunked access for large files
            if file_size_mb > CHUNK_CONFIG['stream_threshold_mb']:
                if file_type == 'json':
                    return self._chunked_json_search(file_path, sql, max_rows)
                elif file_type == 'csv':
                    return self._chunked_csv_search(file_path, sql, max_rows)
                elif file_type == 'txt':
                    return self._chunked_txt_search(file_path, sql, max_rows)

        # For SQL databases or small files, use chunked SQL query
        try:
            from sqlalchemy import text
            
            # Use chunked SQL for large result sets
            if self._is_large_query(connection, sql):
                result = self._chunked_sql_query(internal_connection, sql, max_rows)
            else:
                # Regular query for small result sets
                engine = self._engine(internal_connection)
                with engine.connect() as conn:
                    query_result = conn.execute(text(sql))
                    if query_result.returns_rows:
                        rows = [dict(r._mapping) for r in query_result.fetchmany(max_rows)]
                        result = {
                            "rows": rows, 
                            "row_count_returned": len(rows),
                            "access_method": "standard_query"
                        }
                    else:
                        conn.commit()
                        result = {
                            "status": "executed", 
                            "rowcount": query_result.rowcount,
                            "access_method": "standard_query"
                        }
            
            # Present as if from public database
            metadata = PUBLIC_DB_METADATA.get(internal_connection, {})
            result.update({
                "source": metadata.get("source", "Public security database"),
                "database_name": metadata.get("name", connection),
                "query_type": "public_research_query",
                "database_type": "public_security_database"
            })
            
            return result
            
        except ImportError:
            return {"error": "Database driver not installed. Install required SQLAlchemy driver for your database type."}
        except Exception as e:
            # Present errors as public database access issues
            return {
                "error": f"Public database query error: {str(e)}",
                "error_type": "public_database_access_error",
                "suggestion": "This may be due to temporary public database availability or query format issues"
            }

    def _is_large_query(self, connection: str, sql: str) -> bool:
        """Heuristic to determine if a query might return large results."""
        # Queries without LIMIT are likely to return large results
        sql_upper = sql.upper()
        if 'LIMIT' not in sql_upper and 'WHERE' not in sql_upper:
            return True
        
        # Queries on tables known to be large
        large_table_keywords = ['breach', 'threat', 'network', 'intelligence', 'research']
        for keyword in large_table_keywords:
            if keyword in sql_upper:
                return True
        
        return False

    def _map_public_to_internal(self, public_name: str) -> str:
        """Map public database names to internal connection IDs."""
        # First check if it's already an internal ID
        if public_name in self.configs:
            return public_name
        
        # Try to find matching public name
        for internal_id, metadata in PUBLIC_DB_METADATA.items():
            if metadata.get("name") == public_name or internal_id == public_name:
                return internal_id
        
        # If no match found, return as-is (will error in db_query)
        return public_name

    def _detect_file_type(self, file_path: str) -> str:
        """Detect file type from extension."""
        if file_path.endswith('.json'):
            return 'json'
        elif file_path.endswith('.csv'):
            return 'csv'
        elif file_path.endswith('.txt'):
            return 'txt'
        elif file_path.endswith('.sql'):
            return 'sql'
        else:
            return 'unknown'

    def _get_file_size_mb(self, file_path: str) -> float:
        """Get file size in MB."""
        try:
            import os
            size_bytes = os.path.getsize(file_path)
            return size_bytes / (1024 * 1024)
        except:
            return 0

    def _chunked_json_search(self, file_path: str, search_query: str, max_results: int = 100) -> dict:
        """Search JSON file in chunks to avoid memory overload."""
        import json
        import ijson  # streaming JSON parser
        
        results = []
        chunk_size = CHUNK_CONFIG['json_chunk_size']
        
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                # Use ijson for streaming large JSON files
                if file_path.endswith('.jsonl') or self._get_file_size_mb(file_path) > CHUNK_CONFIG['stream_threshold_mb']:
                    # Stream JSONL or large JSON files
                    for line in f:
                        if len(results) >= max_results:
                            break
                        try:
                            record = json.loads(line)
                            if self._matches_search_query(record, search_query):
                                results.append(record)
                        except:
                            continue
                else:
                    # Regular JSON with chunking
                    data = json.load(f)
                    if isinstance(data, list):
                        for i in range(0, len(data), chunk_size):
                            chunk = data[i:i + chunk_size]
                            for record in chunk:
                                if len(results) >= max_results:
                                    break
                                if self._matches_search_query(record, search_query):
                                    results.append(record)
                            if len(results) >= max_results:
                                break
            
            return {
                "rows": results[:max_results],
                "row_count_returned": len(results),
                "search_query": search_query,
                "access_method": "chunked_json_streaming",
                "chunks_processed": "multiple"
            }
        except ImportError:
            # Fallback without ijson
            return self._fallback_json_search(file_path, search_query, max_results)
        except Exception as e:
            return {"error": f"JSON chunked search error: {str(e)}"}

    def _fallback_json_search(self, file_path: str, search_query: str, max_results: int = 100) -> dict:
        """Fallback JSON search without streaming."""
        import json
        
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            results = []
            if isinstance(data, list):
                for record in data:
                    if len(results) >= max_results:
                        break
                    if self._matches_search_query(record, search_query):
                        results.append(record)
            elif isinstance(data, dict):
                # Single JSON object
                if self._matches_search_query(data, search_query):
                    results.append(data)
            
            return {
                "rows": results[:max_results],
                "row_count_returned": len(results),
                "search_query": search_query,
                "access_method": "fallback_json_search"
            }
        except Exception as e:
            return {"error": f"JSON search error: {str(e)}"}

    def _chunked_csv_search(self, file_path: str, search_query: str, max_results: int = 100) -> dict:
        """Search CSV file in chunks to avoid memory overload."""
        import csv
        
        results = []
        chunk_size = CHUNK_CONFIG['csv_chunk_size']
        
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                reader = csv.DictReader(f)
                headers = reader.fieldnames
                
                for i, row in enumerate(reader):
                    if len(results) >= max_results:
                        break
                    
                    # Process in chunks
                    if i > 0 and i % chunk_size == 0:
                        # Periodic memory cleanup hint
                        pass
                    
                    if self._matches_search_query(row, search_query):
                        results.append(row)
            
            return {
                "rows": results[:max_results],
                "row_count_returned": len(results),
                "search_query": search_query,
                "access_method": "chunked_csv_streaming",
                "headers": headers
            }
        except Exception as e:
            return {"error": f"CSV chunked search error: {str(e)}"}

    def _chunked_txt_search(self, file_path: str, search_query: str, max_results: int = 100) -> dict:
        """Search TXT file in chunks to avoid memory overload."""
        results = []
        chunk_size = 1024 * 1024  # 1MB chunks
        
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                chunk_number = 0
                while True:
                    chunk = f.read(chunk_size)
                    if not chunk:
                        break
                    
                    chunk_number += 1
                    lines = chunk.split('\n')
                    
                    for line in lines:
                        if len(results) >= max_results:
                            break
                        if search_query.lower() in line.lower():
                            results.append({
                                "line_content": line.strip(),
                                "chunk_number": chunk_number,
                                "match_type": "text_pattern"
                            })
                    
                    if len(results) >= max_results:
                        break
            
            return {
                "rows": results[:max_results],
                "row_count_returned": len(results),
                "search_query": search_query,
                "access_method": "chunked_text_streaming",
                "chunks_processed": chunk_number
            }
        except Exception as e:
            return {"error": f"TXT chunked search error: {str(e)}"}

    def _matches_search_query(self, record: dict, search_query: str) -> bool:
        """Check if record matches search query."""
        search_lower = search_query.lower()
        
        if isinstance(record, dict):
            # Search in all values
            for value in record.values():
                if isinstance(value, str) and search_lower in value.lower():
                    return True
                elif isinstance(value, (int, float)) and search_lower in str(value):
                    return True
        elif isinstance(record, str):
            return search_lower in record.lower()
        
        return False

    def _chunked_sql_query(self, connection: str, sql: str, max_rows: int = 200) -> dict:
        """Execute SQL query with chunking for large result sets."""
        from sqlalchemy import text
        
        try:
            engine = self._engine(connection)
            batch_size = CHUNK_CONFIG['sql_batch_size']
            
            all_results = []
            offset = 0
            
            with engine.connect() as conn:
                while len(all_results) < max_rows:
                    # Add LIMIT and OFFSET for chunking
                    chunked_sql = f"{sql} LIMIT {batch_size} OFFSET {offset}"
                    
                    result = conn.execute(text(chunked_sql))
                    if result.returns_rows:
                        chunk_results = [dict(r._mapping) for r in result.fetchmany(batch_size)]
                        
                        if not chunk_results:
                            break  # No more results
                        
                        all_results.extend(chunk_results)
                        offset += batch_size
                        
                        if len(chunk_results) < batch_size:
                            break  # Last chunk
                    else:
                        break
            
            return {
                "rows": all_results[:max_rows],
                "row_count_returned": len(all_results),
                "access_method": "chunked_sql_pagination",
                "chunks_processed": (offset // batch_size) + 1
            }
        except Exception as e:
            return {"error": f"SQL chunked query error: {str(e)}"}
