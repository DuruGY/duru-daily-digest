#!/usr/bin/env node
/**
 * compress-with-ollama.mjs
 *
 * Compress RSS articles using local Ollama model (default qwen3.5:2b)
 * to reduce main-model token usage.
 *
 * Usage:
 *   node compress-with-ollama.mjs \
 *     --in ../out.json \
 *     --out ../out.compact.json \
 *     --model qwen3.5:2b \
 *     --ollama http://127.0.0.1:11434 \
 *     --limit 20 \
 *     --concurrency 6 \
 *     --strict
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function arg(name, fallback = null) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  return args[i + 1] ?? fallback;
}

const inPath = resolve(__dirname, arg('--in', '../out.json'));
const outPath = resolve(__dirname, arg('--out', '../out.compact.json'));
const model = arg('--model', 'qwen3.5:2b');
const ollama = arg('--ollama', 'http://127.0.0.1:11434').replace(/\/$/, '');
const limit = Number(arg('--limit', '20'));
const timeoutMs = Number(arg('--timeout', '45000'));
const concurrency = Math.max(1, Number(arg('--concurrency', '6')));
const strict = args.includes('--strict');

function clip(s, n) {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function fallbackCompress(a) {
  return {
    title: a.title,
    link: a.link,
    source: a.source,
    date: a.date,
    brief: clip(a.summary || a.title, 110),
    keywords: [],
    reason: 'fallback summary',
  };
}

async function ollamaSummarize(article) {
  const prompt = [
    '你是技术新闻压缩助手。请把输入文章压缩成 JSON（不要输出任何额外文本）。',
    '输出格式：{"brief":"...","keywords":["...","...","..."],"reason":"..."}',
    '要求：',
    '- brief: 70-120字中文，包含“问题/主题 -> 关键点 -> 结论”',
    '- keywords: 2-3个英文或中文标签',
    '- reason: 1句推荐理由（<=30字）',
    '',
    `标题: ${article.title}`,
    `来源: ${article.source}`,
    `时间: ${article.date}`,
    `链接: ${article.link}`,
    `摘要: ${clip(article.summary || '', 1200)}`,
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${ollama}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        format: 'json',
        options: { temperature: 0.2 },
      }),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    let text = (data.response || '').trim();
    let parsed;

    if (!text && data.thinking) {
      const thinking = String(data.thinking).trim();
      try {
        const tObj = JSON.parse(thinking);
        if (tObj && (tObj.brief || tObj.keywords || tObj.reason)) {
          parsed = tObj;
        } else {
          text = String(tObj.content || '').trim();
        }
      } catch {
        const m = thinking.match(/\{[\s\S]*\}/);
        if (m) text = m[0];
      }
    }

    if (!parsed) {
      try {
        parsed = JSON.parse(text);
      } catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('no-json');
        parsed = JSON.parse(m[0]);
      }
    }

    return {
      brief: clip(parsed.brief || '', 140),
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 3) : [],
      reason: clip(parsed.reason || '', 40),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runPool(items, workerFn, poolSize) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await workerFn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(poolSize, items.length) }, () => worker()));
  return results;
}

async function main() {
  const articles = JSON.parse(readFileSync(inPath, 'utf-8'));
  const selected = articles.slice(0, Math.max(1, limit));

  let ok = 0;
  let fallback = 0;

  const out = await runPool(
    selected,
    async (a) => {
      try {
        const c = await ollamaSummarize(a);
        ok += 1;
        return {
          title: a.title,
          link: a.link,
          source: a.source,
          date: a.date,
          brief: c.brief,
          keywords: c.keywords,
          reason: c.reason,
        };
      } catch (e) {
        process.stderr.write(`[compress-ollama] fallback: ${a.source} | ${a.title.slice(0, 60)} | ${e?.message || e}\n`);
        fallback += 1;
        return fallbackCompress(a);
      }
    },
    concurrency,
  );

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2));

  const meta = {
    model,
    totalInput: articles.length,
    processed: selected.length,
    ok,
    fallback,
    fallbackRate: selected.length ? Number((fallback / selected.length).toFixed(4)) : 0,
    concurrency,
    strict,
    output: outPath,
  };

  process.stderr.write(
    `[compress-ollama] processed=${selected.length} ok=${ok} fallback=${fallback} rate=${meta.fallbackRate} concurrency=${concurrency} model=${model}\n`,
  );
  process.stdout.write(JSON.stringify(meta, null, 2));

  if (strict && fallback > 0) {
    process.stderr.write('[compress-ollama] strict mode: fallback detected, exiting non-zero\n');
    process.exit(20);
  }
}

main().catch((err) => {
  process.stderr.write(`[compress-ollama] fatal: ${err.message}\n`);
  process.exit(1);
});
