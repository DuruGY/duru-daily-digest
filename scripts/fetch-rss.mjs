#!/usr/bin/env node
/**
 * fetch-rss.mjs — Concurrent RSS/Atom feed fetcher & parser
 * Zero dependencies, runs on Node.js 18+
 *
 * Usage: node fetch-rss.mjs [--hours 24] [--sources sources.json] [--exclude-seen-hours 0] [--no-history-write]
 * Output: JSON array of articles to stdout
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Config ---
const args = process.argv.slice(2);
const hoursArg = args.includes('--hours') ? parseInt(args[args.indexOf('--hours') + 1]) : 24;
const sourcesArg = args.includes('--sources') ? args[args.indexOf('--sources') + 1] : resolve(__dirname, '../references/sources.json');
const concurrency = args.includes('--concurrency') ? parseInt(args[args.indexOf('--concurrency') + 1]) : 15;
const timeoutMs = args.includes('--timeout') ? parseInt(args[args.indexOf('--timeout') + 1]) : 15000;
const maxRetries = args.includes('--retries') ? parseInt(args[args.indexOf('--retries') + 1]) : 2;
const healthFile = args.includes('--health-file') ? args[args.indexOf('--health-file') + 1] : resolve(__dirname, '../references/feed-health.json');
const historyFile = args.includes('--history-file') ? args[args.indexOf('--history-file') + 1] : resolve(__dirname, '../references/article-history.json');
const excludeSeenHours = args.includes('--exclude-seen-hours') ? parseInt(args[args.indexOf('--exclude-seen-hours') + 1]) : 0;
const ignoreCooldown = args.includes('--no-cooldown');
const noHistoryWrite = args.includes('--no-history-write');

const nowMs = Date.now();
const cutoff = nowMs - hoursArg * 3600 * 1000;
const excludeSeenMs = Math.max(0, excludeSeenHours) * 3600 * 1000;

// --- Load sources ---
const sources = JSON.parse(readFileSync(sourcesArg, 'utf-8'));

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return fallback;
  }
}

function saveJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function loadHealth(path) {
  const raw = loadJson(path, { updatedAt: nowMs, feeds: {} });
  return { updatedAt: raw.updatedAt || nowMs, feeds: raw.feeds || {} };
}

function saveHealth(path, health) {
  saveJson(path, { ...health, updatedAt: Date.now() });
}

function loadHistory(path) {
  const raw = loadJson(path, { updatedAt: nowMs, articles: {} });
  return { updatedAt: raw.updatedAt || nowMs, articles: raw.articles || {} };
}

function saveHistory(path, history) {
  saveJson(path, { ...history, updatedAt: Date.now() });
}

function nextCooldownMs(consecutiveFailures, status) {
  if (status === 404) return 24 * 3600 * 1000;
  if (consecutiveFailures <= 1) return 0;
  if (consecutiveFailures === 2) return 15 * 60 * 1000;
  if (consecutiveFailures === 3) return 60 * 60 * 1000;
  if (consecutiveFailures === 4) return 6 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

const health = loadHealth(healthFile);
const history = loadHistory(historyFile);

// --- XML helpers (zero-dependency) ---
function extractTag(xml, tag) {
  const patterns = [
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'),
    new RegExp(`<${tag}[^>]*/>`, 'i'),
  ];
  const m = xml.match(patterns[0]);
  return m ? m[1].trim() : '';
}

function extractAllBlocks(xml, tag) {
  const re = new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, 'gi');
  return xml.match(re) || [];
}

function extractLink(block) {
  const atomLink = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']alternate["']/i)
    || block.match(/<link[^>]+rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
    || block.match(/<link[^>]+href=["']([^"']+)["'][^>]*/i);
  if (atomLink) return atomLink[1];
  const rssLink = block.match(/<link>([^<]+)<\/link>/i);
  return rssLink ? rssLink[1].trim() : '';
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function parseDate(dateStr) {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    const dropParams = new Set([
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'ref_src', 'source'
    ]);

    [...u.searchParams.keys()].forEach((k) => {
      if (dropParams.has(k.toLowerCase())) u.searchParams.delete(k);
    });

    u.hash = '';
    if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    return u.toString();
  } catch {
    return raw.trim();
  }
}

function normalizeTitle(raw) {
  return (raw || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function articleKey(article) {
  return `${normalizeUrl(article.link)}||${normalizeTitle(article.title)}`;
}

function dedupeArticles(articles) {
  const seen = new Set();
  const deduped = [];

  for (const a of articles) {
    const key = articleKey(a);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...a, link: normalizeUrl(a.link) });
  }

  return deduped;
}

function filterSeenRecently(articles) {
  if (!excludeSeenMs) return { fresh: articles, filteredCount: 0 };

  const fresh = [];
  let filteredCount = 0;

  for (const a of articles) {
    const key = articleKey(a);
    const rec = history.articles[key];
    const seenRecently = rec?.lastShownAt && (nowMs - rec.lastShownAt < excludeSeenMs);

    if (seenRecently) {
      filteredCount++;
      continue;
    }
    fresh.push(a);
  }

  return { fresh, filteredCount };
}

function updateHistoryWithShown(articles) {
  for (const a of articles) {
    const key = articleKey(a);
    const rec = history.articles[key] || { firstShownAt: nowMs, timesShown: 0 };
    history.articles[key] = {
      ...rec,
      title: a.title,
      link: normalizeUrl(a.link),
      source: a.source,
      firstShownAt: rec.firstShownAt || nowMs,
      lastShownAt: nowMs,
      timesShown: (rec.timesShown || 0) + 1,
    };
  }
}

function pruneHistory(maxAgeMs = 30 * 24 * 3600 * 1000) {
  for (const [k, v] of Object.entries(history.articles)) {
    if (!v?.lastShownAt || nowMs - v.lastShownAt > maxAgeMs) {
      delete history.articles[k];
    }
  }
}

// --- Parse a single feed ---
function parseFeed(xml, source) {
  const articles = [];

  let entries = extractAllBlocks(xml, 'entry');
  let format = 'atom';

  if (entries.length === 0) {
    entries = extractAllBlocks(xml, 'item');
    format = 'rss';
  }

  for (const entry of entries) {
    const title = decodeEntities(extractTag(entry, 'title'));
    const link = extractLink(entry);
    const pubDate = extractTag(entry, format === 'atom' ? 'published' : 'pubDate') || extractTag(entry, 'updated') || extractTag(entry, 'dc:date');
    const summary = decodeEntities(extractTag(entry, 'summary') || extractTag(entry, 'description') || '').slice(0, 500);

    const timestamp = parseDate(pubDate);
    if (title && link && timestamp >= cutoff) {
      articles.push({ title, link, summary, timestamp, date: new Date(timestamp).toISOString(), source: source.name, sourceUrl: source.htmlUrl });
    }
  }

  return articles;
}

// --- Concurrent fetcher with pool ---
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ai-daily-digest/1.0 (+https://github.com/HarrisHan/ai-daily-digest)' },
    });

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }

    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function shouldRetry(err) {
  const msg = (err?.message || '').toLowerCase();
  const status = err?.status;

  if (status && status >= 500) return true;
  if (status && status >= 400 && status < 500) return false;
  if (msg.includes('aborted') || msg.includes('timeout') || msg.includes('fetch failed') || msg.includes('econn') || msg.includes('enet')) return true;
  return true;
}

async function fetchWithRetry(url, attempts) {
  let lastErr;

  for (let i = 0; i <= attempts; i++) {
    try {
      return await fetchWithTimeout(url, timeoutMs);
    } catch (err) {
      lastErr = err;
      if (i >= attempts || !shouldRetry(err)) break;
      const backoffMs = Math.min(4000, 400 * 2 ** i) + Math.floor(Math.random() * 250);
      await sleep(backoffMs);
    }
  }

  throw lastErr;
}

async function pool(tasks, concurrencyLimit) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrencyLimit, tasks.length) }, () => worker()));
  return results;
}

// --- Main ---
async function main() {
  const stats = { ok: 0, failed: 0, total: sources.length, skippedCooldown: 0, filteredSeen: 0 };
  const allArticles = [];

  const activeSources = sources.filter((source) => {
    if (ignoreCooldown) return true;
    const st = health.feeds[source.xmlUrl];
    if (!st?.cooldownUntil) return true;
    if (st.cooldownUntil <= nowMs) return true;
    stats.skippedCooldown++;
    return false;
  });

  process.stderr.write(`[fetch-rss] Fetching ${activeSources.length}/${sources.length} feeds (${hoursArg}h window, ${concurrency} concurrent, retries=${maxRetries}, skippedCooldown=${stats.skippedCooldown}, excludeSeenHours=${excludeSeenHours}, noHistoryWrite=${noHistoryWrite})...\n`);

  const tasks = activeSources.map((source) => async () => {
    const key = source.xmlUrl;
    const st = health.feeds[key] || { consecutiveFailures: 0, totalFailures: 0, totalSuccess: 0 };

    try {
      const xml = await fetchWithRetry(source.xmlUrl, maxRetries);
      const articles = parseFeed(xml, source);
      allArticles.push(...articles);
      stats.ok++;

      health.feeds[key] = {
        ...st,
        source: source.name,
        xmlUrl: source.xmlUrl,
        htmlUrl: source.htmlUrl,
        consecutiveFailures: 0,
        totalSuccess: (st.totalSuccess || 0) + 1,
        lastSuccessAt: Date.now(),
        lastError: null,
        lastStatus: null,
        cooldownUntil: 0,
      };
    } catch (err) {
      stats.failed++;
      const status = err?.status || null;
      const failures = (st.consecutiveFailures || 0) + 1;
      const cooldownMs = nextCooldownMs(failures, status);
      const cooldownUntil = cooldownMs ? Date.now() + cooldownMs : 0;

      health.feeds[key] = {
        ...st,
        source: source.name,
        xmlUrl: source.xmlUrl,
        htmlUrl: source.htmlUrl,
        consecutiveFailures: failures,
        totalFailures: (st.totalFailures || 0) + 1,
        lastFailureAt: Date.now(),
        lastError: err.message,
        lastStatus: status,
        cooldownUntil,
      };

      const cooldownMsg = cooldownUntil ? `, cooldown=${Math.round(cooldownMs / 60000)}m` : '';
      process.stderr.write(`[fetch-rss] ✗ ${source.name}: ${err.message}${cooldownMsg}\n`);
    }

    if ((stats.ok + stats.failed) % 20 === 0) {
      process.stderr.write(`[fetch-rss] Progress: ${stats.ok + stats.failed}/${activeSources.length} (${stats.ok} ok, ${stats.failed} failed)\n`);
    }
  });

  await pool(tasks, concurrency);

  allArticles.sort((a, b) => b.timestamp - a.timestamp);
  const beforeDedupe = allArticles.length;
  const deduped = dedupeArticles(allArticles);
  const removed = beforeDedupe - deduped.length;

  const { fresh, filteredCount } = filterSeenRecently(deduped);
  stats.filteredSeen = filteredCount;

  if (!noHistoryWrite) {
    updateHistoryWithShown(fresh);
    pruneHistory();
  }

  saveHealth(healthFile, health);
  if (!noHistoryWrite) saveHistory(historyFile, history);

  process.stderr.write(`[fetch-rss] Done: ${fresh.length} articles from ${stats.ok} feeds (${stats.failed} failed, deduped ${removed}, filteredSeen ${stats.filteredSeen}, skippedCooldown ${stats.skippedCooldown})\n`);
  process.stdout.write(JSON.stringify(fresh, null, 2));
}

main().catch((err) => {
  process.stderr.write(`[fetch-rss] Fatal: ${err.message}\n`);
  process.exit(1);
});
