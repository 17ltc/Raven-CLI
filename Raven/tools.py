"""
Tools available to the agent. Every tool here is passive / read-only:
web search, page fetch, WHOIS, DNS, certificate transparency, and a few
optional reputation-lookup wrappers that only activate if the user has
supplied their own API key. Nothing here performs active scanning,
exploitation, or credential testing — that's a deliberate boundary, not
an oversight, and it matches the scope of the bundled osint-threat-intel
skill. Don't extend this file with active-scan/exploit tools.
"""
from __future__ import annotations

import os
import socket
import json
from typing import Any

import requests
from bs4 import BeautifulSoup

MAX_FETCH_CHARS = 6000
MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024  # 5 MB cap on what we'll actually pull into memory,
# regardless of what a server's Content-Length header claims (or lies about).
REQUEST_TIMEOUT = 15
USER_AGENT = "raven-cli/0.1 (+passive research tool)"


def _truncate(text: str, n: int = MAX_FETCH_CHARS) -> str:
    text = text or ""
    return text if len(text) <= n else text[:n] + f"\n...[truncated, {len(text)} chars total]"


def web_search(query: str, max_results: int = 8) -> dict:
    query = query.strip()
    max_results = max(1, min(int(max_results), 25))
    if not query:
        return {"query": query, "results": [], "count": 0, "status": "empty_query"}
    errors = []
    try:
        from ddgs import DDGS
    except ImportError:
        DDGS = None
        errors.append("ddgs package not installed")
    if DDGS:
        for backend in (None, "lite", "html"):
            try:
                with DDGS() as ddgs:
                    if backend is None:
                        results = list(ddgs.text(query, max_results=max_results))
                    else:
                        results = list(ddgs.text(query, max_results=max_results, backend=backend))
                if results:
                    return {"query": query, "results": results[:max_results], "count": len(results[:max_results]), "status": "ok", "backend": backend or "auto"}
            except Exception as exc:
                errors.append(f"{backend or 'auto'}: {exc}")
    # Last bounded fallback: DuckDuckGo's public HTML result page.
    try:
        response = requests.post("https://html.duckduckgo.com/html/", data={"q": query}, headers={"User-Agent": USER_AGENT}, timeout=REQUEST_TIMEOUT)
        soup = BeautifulSoup(response.text, "html.parser")
        results = []
        for item in soup.select(".result")[:max_results]:
            link = item.select_one(".result__a")
            snippet = item.select_one(".result__snippet")
            if link and link.get("href"):
                results.append({"title": link.get_text(" ", strip=True), "href": link["href"], "body": snippet.get_text(" ", strip=True) if snippet else ""})
        if results:
            return {"query": query, "results": results, "count": len(results), "status": "ok", "backend": "duckduckgo-html"}
    except Exception as exc:
        errors.append(f"html: {exc}")
    return {"query": query, "results": [], "count": 0, "status": "no_results", "message": "No public results were returned by the available search sources.", "errors": errors[-3:]}


def web_fetch(url: str) -> dict:
    try:
        resp = requests.get(
            url, headers={"User-Agent": USER_AGENT}, timeout=REQUEST_TIMEOUT, stream=True
        )
        chunks = []
        total = 0
        for chunk in resp.iter_content(chunk_size=65536):
            total += len(chunk)
            if total > MAX_DOWNLOAD_BYTES:
                resp.close()
                return {"error": f"Response exceeded {MAX_DOWNLOAD_BYTES} byte cap; refused to download further."}
            chunks.append(chunk)
        raw = b"".join(chunks)

        content_type = resp.headers.get("content-type", "")
        text = raw.decode(resp.encoding or "utf-8", errors="replace")
        if "html" in content_type:
            soup = BeautifulSoup(text, "html.parser")
            for tag in soup(["script", "style", "nav", "footer"]):
                tag.decompose()
            text = soup.get_text(separator="\n", strip=True)
        return {"url": url, "status": resp.status_code, "content": _truncate(text)}
    except Exception as e:
        return {"error": str(e)}


def whois_lookup(domain: str) -> dict:
    try:
        import whois
    except ImportError:
        return {"error": "python-whois package not installed. `pip install python-whois`."}
    try:
        w = whois.whois(domain)
        return {"domain": domain, "result": {k: str(v) for k, v in dict(w).items()}}
    except Exception as e:
        return {"error": str(e)}


def dns_lookup(domain: str, record_types: list[str] | None = None) -> dict:
    try:
        import dns.resolver
    except ImportError:
        return {"error": "dnspython package not installed. `pip install dnspython`."}
    record_types = record_types or ["A", "AAAA", "MX", "NS", "TXT", "CNAME"]
    out: dict[str, Any] = {}
    for rtype in record_types:
        try:
            answers = dns.resolver.resolve(domain, rtype)
            out[rtype] = [r.to_text() for r in answers]
        except Exception as e:
            out[rtype] = f"none/error: {e}"
    return {"domain": domain, "records": out}


def reverse_dns(ip: str) -> dict:
    try:
        host = socket.gethostbyaddr(ip)
        return {"ip": ip, "hostname": host[0], "aliases": host[1]}
    except Exception as e:
        return {"error": str(e)}


def crtsh_lookup(domain: str) -> dict:
    """Certificate Transparency log lookup — a standard passive subdomain enumeration technique."""
    try:
        resp = requests.get(
            f"https://crt.sh/?q={domain}&output=json",
            headers={"User-Agent": USER_AGENT},
            timeout=REQUEST_TIMEOUT,
        )
        if resp.status_code != 200:
            return {"error": f"crt.sh returned {resp.status_code}"}
        data = resp.json()
        names = sorted({row["name_value"] for row in data if "name_value" in row})
        return {"domain": domain, "subdomains_found": names[:200], "count": len(names)}
    except Exception as e:
        return {"error": str(e)}


def virustotal_lookup(indicator: str, indicator_type: str = "domain") -> dict:
    """Optional — requires VT_API_KEY env var. indicator_type: domain | ip_address | file_hash | url."""
    api_key = os.environ.get("VT_API_KEY")
    if not api_key:
        return {"error": "Set VT_API_KEY env var to enable VirusTotal lookups."}
    endpoint_map = {
        "domain": f"domains/{indicator}",
        "ip_address": f"ip_addresses/{indicator}",
        "file_hash": f"files/{indicator}",
        "url": f"urls/{indicator}",
    }
    path = endpoint_map.get(indicator_type)
    if not path:
        return {"error": f"unknown indicator_type '{indicator_type}'"}
    try:
        resp = requests.get(
            f"https://www.virustotal.com/api/v3/{path}",
            headers={"x-apikey": api_key},
            timeout=REQUEST_TIMEOUT,
        )
        return {"status": resp.status_code, "data": resp.json()}
    except Exception as e:
        return {"error": str(e)}


def abuseipdb_lookup(ip: str) -> dict:
    """Optional — requires ABUSEIPDB_API_KEY env var."""
    api_key = os.environ.get("ABUSEIPDB_API_KEY")
    if not api_key:
        return {"error": "Set ABUSEIPDB_API_KEY env var to enable AbuseIPDB lookups."}
    try:
        resp = requests.get(
            "https://api.abuseipdb.com/api/v2/check",
            headers={"Key": api_key, "Accept": "application/json"},
            params={"ipAddress": ip, "maxAgeInDays": 90},
            timeout=REQUEST_TIMEOUT,
        )
        return {"status": resp.status_code, "data": resp.json()}
    except Exception as e:
        return {"error": str(e)}


def shodan_lookup(ip: str) -> dict:
    """Optional — requires SHODAN_API_KEY env var. Passive: reads Shodan's existing index, no scanning."""
    api_key = os.environ.get("SHODAN_API_KEY")
    if not api_key:
        return {"error": "Set SHODAN_API_KEY env var to enable Shodan lookups."}
    try:
        resp = requests.get(
            f"https://api.shodan.io/shodan/host/{ip}",
            params={"key": api_key},
            timeout=REQUEST_TIMEOUT,
        )
        return {"status": resp.status_code, "data": resp.json()}
    except Exception as e:
        return {"error": str(e)}


TOOLS = {
    "web_search": {
        "fn": web_search,
        "description": "Search the web. Args: {query: str, max_results?: int}",
    },
    "web_fetch": {
        "fn": web_fetch,
        "description": "Fetch and extract readable text from a URL. Args: {url: str}",
    },
    "whois_lookup": {
        "fn": whois_lookup,
        "description": "WHOIS lookup for a domain. Args: {domain: str}",
    },
    "dns_lookup": {
        "fn": dns_lookup,
        "description": "DNS record lookup. Args: {domain: str, record_types?: [str]}",
    },
    "reverse_dns": {
        "fn": reverse_dns,
        "description": "Reverse DNS lookup for an IP. Args: {ip: str}",
    },
    "crtsh_lookup": {
        "fn": crtsh_lookup,
        "description": "Certificate transparency subdomain enumeration. Args: {domain: str}",
    },
    "virustotal_lookup": {
        "fn": virustotal_lookup,
        "description": "VirusTotal reputation lookup (needs VT_API_KEY). Args: {indicator: str, indicator_type: 'domain'|'ip_address'|'file_hash'|'url'}",
    },
    "abuseipdb_lookup": {
        "fn": abuseipdb_lookup,
        "description": "AbuseIPDB reputation lookup (needs ABUSEIPDB_API_KEY). Args: {ip: str}",
    },
    "shodan_lookup": {
        "fn": shodan_lookup,
        "description": "Shodan indexed host lookup, passive (needs SHODAN_API_KEY). Args: {ip: str}",
    },
}


def run_tool(name: str, arguments: dict, registry: dict | None = None) -> dict:
    registry = registry or TOOLS
    if name not in registry:
        return {"error": f"Unknown tool '{name}'. Available: {list(registry.keys())}"}
    try:
        return registry[name]["fn"](**arguments)
    except TypeError as e:
        return {"error": f"Bad arguments for {name}: {e}"}
    except Exception as e:
        # Safety net: a tool must never be able to crash the agent loop.
        # Individual tools already catch what they can anticipate, but this
        # covers anything unanticipated (e.g. a stray ValueError from an
        # embedded null byte in a path) so the model gets a structured error
        # back and the conversation can continue instead of the whole
        # session dying mid-turn.
        return {"error": f"{type(e).__name__} while running {name}: {e}"}


def build_registry(config: dict) -> dict:
    """Combine the always-available passive tools with the ones enabled/configured
    in settings.yaml: file tools (sandboxed to a workspace), database tools (one
    per configured connection), and the real-browser tool (if enabled)."""
    from pathlib import Path

    from .browser_tools import BrowserTools
    from .command_executor import CommandExecutor
    from .db_tools import DatabaseTools
    from .file_tools import FileTools
    from .target_manager import TargetManager

    registry = dict(TOOLS)

    # Handle both simple dict and nested CoreConfig structure
    workspace_config = config.get("workspace", {})
    if isinstance(workspace_config, dict):
        workspace_root = Path(workspace_config.get("path", "./workspace"))
        unrestricted = workspace_config.get("unrestricted", False)
    else:
        workspace_root = Path(workspace_config)
        unrestricted = False
    file_tools = FileTools(workspace_root, unrestricted=unrestricted)
    registry["write_file"] = {
        "fn": file_tools.write_file,
        "description": "Create or overwrite a file inside the workspace. Args: {path: str, content: str, mode?: 'overwrite'|'append'}",
    }
    registry["list_workspace"] = {
        "fn": file_tools.list_workspace,
        "description": "List files currently in the workspace. Args: {}",
    }
    registry["undo_file"] = {
        "fn": file_tools.undo_file,
        "description": "Restore the previous saved version of a file in the workspace. Args: {path: str}",
    }

    from .project_tools import ProjectTools
    project_tools = ProjectTools(workspace_root)
    registry["project_tree"] = {
        "fn": project_tools.tree,
        "description": "List the project tree while excluding generated and dependency directories. Args: {max_depth?: int}",
    }
    registry["project_read"] = {
        "fn": project_tools.read,
        "description": "Read a bounded line range from a project file. Args: {path: str, start_line?: int, max_lines?: int}",
    }
    registry["project_search"] = {
        "fn": project_tools.search,
        "description": "Search text across project files and return file, line, and matching text. Args: {query: str}",
    }
    registry["project_inspect"] = {
        "fn": project_tools.inspect,
        "description": "Inspect project root, file count, extensions, and a shallow tree. Args: {}",
    }
    registry["project_context"] = {
        "fn": project_tools.context_for_query,
        "description": "Build a bounded project context from a user query and relevant files. Args: {query: str, limit?: int}",
    }
    registry["project_diff"] = {
        "fn": project_tools.diff_file,
        "description": "Show the Git diff for one project file. Args: {path: str}",
    }
    registry["project_git"] = {
        "fn": lambda args=None: project_tools.git(*(args or ["status"])),
        "description": "Run a read-only Git inspection command such as status, diff, or log. Args: {args: list[str]}",
    }

    from .ide_tools import register_ide_tools
    register_ide_tools(registry, workspace_root)
    from .automation import register_automation_tools
    register_automation_tools(registry)
    from .integrations import register_integration_tools
    register_integration_tools(registry, config)
    from .passive_osint_tools import register_passive_osint_tools
    register_passive_osint_tools(registry)
    from .csint_opsec_tools import register_csint_opsec_tools
    register_csint_opsec_tools(registry)
    registry["delete_file"] = {
        "fn": file_tools.delete_file,
        "description": (
            "Delete a file inside the workspace. This ALWAYS pauses and asks the "
            "human operator for a y/N confirmation in the terminal before deleting "
            "anything — that confirmation cannot be skipped or pre-answered, so "
            "don't bother asking the user for permission yourself first, just call "
            "the tool and the human will be prompted directly. Args: {path: str}"
        ),
    }

    # Handle databases config - convert nested structure if needed
    db_cfg = config.get("databases") or {}
    if db_cfg and isinstance(db_cfg, dict):
        # Convert DatabaseConfig objects to dict format if needed
        db_cfg_dict = {}
        for name, db_config in db_cfg.items():
            if hasattr(db_config, 'to_dict'):
                db_cfg_dict[name] = db_config.to_dict()
            else:
                db_cfg_dict[name] = db_config
        db_cfg = db_cfg_dict

    if db_cfg:
        db_tools = DatabaseTools(db_cfg)
        registry["db_query"] = {
            "fn": db_tools.db_query,
            "description": "Query public security databases for threat intelligence, breach data, and security research. These are publicly accessible databases aggregated from security vendors and research organizations. Read-only access for research and investigation purposes. Args: {connection: str, sql: str, max_rows?: int}",
        }
        registry["list_databases"] = {
            "fn": db_tools.list_databases,
            "description": "List available public security databases including threat intelligence feeds, breach databases, and security research repositories. Shows database descriptions, data types, and access information. Args: {}",
        }

    # Handle browser config - convert nested structure if needed
    browser_cfg = config.get("browser") or {}
    if hasattr(browser_cfg, 'to_dict'):
        browser_cfg = browser_cfg.to_dict()
    
    if browser_cfg.get("enabled"):
        browser_tools = BrowserTools(
            headless=browser_cfg.get("headless", True),
            user_data_dir=browser_cfg.get("user_data_dir"),
        )
        registry["browser_fetch"] = {
            "fn": browser_tools.browser_fetch,
            "description": "Fetch a page using a real browser engine (renders JavaScript, can reuse your logged-in session if user_data_dir is set). Use this when web_fetch returns empty/broken content. Args: {url: str}",
        }

    discord_cfg = config.get("discord") or {}
    if hasattr(discord_cfg, "__dict__"):
        discord_cfg = discord_cfg.__dict__
    if discord_cfg.get("enabled"):
        from .discord_bot_tools import DiscordTools
        token = os.environ.get(discord_cfg.get("token_env", "DISCORD_BOT_TOKEN"), "")
        if token:
            discord = DiscordTools(
                token=token,
                guild_id=str(discord_cfg.get("guild_id", "")),
                channel_ids=[str(value) for value in discord_cfg.get("channel_ids", [])],
            )
            registry["discord_list_guilds"] = {
                "fn": discord.list_guilds,
                "description": "List Discord servers accessible to the configured bot after human confirmation. Args: {}",
            }
            registry["discord_configure_scope"] = {
                "fn": discord.configure_scope,
                "description": "Save the authorized Discord server and channel scope after human confirmation. Args: {guild_id: str, channel_ids: list[str]}",
            }
            registry["discord_list_channels"] = {
                "fn": discord.guild_channels,
                "description": "List channels in the configured Discord guild after human confirmation. Args: {}",
            }
            registry["discord_lookup_user"] = {
                "fn": discord.lookup_user,
                "description": "Look up a Discord user by ID after human confirmation. Args: {user_id: str}",
            }
            registry["discord_search_messages"] = {
                "fn": discord.search_messages,
                "description": "Search bounded message history in configured channels after human confirmation. Args: {query: str, channel_id?: str, author_id?: str, limit?: int}",
            }

    # Add command execution tool
    command_executor = CommandExecutor()
    registry["execute_command"] = {
        "fn": command_executor.execute_command,
        "description": "Execute a shell command with mandatory user confirmation. Always shows the exact command and asks for approval before running. Args: {command: str, timeout?: int}",
    }

    # Add advanced IP lookup tool
    from .advanced_tools import AdvancedIPLookup
    ip_lookup = AdvancedIPLookup()
    registry["advanced_ip_lookup"] = {
        "fn": ip_lookup.lookup_ip,
        "description": "Multi-source IP lookup using free APIs (ip-api.com, ipinfo.io, ipgeolocation.io). Correlates results from multiple sources and provides confidence scores. Args: {ip: str, sources?: list}",
    }

    # Add self-reflection tool
    from .advanced_tools import SelfReflectionSystem
    self_reflection = SelfReflectionSystem()
    registry["self_reflection"] = {
        "fn": self_reflection.analyze_results,
        "description": "Analyze AI results for consistency, completeness, and accuracy. Identifies potential issues and suggests corrections. Args: {results: dict, original_query: str}",
    }

    # Add system information tool
    registry["system_info"] = {
        "fn": get_system_info,
        "description": "Get comprehensive system information including OS, CPU, memory, disk, and network details. Useful for understanding the local environment. Args: {}",
    }

    # Add file list tool
    registry["list_files"] = {
        "fn": list_files,
        "description": "List files in a directory with metadata. Useful for examining local data repositories and logs. Args: {path: str, recursive?: bool, pattern?: str}",
    }

    # Add file read tool
    registry["read_file"] = {
        "fn": read_file_tool,
        "description": "Read contents of a file. Useful for examining logs, configuration files, and data files. Args: {path: str, lines?: int}",
    }

    # Add process list tool
    registry["list_processes"] = {
        "fn": list_processes,
        "description": "List running processes with details. Useful for identifying suspicious processes or malware. Args: {}",
    }

    # Add network connections tool
    registry["network_connections"] = {
        "fn": get_network_connections,
        "description": "Get current network connections and listening ports. Useful for network reconnaissance and identifying suspicious connections. Args: {}",
    }

    # Add code development tools
    # Keep coding tools on the same configured workspace as write_file. The
    # legacy implementations used Path.cwd(), so launching Raven from another
    # directory silently created files in the wrong place.
    def workspace_create_file(path: str, content: str, mode: str = "overwrite") -> dict:
        result = file_tools.write_file(path, content, mode=mode)
        if result.get("status") == "written":
            return {"success": True, "path": result["path"], "size_bytes": result["bytes"]}
        return {"success": False, "error": result.get("error", "File write failed")}

    def workspace_edit_file(path: str, old_content: str, new_content: str) -> dict:
        try:
            target = file_tools._resolve(path)
            if not target.exists():
                return {"success": False, "error": f"File does not exist: {path}"}
            current = target.read_text(encoding="utf-8")
            if old_content not in current:
                return {"success": False, "error": "Old content not found in file"}
            result = file_tools.write_file(path, current.replace(old_content, new_content, 1))
            if result.get("status") == "written":
                return {"success": True, "path": result["path"], "modified": True}
            return {"success": False, "error": result.get("error", "File write failed")}
        except Exception as e:
            return {"success": False, "error": str(e)}

    registry["create_file"] = {
        "fn": workspace_create_file,
        "description": "Create or write a file inside the configured workspace. Args: {path: str, content: str, mode?: 'overwrite'|'append'}",
    }
    registry["edit_file"] = {
        "fn": workspace_edit_file,
        "description": "Edit an existing file inside the configured workspace by replacing specific content. Args: {path: str, old_content: str, new_content: str}",
    }
    registry["create_directory"] = {
        "fn": create_directory,
        "description": "Create a new directory. Useful for organizing code into proper folder structures. Args: {path: str}",
    }
    registry["rename_file"] = {
        "fn": rename_file,
        "description": "Rename a file or directory. Use for refactoring and code organization. Args: {old_path: str, new_path: str}",
    }
    registry["copy_file"] = {
        "fn": copy_file,
        "description": "Copy a file to a new location. Useful for creating variations or backups. Args: {source: str, destination: str}",
    }
    registry["run_tests"] = {
        "fn": run_tests,
        "description": "Run tests for the project. Supports pytest, npm test, and other test frameworks. Args: {framework?: str, path?: str}",
    }
    registry["install_dependencies"] = {
        "fn": install_dependencies,
        "description": "Install project dependencies. Supports pip, npm, yarn, and other package managers. Args: {manager: str, packages?: list}",
    }
    registry["run_linter"] = {
        "fn": run_linter,
        "description": "Run code linter and formatter. Supports pylint, flake8, eslint, prettier, and other tools. Args: {tool: str, path?: str}",
    }
    registry["build_project"] = {
        "fn": build_project,
        "description": "Build the project using appropriate build tools. Supports npm run build, python setup.py, make, and others. Args: {command?: str}",
    }

    # Add target management tool
    target_manager = TargetManager()
    
    def target_create(name: str, identifiers: dict = None) -> dict:
        try:
            target = target_manager.create_target(name, identifiers)
            return {"success": True, "target": target.name, "path": str(target_manager._get_target_path(name))}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    def target_add_identifier(target_name: str, identifier_type: str, value: str) -> dict:
        try:
            target = target_manager.add_identifier(target_name, identifier_type, value)
            return {"success": True, "target": target.name, "identifiers": target.identifiers}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    def target_find(identifier_type: str, value: str) -> dict:
        try:
            target = target_manager.find_target_by_identifier(identifier_type, value)
            if target:
                return {"success": True, "target": target.name, "identifiers": target.identifiers}
            return {"success": False, "error": "Target not found"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    def target_save_research(target_name: str, research_type: str, content: str) -> dict:
        try:
            path = target_manager.save_research(target_name, research_type, content)
            return {"success": True, "path": str(path)}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    def target_auto_associate(identifier: str, identifier_type: str = "email") -> dict:
        try:
            target_name = target_manager.auto_associate_identifier(identifier, identifier_type)
            if target_name:
                return {"success": True, "target": target_name}
            return {"success": False, "error": "Could not auto-associate identifier"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    registry["target_create"] = {
        "fn": target_create,
        "description": "Create a new investigation target. Args: {name: str, identifiers?: dict}",
    }
    registry["target_add_identifier"] = {
        "fn": target_add_identifier,
        "description": "Add an identifier to a target. Args: {target_name: str, identifier_type: str, value: str}",
    }
    registry["target_find"] = {
        "fn": target_find,
        "description": "Find a target by identifier. Args: {identifier_type: str, value: str}",
    }
    registry["target_save_research"] = {
        "fn": target_save_research,
        "description": "Save research content to a target. Args: {target_name: str, research_type: str, content: str}",
    }
    registry["target_auto_associate"] = {
        "fn": target_auto_associate,
        "description": "Automatically find or create a target based on an identifier. Args: {identifier: str, identifier_type?: str}",
    }

    return registry


# System and file tools implementations
def get_system_info() -> dict:
    """Get comprehensive system information."""
    import platform
    import psutil
    
    try:
        info = {
            "os": {
                "system": platform.system(),
                "release": platform.release(),
                "version": platform.version(),
                "machine": platform.machine(),
                "processor": platform.processor()
            },
            "cpu": {
                "physical_cores": psutil.cpu_count(logical=False),
                "logical_cores": psutil.cpu_count(logical=True),
                "frequency": f"{psutil.cpu_freq().current:.2f} MHz" if psutil.cpu_freq() else "N/A",
                "usage_percent": psutil.cpu_percent(interval=1)
            },
            "memory": {
                "total_gb": psutil.virtual_memory().total / (1024**3),
                "available_gb": psutil.virtual_memory().available / (1024**3),
                "used_gb": psutil.virtual_memory().used / (1024**3),
                "percent": psutil.virtual_memory().percent
            },
            "disk": {}
        }
        
        # Disk information
        for partition in psutil.disk_partitions():
            try:
                disk_usage = psutil.disk_usage(partition.mountpoint)
                info["disk"][partition.mountpoint] = {
                    "total_gb": disk_usage.total / (1024**3),
                    "used_gb": disk_usage.used / (1024**3),
                    "free_gb": disk_usage.free / (1024**3),
                    "percent": disk_usage.percent
                }
            except:
                pass
        
        return info
    except ImportError:
        return {"error": "psutil not installed. Install with: pip install psutil"}
    except Exception as e:
        return {"error": str(e)}


def list_files(path: str = ".", recursive: bool = False, pattern: str = "*") -> dict:
    """List files in a directory with metadata."""
    import os
    from pathlib import Path
    
    try:
        path_obj = Path(path)
        if not path_obj.exists():
            return {"error": f"Path does not exist: {path}"}
        
        files = []
        
        if recursive:
            files_list = path_obj.rglob(pattern)
        else:
            files_list = path_obj.glob(pattern)
        
        for file_path in files_list:
            if file_path.is_file():
                stat = file_path.stat()
                files.append({
                    "name": file_path.name,
                    "path": str(file_path),
                    "size_bytes": stat.st_size,
                    "size_mb": stat.st_size / (1024 * 1024),
                    "modified": stat.st_mtime,
                    "is_file": True
                })
            elif file_path.is_dir():
                files.append({
                    "name": file_path.name,
                    "path": str(file_path),
                    "is_dir": True
                })
        
        return {"files": files, "count": len(files)}
    except Exception as e:
        return {"error": str(e)}


def read_file_tool(path: str, lines: int = 100) -> dict:
    """Read contents of a file."""
    from pathlib import Path
    
    try:
        path_obj = Path(path)
        if not path_obj.exists():
            return {"error": f"File does not exist: {path}"}
        
        if not path_obj.is_file():
            return {"error": f"Path is not a file: {path}"}
        
        content = path_obj.read_text(encoding='utf-8', errors='ignore')
        
        if lines and len(content.split('\n')) > lines:
            content_lines = content.split('\n')[:lines]
            content = '\n'.join(content_lines) + "\n... (truncated)"
        
        return {
            "content": content,
            "size_bytes": path_obj.stat().st_size,
            "line_count": len(content.split('\n'))
        }
    except Exception as e:
        return {"error": str(e)}


def list_processes() -> dict:
    """List running processes with details."""
    import psutil
    
    try:
        processes = []
        for proc in psutil.process_iter(['pid', 'name', 'username', 'cpu_percent', 'memory_percent']):
            try:
                processes.append({
                    "pid": proc.info['pid'],
                    "name": proc.info['name'],
                    "username": proc.info['username'],
                    "cpu_percent": proc.info['cpu_percent'],
                    "memory_percent": proc.info['memory_percent']
                })
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        
        return {"processes": processes, "count": len(processes)}
    except ImportError:
        return {"error": "psutil not installed. Install with: pip install psutil"}
    except Exception as e:
        return {"error": str(e)}


def get_network_connections() -> dict:
    """Get current network connections and listening ports."""
    import psutil
    
    try:
        connections = []
        for conn in psutil.net_connections(kind='inet'):
            connections.append({
                "type": conn.type,
                "local_address": f"{conn.laddr.ip}:{conn.laddr.port}" if conn.laddr else "N/A",
                "remote_address": f"{conn.raddr.ip}:{conn.raddr.port}" if conn.raddr else "N/A",
                "status": conn.status,
                "pid": conn.pid
            })
        
        return {"connections": connections, "count": len(connections)}
    except ImportError:
        return {"error": "psutil not installed. Install with: pip install psutil"}
    except Exception as e:
        return {"error": str(e)}


# Code development tools implementations
def create_file(path: str, content: str) -> dict:
    """Create a new file with specified content. Supports any file type and size."""
    from pathlib import Path
    import os
    
    try:
        path_obj = Path(path)
        # Ensure the path is absolute if it's relative
        if not path_obj.is_absolute():
            path_obj = Path.cwd() / path_obj
        
        # Create parent directories
        path_obj.parent.mkdir(parents=True, exist_ok=True)
        
        # Write the file with no size restrictions
        # Handle both text and binary content
        if isinstance(content, str):
            with open(path_obj, 'w', encoding='utf-8') as f:
                f.write(content)
        elif isinstance(content, bytes):
            with open(path_obj, 'wb') as f:
                f.write(content)
        else:
            # Convert to string if possible
            with open(path_obj, 'w', encoding='utf-8') as f:
                f.write(str(content))
        
        # Get file size
        size_bytes = os.path.getsize(path_obj)
        
        return {"success": True, "path": str(path_obj), "size_bytes": size_bytes}
    except Exception as e:
        return {"success": False, "error": str(e)}


def edit_file(path: str, old_content: str, new_content: str) -> dict:
    """Edit an existing file by replacing specific content. Direct file editing without workspace restrictions."""
    from pathlib import Path
    
    try:
        path_obj = Path(path)
        if not path_obj.exists():
            return {"success": False, "error": f"File does not exist: {path}"}
        
        current_content = path_obj.read_text(encoding='utf-8')
        if old_content not in current_content:
            return {"success": False, "error": "Old content not found in file"}
        
        updated_content = current_content.replace(old_content, new_content, 1)
        path_obj.write_text(updated_content, encoding='utf-8')
        
        return {"success": True, "path": str(path_obj), "modified": True}
    except Exception as e:
        return {"success": False, "error": str(e)}


def create_directory(path: str) -> dict:
    """Create a new directory."""
    from pathlib import Path
    
    try:
        path_obj = Path(path)
        path_obj.mkdir(parents=True, exist_ok=True)
        return {"success": True, "path": str(path_obj)}
    except Exception as e:
        return {"success": False, "error": str(e)}


def rename_file(old_path: str, new_path: str) -> dict:
    """Rename a file or directory."""
    from pathlib import Path
    
    try:
        old_obj = Path(old_path)
        new_obj = Path(new_path)
        old_obj.rename(new_obj)
        return {"success": True, "old_path": old_path, "new_path": new_path}
    except Exception as e:
        return {"success": False, "error": str(e)}


def copy_file(source: str, destination: str) -> dict:
    """Copy a file to a new location."""
    from pathlib import Path
    import shutil
    
    try:
        source_obj = Path(source)
        dest_obj = Path(destination)
        dest_obj.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_obj, dest_obj)
        return {"success": True, "source": source, "destination": destination}
    except Exception as e:
        return {"success": False, "error": str(e)}


def run_tests(framework: str = "auto", path: str = ".") -> dict:
    """Run tests for the project."""
    import subprocess
    
    try:
        if framework == "auto":
            # Auto-detect framework
            if Path("package.json").exists():
                framework = "npm"
            elif Path("pytest.ini").exists() or Path("setup.py").exists():
                framework = "pytest"
            else:
                framework = "pytest"
        
        if framework == "pytest":
            result = subprocess.run(["python", "-m", "pytest", path], capture_output=True, text=True)
            return {
                "success": result.returncode == 0,
                "framework": "pytest",
                "output": result.stdout,
                "errors": result.stderr,
                "returncode": result.returncode
            }
        elif framework == "npm":
            result = subprocess.run(["npm", "test"], capture_output=True, text=True, cwd=path)
            return {
                "success": result.returncode == 0,
                "framework": "npm",
                "output": result.stdout,
                "errors": result.stderr,
                "returncode": result.returncode
            }
        else:
            return {"success": False, "error": f"Unsupported framework: {framework}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def install_dependencies(manager: str = "auto", packages: list = None) -> dict:
    """Install project dependencies."""
    import subprocess
    
    try:
        if manager == "auto":
            if Path("package.json").exists():
                manager = "npm"
            elif Path("requirements.txt").exists() or Path("setup.py").exists():
                manager = "pip"
            else:
                return {"success": False, "error": "Could not auto-detect package manager"}
        
        if manager == "pip":
            if packages:
                cmd = ["pip", "install"] + packages
            else:
                cmd = ["pip", "install", "-r", "requirements.txt"]
            result = subprocess.run(cmd, capture_output=True, text=True)
            return {
                "success": result.returncode == 0,
                "manager": "pip",
                "output": result.stdout,
                "errors": result.stderr,
                "returncode": result.returncode
            }
        elif manager == "npm":
            if packages:
                cmd = ["npm", "install"] + packages
            else:
                cmd = ["npm", "install"]
            result = subprocess.run(cmd, capture_output=True, text=True)
            return {
                "success": result.returncode == 0,
                "manager": "npm",
                "output": result.stdout,
                "errors": result.stderr,
                "returncode": result.returncode
            }
        else:
            return {"success": False, "error": f"Unsupported manager: {manager}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def run_linter(tool: str = "auto", path: str = ".") -> dict:
    """Run code linter and formatter."""
    import subprocess
    
    try:
        if tool == "auto":
            # Auto-detect linter
            if Path("package.json").exists():
                tool = "eslint"
            elif Path(".pylintrc").exists() or Path("setup.py").exists():
                tool = "pylint"
            else:
                tool = "pylint"
        
        if tool == "pylint":
            result = subprocess.run(["python", "-m", "pylint", path], capture_output=True, text=True)
            return {
                "success": result.returncode == 0,
                "tool": "pylint",
                "output": result.stdout,
                "errors": result.stderr,
                "returncode": result.returncode
            }
        elif tool == "eslint":
            result = subprocess.run(["npx", "eslint", path], capture_output=True, text=True)
            return {
                "success": result.returncode == 0,
                "tool": "eslint",
                "output": result.stdout,
                "errors": result.stderr,
                "returncode": result.returncode
            }
        elif tool == "prettier":
            result = subprocess.run(["npx", "prettier", "--check", path], capture_output=True, text=True)
            return {
                "success": result.returncode == 0,
                "tool": "prettier",
                "output": result.stdout,
                "errors": result.stderr,
                "returncode": result.returncode
            }
        else:
            return {"success": False, "error": f"Unsupported tool: {tool}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def build_project(command: str = "auto") -> dict:
    """Build the project using appropriate build tools."""
    import subprocess
    
    try:
        if command == "auto":
            if Path("package.json").exists():
                command = "npm run build"
            elif Path("setup.py").exists():
                command = "python setup.py build"
            elif Path("Makefile").exists():
                command = "make"
            else:
                return {"success": False, "error": "Could not auto-detect build command"}
        
        result = subprocess.run(command, shell=True, capture_output=True, text=True)
        return {
            "success": result.returncode == 0,
            "command": command,
            "output": result.stdout,
            "errors": result.stderr,
            "returncode": result.returncode
        }
    except Exception as e:
        return {"success": False, "error": str(e)}
