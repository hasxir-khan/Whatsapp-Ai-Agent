#!/usr/bin/env node
// Keep the public definitions and every dashboard help link in lockstep.
import fs from 'node:fs';
import { definitions } from '../platform/reportMetrics.js';
const file = new URL('../README.md', import.meta.url),
  start = '<!-- dashboard-definitions -->',
  end = '<!-- /dashboard-definitions -->';
const table = [
  '| Metric / section | Definition |',
  '|---|---|',
  ...Object.values(definitions).map(([name, description]) => `| ${name} | ${description} |`),
].join('\n');
const text = fs.readFileSync(file, 'utf8'),
  next = text.replace(new RegExp(`${start}[\\s\\S]*?${end}`), `${start}\n${table}\n${end}`);
if (!text.includes(start) || !text.includes(end)) throw new Error('Missing dashboard definitions section');
if (process.argv.includes('--check')) {
  if (text !== next) throw new Error('Dashboard definitions need refreshing');
} else fs.writeFileSync(file, next);
