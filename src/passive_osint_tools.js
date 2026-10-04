'use strict';
/**
 * Bounded passive web and public GEOINT helpers.
 * Port of Raven/passive_osint_tools.py
 *
 * These tools work on public URLs and user-supplied places only. They do not
 * authenticate, bypass robots rules, enumerate ports, or crawl without bounds.
 */

const crypto = require('crypto');
const cheerio = require('cheerio');

const USER_AGENT = 'RavenCLI/0.5 (+passive research; contact owner before crawling)';
const TIMEOUT_MS = 15000;
const MAX_BODY = 2 * 1024 * 1024;

function normalizeUrl(value) {
  value = value.trim();
  return /^https?:\/\//.test(value) ? value : `https://${value}`;
}

async function timedFetch(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, headers: { 'User-Agent': USER_AGENT, ...(opts.headers || {}) }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch with the passive collection size cap enforced on the actual bytes read. */
async function boundedFetch(url) {
  const response = await timedFetch(url);
  const declared = parseInt(response.headers.get('content-length') || '0', 10) || 0;
  if (declared > MAX_BODY) {
    try { await response.body.cancel(); } catch (e) { /* ignore */ }
    throw new Error('response exceeds the passive collection limit');
  }
  const buf = Buffer.from(await response.arrayBuffer()).subarray(0, MAX_BODY);
  return { response, raw: buf };
}

/** Minimal robots.txt parser mirroring urllib.robotparser semantics for one agent. */
function parseRobots(lines) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let lastWasAgent = false;
  for (let line of lines) {
    const hash = line.indexOf('#');
    if (hash !== -1) line = line.slice(0, hash);
    line = line.trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      if (current) current.rules.push({ allow: key === 'allow', path: value });
      lastWasAgent = false;
    } else if (key === 'sitemap') {
      sitemaps.push(value);
      lastWasAgent = false;
    }
  }
  return { groups, sitemaps };
}

function canFetch(parsed, userAgent, targetUrl) {
  const token = userAgent.split('/')[0].toLowerCase();
  let group = parsed.groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  if (!group) group = parsed.groups.find((g) => g.agents.includes('*'));
  if (!group) return true;
  const u = new URL(targetUrl);
  const target = `${u.pathname || '/'}${u.search}`;
  for (const rule of group.rules) {
    if (rule.path === '') {
      if (!rule.allow) continue; // empty Disallow allows everything
      return true;
    }
    if (target.startsWith(rule.path)) return rule.allow;
  }
  return true;
}

async function webRobots({ url }) {
  const target = normalizeUrl(url);
  const parsedUrl = new URL(target);
  const robotsUrl = `${parsedUrl.protocol}//${parsedUrl.host}/robots.txt`;
  const response = await timedFetch(robotsUrl);
  const text = response.ok ? await response.text() : '';
  const parsed = parseRobots(text.split(/\r?\n/));
  return {
    url: robotsUrl,
    status: response.status,
    can_fetch: canFetch(parsed, USER_AGENT, target),
    sitemaps: parsed.sitemaps,
  };
}

async function webPageProfile({ url }) {
  const target = normalizeUrl(url);
  const { response, raw } = await boundedFetch(target);
  const contentType = response.headers.get('content-type') || '';
  const keep = new Set(['server', 'content-security-policy', 'x-frame-options', 'strict-transport-security', 'last-modified']);
  const headers = {};
  response.headers.forEach((value, key) => {
    if (keep.has(key.toLowerCase())) headers[key.toLowerCase()] = value;
  });
  const result = {
    url: target,
    status: response.status,
    content_type: contentType,
    headers,
    sha256: crypto.createHash('sha256').update(raw).digest('hex'),
    collected_at: new Date().toISOString(),
  };
  if (contentType.includes('html') || raw.toString('utf8').trimStart().startsWith('<')) {
    const $ = cheerio.load(raw.toString('utf8'));
    result.title = $('title').first().text().replace(/\s+/g, ' ').trim();
    result.description = $('meta[name]').filter((i, el) => /description/i.test($(el).attr('name') || '')).first().attr('content') || '';
    result.canonical = $('link[rel~="canonical"]').first().attr('href') || '';
    result.text = $.root().text().replace(/\s+/g, ' ').trim().slice(0, 12000);
  }
  return result;
}

async function webExtractLinks({ url, same_domain = true, limit = 100 }) {
  const profile = await webPageProfile({ url });
  const target = profile.url;
  const response = await timedFetch(target);
  const html = (await response.text()).slice(0, MAX_BODY);
  const $ = cheerio.load(html);
  const base = new URL(target).host;
  const cap = Math.max(1, Math.min(parseInt(limit, 10) || 100, 500));
  const links = [];
  const seen = new Set();
  $('a[href]').each((i, el) => {
    if (links.length >= cap) return;
    let link;
    try {
      link = new URL(($(el).attr('href') || '').trim(), target);
    } catch (e) {
      return;
    }
    if (!['http:', 'https:'].includes(link.protocol)) return;
    if (same_domain && link.host !== base) return;
    const normalized = `${link.protocol}//${link.host}${link.pathname}${link.search}`;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    links.push({ url: normalized, text: $(el).text().replace(/\s+/g, ' ').trim().slice(0, 200) });
  });
  return { source: target, links, count: links.length };
}

async function webSitemap({ url, limit = 200 }) {
  const target = normalizeUrl(url);
  const parsed = new URL(target);
  const candidates = [parsed.pathname.endsWith('.xml') ? target : `${parsed.protocol}//${parsed.host}/sitemap.xml`];
  const robots = await webRobots({ url: target });
  candidates.push(...(robots.sitemaps || []));
  const unique = Array.from(new Set(candidates));
  const cap = Math.max(1, Math.min(parseInt(limit, 10) || 200, 1000));
  for (const sitemap of unique) {
    try {
      const response = await timedFetch(sitemap);
      if (!response.ok) continue;
      const body = (await response.text()).slice(0, MAX_BODY);
      const $ = cheerio.load(body, { xmlMode: true });
      const urls = [];
      $('loc').each((i, el) => {
        const t = $(el).text().trim();
        if (t) urls.push(t);
      });
      return { sitemap, urls: urls.slice(0, cap), count: urls.length };
    } catch (e) {
      continue;
    }
  }
  return { error: 'No readable sitemap found', checked: unique };
}

async function geointGeocode({ place, country_code = '', limit = 5 }) {
  const params = new URLSearchParams({
    q: place,
    format: 'jsonv2',
    limit: String(Math.max(1, Math.min(parseInt(limit, 10) || 5, 10))),
    addressdetails: '1',
  });
  if (country_code) params.set('countrycodes', country_code.toLowerCase());
  const response = await timedFetch(`https://nominatim.openstreetmap.org/search?${params}`);
  return {
    query: place,
    results: response.ok ? await response.json() : [],
    status: response.status,
    source: 'OpenStreetMap Nominatim',
  };
}

async function geointReverse({ latitude, longitude }) {
  const params = new URLSearchParams({ lat: String(latitude), lon: String(longitude), format: 'jsonv2', zoom: '18' });
  const response = await timedFetch(`https://nominatim.openstreetmap.org/reverse?${params}`);
  return {
    latitude,
    longitude,
    result: response.ok ? await response.json() : {},
    status: response.status,
    source: 'OpenStreetMap Nominatim',
  };
}

function registerPassiveOsintTools(registry) {
  registry.web_robots = { fn: webRobots, description: 'Read public robots.txt and sitemap declarations for a URL. Args: {url}' };
  registry.web_page_profile = { fn: webPageProfile, description: 'Collect bounded public page metadata, text hash, headers and title. Args: {url}' };
  registry.web_extract_links = { fn: webExtractLinks, description: 'Extract bounded public links from one page. Args: {url, same_domain?: bool, limit?: int}' };
  registry.web_sitemap = { fn: webSitemap, description: 'Read a public sitemap with a strict URL limit. Args: {url, limit?: int}' };
  registry.geoint_geocode = { fn: geointGeocode, description: 'Geocode a public place name using OpenStreetMap. Args: {place, country_code?: str, limit?: int}' };
  registry.geoint_reverse = { fn: geointReverse, description: 'Reverse geocode public coordinates using OpenStreetMap. Args: {latitude, longitude}' };
}

module.exports = {
  webRobots,
  webPageProfile,
  webExtractLinks,
  webSitemap,
  geointGeocode,
  geointReverse,
  registerPassiveOsintTools,
};
