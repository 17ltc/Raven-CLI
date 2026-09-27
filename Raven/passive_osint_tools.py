"""Bounded passive web and public GEOINT helpers.

These tools work on public URLs and user-supplied places only. They do not
authenticate, bypass robots rules, enumerate ports, or crawl without bounds.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import re
import time
import urllib.parse
import urllib.robotparser
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup


USER_AGENT = "RavenCLI/0.5 (+passive research; contact owner before crawling)"
TIMEOUT = 15
MAX_BODY = 2 * 1024 * 1024


def _url(value: str) -> str:
    value = value.strip()
    return value if value.startswith(("http://", "https://")) else "https://" + value


def _fetch(url: str) -> requests.Response:
    response = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT, stream=True)
    if int(response.headers.get("content-length", "0") or 0) > MAX_BODY:
        response.close()
        raise ValueError("response exceeds the passive collection limit")
    return response


def web_robots(url: str) -> dict:
    target = _url(url)
    parsed = urllib.parse.urlparse(target)
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
    response = requests.get(robots_url, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT)
    parser = urllib.robotparser.RobotFileParser()
    parser.set_url(robots_url)
    parser.parse(response.text.splitlines() if response.ok else [])
    return {"url": robots_url, "status": response.status_code, "can_fetch": parser.can_fetch(USER_AGENT, target), "sitemaps": parser.site_maps() or []}


def web_page_profile(url: str) -> dict:
    target = _url(url)
    response = _fetch(target)
    raw = response.content[:MAX_BODY]
    content_type = response.headers.get("content-type", "")
    result = {"url": target, "status": response.status_code, "content_type": content_type, "headers": {key.lower(): value for key, value in response.headers.items() if key.lower() in {"server", "content-security-policy", "x-frame-options", "strict-transport-security", "last-modified"}}, "sha256": hashlib.sha256(raw).hexdigest(), "collected_at": datetime.now(timezone.utc).isoformat()}
    if "html" in content_type or raw.lstrip().startswith(b"<"):
        soup = BeautifulSoup(raw, "html.parser")
        result["title"] = soup.title.get_text(" ", strip=True) if soup.title else ""
        result["description"] = (soup.find("meta", attrs={"name": re.compile("description", re.I)}) or {}).get("content", "")
        result["canonical"] = (soup.find("link", rel=lambda value: value and "canonical" in value) or {}).get("href", "")
        result["text"] = soup.get_text(" ", strip=True)[:12000]
    return result


def web_extract_links(url: str, same_domain: bool = True, limit: int = 100) -> dict:
    profile = web_page_profile(url)
    target = profile["url"]
    response = requests.get(target, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT)
    soup = BeautifulSoup(response.text[:MAX_BODY], "html.parser")
    base = urllib.parse.urlparse(target).netloc
    links = []
    seen = set()
    for anchor in soup.find_all("a", href=True):
        link = urllib.parse.urljoin(target, anchor["href"].strip())
        parsed = urllib.parse.urlparse(link)
        normalized = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", parsed.query, ""))
        if parsed.scheme not in {"http", "https"} or (same_domain and parsed.netloc != base) or normalized in seen:
            continue
        seen.add(normalized)
        links.append({"url": normalized, "text": anchor.get_text(" ", strip=True)[:200]})
        if len(links) >= max(1, min(int(limit), 500)):
            break
    return {"source": target, "links": links, "count": len(links)}


def web_sitemap(url: str, limit: int = 200) -> dict:
    target = _url(url)
    parsed = urllib.parse.urlparse(target)
    candidates = [target if parsed.path.endswith(".xml") else f"{parsed.scheme}://{parsed.netloc}/sitemap.xml"]
    robots = web_robots(target)
    candidates.extend(robots.get("sitemaps", []))
    for sitemap in dict.fromkeys(candidates):
        try:
            response = requests.get(sitemap, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT)
            if not response.ok:
                continue
            root = ET.fromstring(response.content[:MAX_BODY])
            urls = [node.text for node in root.iter() if node.tag.endswith("loc") and node.text]
            return {"sitemap": sitemap, "urls": urls[:max(1, min(int(limit), 1000))], "count": len(urls)}
        except (requests.RequestException, ET.ParseError, ValueError):
            continue
    return {"error": "No readable sitemap found", "checked": list(dict.fromkeys(candidates))}


def geoint_geocode(place: str, country_code: str = "", limit: int = 5) -> dict:
    params = {"q": place, "format": "jsonv2", "limit": max(1, min(int(limit), 10)), "addressdetails": 1}
    if country_code:
        params["countrycodes"] = country_code.lower()
    response = requests.get("https://nominatim.openstreetmap.org/search", params=params, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT)
    return {"query": place, "results": response.json() if response.ok else [], "status": response.status_code, "source": "OpenStreetMap Nominatim"}


def geoint_reverse(latitude: float, longitude: float) -> dict:
    response = requests.get("https://nominatim.openstreetmap.org/reverse", params={"lat": latitude, "lon": longitude, "format": "jsonv2", "zoom": 18}, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT)
    return {"latitude": latitude, "longitude": longitude, "result": response.json() if response.ok else {}, "status": response.status_code, "source": "OpenStreetMap Nominatim"}


def register_passive_osint_tools(registry: dict) -> None:
    registry["web_robots"] = {"fn": web_robots, "description": "Read public robots.txt and sitemap declarations for a URL. Args: {url}"}
    registry["web_page_profile"] = {"fn": web_page_profile, "description": "Collect bounded public page metadata, text hash, headers and title. Args: {url}"}
    registry["web_extract_links"] = {"fn": web_extract_links, "description": "Extract bounded public links from one page. Args: {url, same_domain?: bool, limit?: int}"}
    registry["web_sitemap"] = {"fn": web_sitemap, "description": "Read a public sitemap with a strict URL limit. Args: {url, limit?: int}"}
    registry["geoint_geocode"] = {"fn": geoint_geocode, "description": "Geocode a public place name using OpenStreetMap. Args: {place, country_code?: str, limit?: int}"}
    registry["geoint_reverse"] = {"fn": geoint_reverse, "description": "Reverse geocode public coordinates using OpenStreetMap. Args: {latitude, longitude}"}
