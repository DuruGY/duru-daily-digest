#!/usr/bin/env node
/**
 * select-sources-rotation.mjs
 * Build today's rotating source subset for ai-daily-digest.
 *
 * Cycle: 6 days => 15/15/15/15/15/17 (total 92)
 *
 * Usage:
 *   node select-sources-rotation.mjs \
 *     --sources ../references/sources.json \
 *     --out ../references/sources.active.json \
 *     --tz Asia/Shanghai
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function arg(name, fallback = null) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  return args[i + 1] ?? fallback;
}

const sourcesPath = resolve(__dirname, arg('--sources', '../references/sources.json'));
const outPath = resolve(__dirname, arg('--out', '../references/sources.active.json'));
const tz = arg('--tz', 'Asia/Shanghai');

const sizes = [15, 15, 15, 15, 15, 17];

function getDateInTz(tzName) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tzName,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

function dayIndex(dateStr) {
  // dateStr: YYYY-MM-DD -> day number in UTC for stable modulo
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  return Math.floor(ms / 86400000);
}

function prefixSums(arr) {
  const out = [0];
  for (const n of arr) out.push(out[out.length - 1] + n);
  return out;
}

const allSources = JSON.parse(readFileSync(sourcesPath, 'utf-8'));
const totalExpected = sizes.reduce((a, b) => a + b, 0);
if (allSources.length !== totalExpected) {
  throw new Error(`Expected ${totalExpected} sources for 6-day rotation, got ${allSources.length}`);
}

const today = getDateInTz(tz);
const idx = dayIndex(today) % sizes.length;
const offsets = prefixSums(sizes);
const start = offsets[idx];
const end = offsets[idx + 1];
const active = allSources.slice(start, end);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(active, null, 2));

const meta = {
  date: today,
  timezone: tz,
  cycleDay: idx + 1,
  cycleSize: sizes.length,
  range: [start, end - 1],
  selected: active.length,
  total: allSources.length,
  output: outPath,
};

process.stderr.write(`[source-rotation] ${today} tz=${tz} cycleDay=${meta.cycleDay}/${meta.cycleSize} selected=${meta.selected} range=${start}-${end - 1}\n`);
process.stdout.write(JSON.stringify(meta, null, 2));
