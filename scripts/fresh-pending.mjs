#!/usr/bin/env node
/**
 * fresh-pending.mjs — the rows of data/pipeline.md `## Pending` posted less than N days ago.
 *
 * Backs the "fresh pass" (`/career-ops pipeline --fresh-only`, defined in modes/_custom.md):
 * evaluate only these rows and leave the rest of the queue for the normal cadence. Read-only,
 * zero tokens, never writes pipeline.md.
 *
 * Usage:
 *   node scripts/fresh-pending.mjs [--days 2] [--json] [--urls-file FILE]
 *   node scripts/fresh-pending.mjs --selftest
 *
 * "Less than 2 days" means posted today or yesterday (calendar days, the same clock as
 * import-jobs.mjs --jobage). Rows without a `posted:` date are never fresh: their age is
 * unknown, so they stay in the backlog. --urls-file writes one URL per line, ready for
 * `node check-liveness.mjs --file`.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PIPELINE_PATH } from '../scan.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { ageDays } from './import-jobs.mjs';

/** @returns {{fresh: object[], pending: number, dated: number}} */
export function freshRows(text, days = 2, now = new Date()) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## Pending') || l.startsWith('## Pendientes'));
  if (start === -1) return { fresh: [], pending: 0, dated: 0 };
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end === -1) end = lines.length;

  const pending = lines.slice(start + 1, end).filter((l) => l.startsWith('- [ ] '));
  const fresh = [];
  let dated = 0;
  for (const line of pending) {
    const posted = /\| posted: (\d{4}-\d{2}-\d{2})/.exec(line)?.[1];
    const age = posted ? ageDays(posted, now) : null;
    if (age === null) continue;
    dated++;
    if (age >= days) continue; // a future date (age < 0) counts as fresh
    const [url, company = '', title = ''] = line.slice(6).split(' | ');
    const rank = /\| rank: ([\d.]+)\/5/.exec(line)?.[1];
    fresh.push({ url, company, title, posted, age, rank: rank === undefined ? null : Number(rank), line });
  }
  return { fresh, pending: pending.length, dated };
}

function selftest() {
  const now = new Date(2026, 8, 25, 7, 0); // 2026-09-25 07:00 local
  const text = ['# Pipeline', '', '## Pending', '',
    '- [ ] https://a/1 | A | Today | posted: 2026-09-25',
    '- [ ] https://a/2 | B | Yesterday | Remoto | posted: 2026-09-24 | rank: 4.2/5 — good',
    '- [ ] https://a/3 | C | Two days ago | posted: 2026-09-23',   // age 2: not "less than 2"
    '- [ ] https://a/4 | D | No date | rank: 1.0/5 — x',           // undated: never fresh
    '- [ ] https://a/5',                                            // hand-pasted, undated
    '- [!] https://a/6 — Error', '',
    '## Processed', '- [x] #1 | https://done/7 | Z | posted: 2026-09-25', ''].join('\n');
  const r = freshRows(text, 2, now);
  assert.deepEqual(r.fresh.map((x) => x.url), ['https://a/1', 'https://a/2']);
  assert.equal(r.pending, 5);          // `- [ ]` rows only; [!] and Processed are not counted
  assert.equal(r.dated, 3);
  assert.equal(r.fresh[1].rank, 4.2);
  assert.equal(r.fresh[1].company, 'B');
  assert.deepEqual(freshRows(text, 1, now).fresh.map((x) => x.url), ['https://a/1']); // --days 1 = today only
  assert.equal(freshRows('nothing here', 2, now).pending, 0);
  console.log('selftest ok');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) return selftest();
  const valueOf = (f) => { const i = args.indexOf(f); return i === -1 ? undefined : args[i + 1]; };
  const days = valueOf('--days') === undefined ? 2 : parseInt(valueOf('--days'), 10);
  if (!Number.isInteger(days) || days < 1) {
    console.error(`--days expects a positive number, got "${valueOf('--days')}"`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(PIPELINE_PATH)) { console.error(`${PIPELINE_PATH} not found`); process.exitCode = 1; return; }

  const { fresh, pending, dated } = freshRows(readFileSync(PIPELINE_PATH, 'utf8'), days);
  const backlog = { pending_total: pending, fresh: fresh.length, older: dated - fresh.length, undated: pending - dated };
  if (valueOf('--urls-file')) writeFileSync(valueOf('--urls-file'), fresh.map((f) => f.url).join('\n') + (fresh.length ? '\n' : ''));

  if (args.includes('--json')) {
    console.log(JSON.stringify({ days, ...backlog, rows: fresh.map(({ line, ...row }) => row) }, null, 2));
    return;
  }
  console.log(`fresh (posted < ${days} days ago): ${fresh.length} of ${pending} pending`
    + ` | backlog left alone: ${backlog.older} older + ${backlog.undated} undated`);
  for (const f of fresh) {
    console.log(`  ${f.posted} (${f.age}d)${f.rank === null ? '' : ` rank ${f.rank.toFixed(1)}`}  ${f.company} | ${f.title}\n      ${f.url}`);
  }
}

if (isMainModule(import.meta.url)) main();
