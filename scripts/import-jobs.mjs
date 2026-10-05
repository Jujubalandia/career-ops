#!/usr/bin/env node
/**
 * import-jobs.mjs — queue job-board results (Gupy, Vagas.com, LinkedIn) into
 * data/pipeline.md.
 *
 * Only populates the queue. It never runs `/career-ops pipeline` and never writes
 * the tracker. Row format, dedup and locking come straight from scan.mjs
 * (formatPipelineOffer / loadDedupSnapshot / appendToPipeline), so an imported row
 * is byte-identical in shape to a scanner row: `- [ ] {url} | {company} | {title} |
 * {location} | posted: YYYY-MM-DD | note: {source}`. `- [ ]` is the same initial
 * "pending" state scan.mjs writes.
 *
 * Usage:
 *   node scripts/import-jobs.mjs [--source gupy|vagas|linkedin] [--dry-run] [--pages N]
 *        [--remote remote,hybrid,onsite (gupy, linkedin)] [--city "São Paulo"]
 *        [--jobage DAYS] [--verify]
 *        [--keep-anywhere REGEX] [--include REGEX] [--exclude REGEX] "query" ...
 *   node scripts/import-jobs.mjs --sort-only [--dry-run]
 *   node scripts/import-jobs.mjs --selftest
 *
 * After every real import, `## Pending` is re-sorted newest-first by `posted:` (see
 * sortPending: hand-pasted rows stay on top, undated rows go last). --sort-only does just
 * that, for writers that append unsorted (scan.mjs).
 *
 * --jobage N  keep cards posted today or up to N calendar days ago (undated cards pass).
 *             Done here, not in the CLIs: gupy's own --jobage runs after it slices a
 *             page, and a short page would end the pagination loop early.
 * --verify    liveness-check the new URLs (check-liveness.mjs, zero tokens) and drop the
 *             dead ones (expired, or no apply control) before writing, the same rule as
 *             `scan.mjs --verify`. Fail-open: no verdicts from the checker, nothing dropped.
 *
 * JOB_SKILLS_DIR (default ~/ai-job-search/.agents/skills) is where the search skills live;
 * GUPY_CLI / VAGAS_CLI / LINKEDIN_CLI override the path to each skill's cli.ts.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { PIPELINE_PATH, appendToPipeline, atomicWriteFile, companyRoleDedupKey, formatPipelineOffer, loadDedupSnapshot, normalizeUrlForDedup } from '../scan.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { withPipelineLock } from '../pipeline-lock.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LIVENESS = path.join(ROOT, 'check-liveness.mjs');
const SKILLS = process.env.JOB_SKILLS_DIR || path.join(homedir(), 'ai-job-search/.agents/skills');
const REMOTE_RE = /home ?office|remot/i;
const COUNTRY = process.env.JOBS_COUNTRY || 'Brazil'; // LinkedIn place string

/**
 * Both CLIs print {results:[{id,title,company,location,date,url}]}.
 * gupy filters remote/hybrid/onsite server-side (--remote). vagas has no such flag
 * (an unknown --remote would be silently ignored), so remote is detected client-side
 * and normalized to location "Remoto", the value gupy uses, so keepCard treats both alike.
 */
const SOURCES = {
  gupy: {
    cli: process.env.GUPY_CLI || `${SKILLS}/gupy-search/cli/src/cli.ts`,
    note: 'gupy',
    pageSize: 10,
    modes: true, // --remote modes are passed to the CLI
    delayMs: 0,
    args: (q, p, mode) => ['-q', q, '--remote', mode, '--page', String(p)],
    normalize: (c) => c,
  },
  linkedin: {
    cli: process.env.LINKEDIN_CLI || `${SKILLS}/linkedin-search/cli/src/cli.ts`,
    note: 'linkedin',
    pageSize: 10,
    modes: true,
    delayMs: 1500, // ToS forbids automated access; personal use, keep volume low
    // --location is required. Remote: the whole country. Hybrid/onsite: the --city, so
    // the 10 results per page are not spent on other cities.
    args: (q, p, mode, { city } = {}) => ['-q', q, '--remote', mode, '--page', String(p),
      '-l', mode === 'remote' || !city ? COUNTRY : `${city}, ${COUNTRY}`],
    // Country subdomains (br., www.) would break URL dedup: canonicalize to the id.
    // Remote is server-side filtered, so mark it "Remoto" like gupy does, except when
    // the title itself says hybrid/on-site (the LinkedIn filter is not strict).
    normalize: (c, mode) => ({
      ...c,
      url: `https://www.linkedin.com/jobs/view/${c.id}`,
      location: mode === 'remote' && !/h[ií]brido|hybrid|presencial|on-?site/i.test(c.title ?? '') ? 'Remoto' : c.location,
    }),
  },
  vagas: {
    cli: process.env.VAGAS_CLI || `${SKILLS}/vagas-com-search/cli/src/cli.ts`,
    note: 'vagas',
    pageSize: null, // unknown: stop on an empty or repeated page
    modes: false,
    delayMs: 1000, // robots.txt blocks Anthropic crawlers; personal use, keep volume low
    args: (q, p) => ['-q', q, '--page', String(p)],
    normalize: (c) => (REMOTE_RE.test(`${c.location ?? ''} ${c.title ?? ''}`) ? { ...c, location: 'Remoto' } : c),
  },
};

const sleep = (ms) => ms > 0 && Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** One search page → array of {id,title,company,location,date,url}. */
function searchPage(source, query, page, mode, ctx) {
  // argv array, no shell: a query with quotes or `$()` cannot inject anything.
  const r = spawnSync('bun', ['run', source.cli, 'search', ...source.args(query, page, mode, ctx), '--format', 'json'],
    { encoding: 'utf8' });
  if (r.error) throw new Error(`cannot run bun: ${r.error.message}`);
  if (r.status !== 0) throw new Error((r.stderr || `exit ${r.status}`).trim());
  return (JSON.parse(r.stdout).results ?? []).map((c) => source.normalize(c, mode));
}

/** ISO string (gupy) or dd/mm/yyyy (vagas) → epoch ms, or NaN. */
export function parseCardDate(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s ?? '');
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : Date.parse(s ?? '');
}

/**
 * Gupy's `company` is the career-page headline, not always a company name
 * ("VENHA SER #SANGUELARANJA 🧡🚀", "Recrutamento para área de tecnologia…").
 * Keep it when short and clean; otherwise fall back to the tenant subdomain
 * (fcamara.gupy.io → "fcamara"). '?' = unknown employer (AGENTS.md convention).
 */
export function companyOf(card) {
  const name = (card.company || '').trim();
  if (name && name.length <= 35 && !/[#\p{Extended_Pictographic}]/u.test(name)) return name;
  try {
    const host = new URL(card.url).hostname; // only gupy has a per-company subdomain
    return host.endsWith('.gupy.io') ? host.split('.')[0] : (name || '?');
  } catch { return name || '?'; }
}

/** Local calendar day of a card date. Date-only strings are taken as written (no UTC shift). */
function localDay(s) {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s ?? '');
  if (m) return { y: +m[3], m: +m[2], d: +m[1] };
  const ms = Date.parse(s ?? '');
  if (!Number.isFinite(ms)) return null;
  const t = new Date(ms);
  return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() };
}

/** Whole calendar days from the card's day to `now` (local), or null when undated. */
export function ageDays(s, now = new Date()) {
  const c = localDay(s);
  if (!c) return null;
  const utc = ({ y, m, d }) => Date.UTC(y, m - 1, d);
  return Math.round((utc({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() }) - utc(c)) / 86400000);
}

/** No --jobage, an undated card or a future date all pass. */
export function withinJobage(card, days, now = new Date()) {
  const age = days ? ageDays(card.date, now) : null;
  return age === null || age <= days;
}

/**
 * Order the `## Pending` section newest-first by its `posted: YYYY-MM-DD` segment, so the
 * freshest postings sit at the top of the queue (/career-ops pipeline walks it top-down).
 *   1. rows pasted by hand (a bare `- [ ] url`, no ` | ` columns) stay on top: the user put
 *      them there on purpose and a missing date says nothing about their age;
 *   2. dated rows, newest first;
 *   3. rows with no date (some providers expose none), at the bottom, in their old order.
 * The sort is stable, so equal dates keep their existing order. Blank lines inside Pending
 * (leftovers of each append) are dropped: one blank after the header, one before the next
 * section. Everything outside Pending is returned byte-for-byte.
 */
export function sortPending(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## Pending') || l.startsWith('## Pendientes'));
  if (start === -1) return text;
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end === -1) end = lines.length;

  const rank = (l) => {
    if (l.startsWith('- [ ] ') && !l.includes(' | ')) return { g: 0 };
    const d = /\| posted: (\d{4}-\d{2}-\d{2})/.exec(l)?.[1];
    return d ? { g: 1, d } : { g: 2 };
  };
  const items = lines.slice(start + 1, end).filter((l) => l.trim() !== '')
    .map((l, i) => ({ l, i, ...rank(l) }))
    .sort((a, b) => a.g - b.g || (a.g === 1 && a.d !== b.d ? (a.d < b.d ? 1 : -1) : 0) || a.i - b.i);

  const tail = lines.slice(end);
  return [...lines.slice(0, start + 1), '', ...items.map((x) => x.l), ...(tail.length ? ['', ...tail] : [''])].join('\n');
}

/**
 * Apply sortPending to data/pipeline.md under the pipeline lock, with an atomic write. Refuses
 * to write if the set of non-blank lines would change (a sort must only move rows).
 * @returns {Promise<{changed: boolean, rows: number}>}
 */
export async function sortPipeline({ dryRun = false, pipelinePath = PIPELINE_PATH } = {}) {
  if (!existsSync(pipelinePath)) return { changed: false, rows: 0 };
  return withPipelineLock(pipelinePath, () => {
    const before = readFileSync(pipelinePath, 'utf8');
    const after = sortPending(before);
    const bag = (t) => t.split('\n').filter((l) => l.trim() !== '').sort().join('\n');
    if (bag(before) !== bag(after)) throw new Error('sort would change the set of lines; nothing written');
    const rows = before.split('\n').filter((l) => l.startsWith('- [ ] ')).length;
    if (after === before) return { changed: false, rows };
    if (!dryRun) atomicWriteFile(pipelinePath, after);
    return { changed: true, rows };
  });
}

/**
 * Age-discard volume log (logs/import-age.tsv, gitignored, apart from daily-scan.log): one
 * row per run, so the effect of --jobage can be tracked over time. `undated_kept` counts
 * cards that passed only because they carry no date. scan.mjs keeps its own equivalent in
 * data/scan-runs.tsv (filtered_posting_age, filtered_posted_date).
 */
export const AGE_LOG_HEADER = ['timestamp', 'source', 'jobage_days', 'results', 'unique',
  'dropped_age', 'undated_kept', 'new', 'dry_run'].join('\t');

export function ageLogRow({ ts = new Date(), source, jobage, results, unique, droppedAge, undated, fresh, dryRun }) {
  return [ts.toISOString(), source, jobage, results, unique, droppedAge, undated, fresh, dryRun ? 1 : 0].join('\t');
}

function writeAgeLog(row) {
  try { // a log problem must never fail an import
    const file = path.join(ROOT, 'logs', 'import-age.tsv');
    mkdirSync(path.dirname(file), { recursive: true });
    if (!existsSync(file)) appendFileSync(file, AGE_LOG_HEADER + '\n');
    appendFileSync(file, row + '\n');
  } catch (err) {
    console.error(`  age log not written: ${err.message}`);
  }
}

/**
 * check-liveness.mjs prints`✅ active   (api) URL` per URL, then an indented reason line
 * for anything not active → Map(url → {verdict, reason}).
 */
export function parseVerdicts(out) {
  const verdicts = new Map();
  let last = null;
  for (const line of out.split('\n')) {
    const m = /^\S+\s+(active|expired|uncertain)\s+(?:\(api\)\s+)?(https?:\/\/\S+)\s*$/.exec(line);
    if (m) verdicts.set(m[2], (last = { verdict: m[1], reason: '' }));
    else if (last && /^\s+\S/.test(line)) { last.reason = line.trim(); last = null; }
  }
  return verdicts;
}

/**
 * Same rule as scan.mjs --verify: a posting is dead when the checker says `expired`, or
 * `uncertain` because the page has no apply control (a Gupy job that no longer exists
 * loads a page like that). Other `uncertain` (timeout, DNS, 5xx) is transient and stays.
 */
export const isDead = ({ verdict, reason }) =>
  verdict === 'expired' || (verdict === 'uncertain' && /no visible apply control/i.test(reason));

/** Drop dead postings before writing. Fail-open: no verdicts at all (Chromium missing) drops nothing. */
export function dropExpired(offers) {
  if (offers.length === 0) return { kept: offers, expired: [] };
  const dir = mkdtempSync(path.join(tmpdir(), 'import-jobs-'));
  try {
    const file = path.join(dir, 'urls.txt');
    writeFileSync(file, offers.map((o) => o.url).join('\n') + '\n');
    const r = spawnSync(process.execPath, [LIVENESS, '--file', file, '--no-fallback', '--throttle'],
      { encoding: 'utf8', cwd: ROOT, timeout: 30 * 60 * 1000 });
    const verdicts = parseVerdicts(r.stdout ?? '');
    if (verdicts.size === 0) {
      console.error(`  liveness: no verdicts (${(r.stderr || r.error?.message || 'no output').trim().slice(0, 120)}); nothing dropped`);
      return { kept: offers, expired: [] };
    }
    const dead = (o) => verdicts.has(o.url) && isDead(verdicts.get(o.url));
    return { kept: offers.filter((o) => !dead(o)), expired: offers.filter(dead) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Gupy card → the offer shape scan.mjs providers emit (postedAt is epoch ms). */
export function toOffer(card, note = 'gupy') {
  const postedAt = parseCardDate(card.date);
  return {
    url: card.url,
    company: companyOf(card),
    title: card.title,
    location: card.location || '',
    postedAt: Number.isFinite(postedAt) ? postedAt : undefined,
    note,
  };
}

/** Merge cards from all queries, one per Gupy id (first occurrence wins). */
export function mergeById(cards) {
  const byId = new Map();
  for (const c of cards) if (c?.id && c.url && !byId.has(String(c.id))) byId.set(String(c.id), c);
  return [...byId.values()];
}

const fold = (s) => (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Title/city filter → null (keep) | 'exclude' | 'city'. `exclude` (regex on the
 * title) always wins. `city` only bites on hybrid/on-site cards: remote cards have
 * location "Remoto" and pass. `keepAnywhere` (regex on the title) passes the city
 * check. A card with no location is matched on its title too ("... - São Paulo").
 */
export function keepCard(card, { city, exclude, include, keepAnywhere } = {}) {
  const title = card.title ?? '';
  if (exclude?.test(title) || (include && !include.test(title))) return 'exclude';
  if (city && card.location !== 'Remoto' && !keepAnywhere?.test(title)
      // City part only ("São José dos Campos, São Paulo" must not match city "São Paulo").
      && !fold(`${(card.location ?? '').split(',')[0]} ${title}`).includes(fold(city))) return 'city';
  return null;
}

/** Same company+title+location under different ids is one role posted several times. */
export function collapseRepeats(cards) {
  const byKey = new Map();
  for (const c of cards) {
    const key = [companyOf(c), c.title, c.location].map(fold).join('|');
    if (!byKey.has(key)) byKey.set(key, c);
  }
  return [...byKey.values()];
}

function selftest() {
  const a = { id: '1', title: 'Engenheiro de IA', company: 'Acme', location: 'Remoto', date: '2026-09-20T12:00:00.000Z', url: 'https://acme.gupy.io/jobs/1' };
  const merged = mergeById([a, { ...a, title: 'dup' }, { id: '2', url: 'https://b.gupy.io/jobs/2', title: 'X', company: null, date: null }]);
  assert.equal(merged.length, 2);
  assert.equal(formatPipelineOffer(toOffer(merged[0])),
    '- [ ] https://acme.gupy.io/jobs/1 | Acme | Engenheiro de IA | Remoto | posted: 2026-09-20 | note: gupy');
  assert.equal(formatPipelineOffer(toOffer(merged[1])), '- [ ] https://b.gupy.io/jobs/2 | b | X | note: gupy');
  assert.equal(companyOf({ company: 'VENHA SER #SANGUELARANJA 🧡🚀', url: 'https://fcamara.gupy.io/job/x' }), 'fcamara');
  assert.equal(companyOf({ company: 'Venha fazer parte do Corporativo da Hospital Care', url: 'https://hospitalcare.gupy.io/job/x' }), 'hospitalcare');
  assert.equal(companyOf({ company: 'PagBank', url: 'https://pagseguro.gupy.io/job/x' }), 'PagBank');
  const ex = /Analista(?!.*Governan)|\bQA\b|Pleno/i;
  const opt = { city: 'São Paulo', exclude: ex, keepAnywhere: /governan|governance/i };
  const c = (title, location) => ({ title, location });
  assert.equal(keepCard(c('Engenheiro de IA Sr', 'Remoto'), opt), null);            // remote passes city
  assert.equal(keepCard(c('Engenheiro de IA', 'Sao Paulo, São Paulo'), opt), null);  // accent-insensitive
  assert.equal(keepCard(c('Engenheiro de IA', 'Belo Horizonte, Minas Gerais'), opt), 'city');
  assert.equal(keepCard(c('Engenheiro de IA', 'São José dos Campos, São Paulo'), opt), 'city'); // state ≠ city
  assert.equal(keepCard(c('Especialista em Governança de IA', 'Goiânia, Goiás'), opt), null); // governance anywhere
  assert.equal(keepCard(c('Analista de Governança e Conformidade de IA', 'Belo Horizonte'), opt), null);
  assert.equal(keepCard(c('Analista de Dados', 'São Paulo, São Paulo'), opt), 'exclude');
  const inc = { ...opt, include: /\b(IA|AI|GenAI|LLM)\b|Intelig[eê]ncia Artificial|\bdata\b/iu };
  assert.equal(keepCard(c('Especialista em Inteligência Artificial', 'São Paulo / SP'), inc), null);
  assert.equal(keepCard(c('Gerente de Marketing', 'São Paulo / SP'), inc), 'exclude'); // include must match
  assert.equal(keepCard(c('Consultor AI Engineer - São Paulo (Capital)', null), opt), null); // title carries city
  assert.equal(collapseRepeats([{ ...a, id: '1' }, { ...a, id: '9' }, { ...a, id: '3', title: 'Other' }]).length, 2);
  // vagas.com.br: dd/mm/yyyy dates, no tenant subdomain, remote normalized client-side
  const v = { id: '7', title: 'Engenheiro de IA', company: 'Acme', location: 'Home Office', date: '20/09/2026', url: 'https://www.vagas.com.br/vagas/v7/x' };
  assert.equal(formatPipelineOffer(toOffer(SOURCES.vagas.normalize(v), 'vagas')),
    '- [ ] https://www.vagas.com.br/vagas/v7/x | Acme | Engenheiro de IA | Remoto | posted: 2026-09-20 | note: vagas');
  assert.equal(companyOf({ company: null, url: v.url }), '?');
  assert.equal(SOURCES.vagas.normalize({ ...v, location: 'São Paulo - SP' }).location, 'São Paulo - SP');
  assert.equal(SOURCES.vagas.normalize({ ...v, location: 'São Paulo - SP', title: 'AI Engineer (Remoto)' }).location, 'Remoto');
  // --jobage: calendar days, date-only strings not shifted by UTC, undated cards pass
  const now = new Date(2026, 8, 25, 7, 0); // 2026-09-25 07:00 local
  assert.equal(ageDays('2026-09-25', now), 0);
  assert.equal(ageDays('2026-09-24', now), 1);
  assert.equal(ageDays('24/09/2026', now), 1);
  assert.equal(ageDays('2026-09-23T15:00:00.000Z', now), 2);
  assert.equal(ageDays(null, now), null);
  assert.equal(withinJobage({ date: '2026-09-23' }, 2, now), true);   // border: N days ago
  assert.equal(withinJobage({ date: '2026-09-22' }, 2, now), false);
  assert.equal(withinJobage({ date: null }, 2, now), true);           // undated passes
  assert.equal(withinJobage({ date: '2020-01-01' }, 0, now), true);   // no --jobage: nothing filtered
  // sortPending: hand-pasted first, dated newest-first (stable), undated last, blanks compacted,
  // other sections untouched
  const q = ['# Pipeline', '', '## Pending', '',
    '- [ ] https://a/1 | A | t | posted: 2026-09-20', '',
    '- [ ] https://a/2 | A | t | posted: 2026-09-25 | note: x',
    '- [ ] https://a/3 | A | t | rank: 1.0/5 — no date',
    '- [ ] https://a/4 | A | t | posted: 2026-09-25',
    '- [ ] https://hand-pasted/5',
    '- [!] https://err/6 — Error: login required', '',
    '## Processed', '- [x] #1 | https://done/7 | Z | t | 4.0/5 | PDF ✅', ''].join('\n');
  assert.equal(sortPending(q), ['# Pipeline', '', '## Pending', '',
    '- [ ] https://hand-pasted/5',
    '- [ ] https://a/2 | A | t | posted: 2026-09-25 | note: x',
    '- [ ] https://a/4 | A | t | posted: 2026-09-25',   // tie keeps original order (a/2 before a/4)
    '- [ ] https://a/1 | A | t | posted: 2026-09-20',
    '- [ ] https://a/3 | A | t | rank: 1.0/5 — no date',
    '- [!] https://err/6 — Error: login required', '',
    '## Processed', '- [x] #1 | https://done/7 | Z | t | 4.0/5 | PDF ✅', ''].join('\n'));
  assert.equal(sortPending(sortPending(q)), sortPending(q));   // idempotent
  assert.equal(sortPending('no pending section here\n'), 'no pending section here\n');
  // age log row: fixed column order, dry run flagged
  assert.equal(ageLogRow({ ts: new Date('2026-09-25T10:00:00.000Z'), source: 'gupy', jobage: 3, results: 74, unique: 67,
    droppedAge: 58, undated: 2, fresh: 4, dryRun: true }),
    '2026-09-25T10:00:00.000Z\tgupy\t3\t74\t67\t58\t2\t4\t1');
  assert.equal(AGE_LOG_HEADER.split('\t').length, ageLogRow({ source: 's', jobage: 0, results: 0, unique: 0, droppedAge: 0, undated: 0, fresh: 0 }).split('\t').length);
  // --verify: parse check-liveness output; expired dropped, uncertain kept
  const out = 'Checking 4 URL(s)...\n\n✅ active     (api) https://a.io/1\n❌ expired          https://b.io/2?x=1\n           HTTP 404\n'
    + '⚠️ uncertain        https://c.io/3\n           navigation timeout\n'
    + '⚠️ uncertain        https://d.io/4\n           content present but no visible apply control found\n\nResults: 1 active';
  const vd = parseVerdicts(out);
  assert.deepEqual([...vd.keys()], ['https://a.io/1', 'https://b.io/2?x=1', 'https://c.io/3', 'https://d.io/4']);
  assert.deepEqual([...vd.values()].map(isDead), [false, true, false, true]); // expired + no-apply dropped, timeout kept
  assert.equal(parseVerdicts('Fatal: chromium missing').size, 0);
  // linkedin: canonical url (country subdomain dropped), remote marked, --location per mode
  const li = { id: '123', title: 'AI Engineer', company: 'Acme', location: 'Brazil', date: '2026-09-20', url: 'https://br.linkedin.com/jobs/view/ai-engineer-at-acme-123' };
  const lr = SOURCES.linkedin.normalize(li, 'remote');
  assert.equal(lr.url, 'https://www.linkedin.com/jobs/view/123');
  assert.equal(formatPipelineOffer(toOffer(lr, 'linkedin')),
    '- [ ] https://www.linkedin.com/jobs/view/123 | Acme | AI Engineer | Remoto | posted: 2026-09-20 | note: linkedin');
  assert.equal(SOURCES.linkedin.normalize(li, 'hybrid').location, 'Brazil');
  assert.equal(SOURCES.linkedin.normalize({ ...li, title: 'AI Engineer Senior / Híbrido- BH' }, 'remote').location, 'Brazil'); // not really remote
  assert.equal(companyRoleDedupKey('Nubank', 'AI Risk Management Senior Specialist'), companyRoleDedupKey(' nubank ', 'AI Risk Management Senior Specialist'));
  assert.deepEqual(SOURCES.linkedin.args('q', 1, 'remote', { city: 'São Paulo' }).slice(-2), ['-l', 'Brazil']);
  assert.deepEqual(SOURCES.linkedin.args('q', 1, 'hybrid', { city: 'São Paulo' }).slice(-2), ['-l', 'São Paulo, Brazil']);
  console.log('selftest ok');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) return selftest();

  const dryRun = args.includes('--dry-run');
  const verify = args.includes('--verify');
  if (args.includes('--sort-only')) { // final step of the daily run: scan.mjs appends unsorted rows
    const r = await sortPipeline({ dryRun });
    console.log(r.changed ? `Pending re-sorted newest-first (${r.rows} rows)${dryRun ? ' (dry run: not written)' : ''}` : 'Pending already newest-first');
    return;
  }
  const valueOf = (flag) => { const i = args.indexOf(flag); return i === -1 ? undefined : args[i + 1]; };
  const pages = Math.max(1, parseInt(valueOf('--pages'), 10) || 1);
  const jobage = valueOf('--jobage') === undefined ? 0 : parseInt(valueOf('--jobage'), 10);
  if (!Number.isInteger(jobage) || jobage < 0) {
    console.error(`--jobage expects a non-negative number of days, got "${valueOf('--jobage')}"`);
    process.exitCode = 1;
    return;
  }
  const sourceName = valueOf('--source') ?? 'gupy';
  const source = SOURCES[sourceName];
  // Only gupy takes --remote modes; vagas has no such flag, so it runs once per query.
  const modes = source?.modes ? (valueOf('--remote') ?? 'remote').split(',') : [null]; // remote,hybrid,onsite
  const rx = (flag) => (valueOf(flag) ? new RegExp(valueOf(flag), 'iu') : undefined);
  const filter = { city: valueOf('--city'), exclude: rx('--exclude'), include: rx('--include'), keepAnywhere: rx('--keep-anywhere') };
  // A repeated value flag would leave its second value behind as a bogus query.
  const VALUE_FLAGS = ['--pages', '--jobage', '--remote', '--city', '--exclude', '--include', '--keep-anywhere', '--source'];
  const twice = VALUE_FLAGS.find((f) => args.filter((a) => a === f).length > 1);
  if (twice) {
    console.error(`${twice} was given more than once`);
    process.exitCode = 1;
    return;
  }
  const flagValues = new Set(VALUE_FLAGS.map(valueOf).filter(Boolean));
  const queries = args.filter((a) => !a.startsWith('--') && !flagValues.has(a));
  if (!source || queries.length === 0 || modes.some((m) => m !== null && !['remote', 'hybrid', 'onsite'].includes(m))) {
    console.error('Usage: node scripts/import-jobs.mjs [--source gupy|vagas|linkedin] [--dry-run] [--pages N]\n'
      + '         [--remote remote,hybrid,onsite (gupy, linkedin)] [--city "São Paulo"] [--jobage DAYS] [--verify]\n'
      + '         [--keep-anywhere REGEX] [--include REGEX] [--exclude REGEX] "query" ...');
    process.exitCode = 1;
    return;
  }

  const cards = [];
  let failed = 0;
  let firstRequest = true;
  for (const mode of modes) {
    for (const q of queries) {
      const tag = mode ?? sourceName;
      const seenIds = new Set();
      let n = 0;
      try {
        for (let p = 1; p <= pages; p++) {
          if (!firstRequest) sleep(source.delayMs);
          firstRequest = false;
          const got = searchPage(source, q, p, mode, { city: filter.city });
          const fresh = got.filter((c) => !seenIds.has(c.id));
          fresh.forEach((c) => seenIds.add(c.id));
          cards.push(...fresh);
          n += fresh.length;
          // last page: empty, a repeat of a page already seen, or short (gupy: 10/page)
          if (fresh.length === 0 || (source.pageSize && got.length < source.pageSize)) break;
        }
        if (n) console.log(`  [${tag}] "${q}": ${n} result(s)`);
      } catch (err) {
        failed++;
        console.error(`  [${tag}] "${q}": FAILED — ${err.message}`);
      }
    }
  }

  const byId = mergeById(cards);
  const dropped = { exclude: 0, city: 0, age: 0 };
  let undated = 0; // no date → cannot be judged old → kept (and counted, so it can be reviewed)
  const kept = byId.filter((c) => {
    if (jobage && ageDays(c.date) === null) undated++;
    if (!withinJobage(c, jobage)) { dropped.age++; return false; }
    const why = keepCard(c, filter);
    if (why) dropped[why]++;
    return !why;
  });
  const unique = collapseRepeats(kept);
  // scan-history.tsv + pipeline.md + applications.md, same as scan.mjs. Two checks:
  // the normalized URL, and company+role. The second catches the same job under another
  // source's URL (a LinkedIn posting already queued from Gupy, or already applied via
  // Ashby). Both sets grow as we go so two cards cannot both be queued. Unknown
  // employers ('?', 'Confidencial') skip the role check: one title would hide many firms.
  const { seen, seenCompanyRoles } = loadDedupSnapshot();
  let fresh = [];
  const known = { url: 0, role: 0 };
  for (const card of unique) {
    const key = normalizeUrlForDedup(card.url);
    if (seen.has(key)) { known.url++; continue; }
    const company = companyOf(card);
    const roleKey = ['?', 'Confidencial'].includes(company) ? null : companyRoleDedupKey(company, card.title);
    if (roleKey && seenCompanyRoles.has(roleKey)) { known.role++; continue; }
    seen.add(key);
    if (roleKey) seenCompanyRoles.add(roleKey);
    fresh.push(toOffer(card, source.note));
  }

  let expired = [];
  if (verify) ({ kept: fresh, expired } = dropExpired(fresh));

  console.log(`\n${cards.length} result(s) → ${byId.length} unique by id`
    + (jobage ? ` → -${dropped.age} older than ${jobage}d (${undated} undated kept)` : '')
    + ` → -${dropped.exclude} excluded by title → -${dropped.city} outside city`
    + ` → -${kept.length - unique.length} repeated company+title`
    + ` → -${known.url} known URL → -${known.role} known company+role`
    + (verify ? ` → -${expired.length} dead (liveness)` : '')
    + ` → ${fresh.length} new`);
  for (const o of expired) console.log(`  ❌ dead      ${o.company} | ${o.title}`);
  writeAgeLog(ageLogRow({ source: sourceName, jobage, results: cards.length, unique: byId.length,
    droppedAge: dropped.age, undated, fresh: fresh.length, dryRun }));
  if (dryRun || fresh.length === 0) {
    for (const o of fresh) console.log('  ' + formatPipelineOffer(o));
    if (dryRun) console.log('\n(dry run — nothing written)');
  } else {
    await appendToPipeline(fresh);
    for (const o of fresh) console.log('  ' + formatPipelineOffer(o));
    console.log('\nAppended to data/pipeline.md (queue only; run /career-ops pipeline yourself).');
  }
  if (!dryRun) { // newest first, always: also puts other writers' rows (scan.mjs) in place
    const r = await sortPipeline();
    if (r.changed) console.log(`Pending re-sorted newest-first (${r.rows} rows)`);
  }
  if (failed) process.exitCode = 2;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => { console.error('Fatal:', err.message); process.exitCode = 1; });
}
