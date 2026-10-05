#!/usr/bin/env node
/**
 * scan-remote-latam.mjs — fill data/pipeline.md from remote-job boards that serve LATAM.
 *
 * Zero LLM tokens. Reads the catalog (remote-latam.yml, falling back to
 * templates/remote-latam.example.yml), runs each enabled source's provider from
 * providers/, then narrows what comes back:
 *
 *   fetched -> title gate -> region gate -> age gate -> dedup -> [liveness] -> new
 *
 * It is a source for the queue, not an evaluator: it writes `- [ ] url | ...` rows
 * and nothing else. Run `/career-ops pipeline` yourself to evaluate them.
 *
 * Reuse, not reinvention: providers (loadProviders, makeHttpCtx), the queue and
 * history writers and the dedup snapshot (scan.mjs), the newest-first sort and the
 * liveness filter (scripts/import-jobs.mjs). Region logic is lib/latam-eligibility.mjs.
 *
 *   node scripts/scan-remote-latam.mjs --dry-run --since 7
 *   node scripts/scan-remote-latam.mjs --source remotive --since 3
 *   node scripts/scan-remote-latam.mjs --verify           # drop dead postings too
 *
 * Flags: --dry-run  --since DAYS (default $JOBAGE or 3)  --source ID  --verify
 *        --limit N (cap new rows per run)  --catalog FILE  --json  --help
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import {
  appendToPipeline, appendToScanHistory, companyRoleDedupKey, formatPipelineOffer,
  loadDedupSnapshot, normalizeUrlForDedup,
} from '../scan.mjs';
import { dropExpired, sortPipeline } from './import-jobs.mjs';
import { loadProviders } from '../providers/_registry.mjs';
import { makeHttpCtx } from '../providers/_http.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { classifyLatam } from '../lib/latam-eligibility.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { localToday } from '../lib/local-today.mjs';

const CODE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PROVIDERS_DIR = path.join(CODE_ROOT, 'providers');
const TEMPLATE_PATH = path.join(CODE_ROOT, 'templates/remote-latam.example.yml');
const LOG_PATH = process.env.CAREER_OPS_REMOTE_LATAM_LOG || path.join(CODE_ROOT, 'logs/remote-latam.tsv');
const DAY_MS = 86_400_000;
const PAUSE_BETWEEN_SOURCES_MS = 500;

export const LOG_HEADER = ['timestamp', 'source', 'since_days', 'fetched', 'invalid', 'dropped_title',
  'dropped_region', 'dropped_age', 'undated', 'loc_unknown', 'dup_url', 'dup_role', 'new', 'error', 'dry_run'];

// ── catalog ─────────────────────────────────────────────────────────────────────

function compile(label, source) {
  if (source === undefined || source === null || source === '') return null;
  try { return new RegExp(String(source), 'i'); }
  catch (e) { throw new Error(`catalog: filters.${label} is not a valid regex (${e.message})`); }
}

/** Parse and validate the catalog text. Throws with a message that names the bad key. */
export function parseCatalog(text) {
  const doc = String(text ?? '').trim() ? yaml.load(text) : null;
  if (!doc || typeof doc !== 'object') throw new Error('catalog: file is empty or not a YAML mapping');
  if (!Array.isArray(doc.sources) || doc.sources.length === 0) throw new Error('catalog: `sources:` must be a non-empty list');
  const ids = new Set();
  const sources = doc.sources.map((s, i) => {
    if (!s || typeof s !== 'object') throw new Error(`catalog: sources[${i}] is not a mapping`);
    if (typeof s.id !== 'string' || !s.id.trim()) throw new Error(`catalog: sources[${i}] has no \`id\``);
    if (typeof s.provider !== 'string' || !s.provider.trim()) throw new Error(`catalog: source "${s.id}" has no \`provider\``);
    if (ids.has(s.id)) throw new Error(`catalog: duplicate source id "${s.id}"`);
    ids.add(s.id);
    return { ...s, enabled: s.enabled !== false };
  });
  const f = doc.filters ?? {};
  return {
    sources,
    filters: {
      include: compile('include', f.include),
      exclude: compile('exclude', f.exclude),
      latam: { accept: f.latam?.accept ?? [], reject: f.latam?.reject ?? [] },
    },
  };
}

/** The user's catalog, else the template (so a first dry-run works without copying). */
export function resolveCatalogPath(explicit) {
  if (explicit) return { file: path.resolve(explicit), usingTemplate: false };
  const own = process.env.CAREER_OPS_REMOTE_LATAM || path.join(getCareerOpsRoot(), 'remote-latam.yml');
  if (existsSync(own)) return { file: own, usingTemplate: false };
  return { file: TEMPLATE_PATH, usingTemplate: true };
}

// ── funnel (pure: no network, no disk) ──────────────────────────────────────────

/** Title gate: returns the reason a title is dropped, or null when it stays. */
export function titleGate(title, { include, exclude }) {
  if (include && !include.test(title)) return 'include';
  if (exclude && exclude.test(title)) return 'exclude';
  return null;
}

/** Whole days since postedAt (epoch ms), or null when undated. */
export function ageInDays(postedAt, now = Date.now()) {
  if (typeof postedAt !== 'number' || !Number.isFinite(postedAt) || postedAt <= 0) return null;
  return Math.max(0, (now - postedAt) / DAY_MS);
}

const emptyCounts = () => ({
  fetched: 0, invalid: 0, droppedTitle: 0, droppedRegion: 0, droppedAge: 0,
  undated: 0, locUnknown: 0, dupUrl: 0, dupRole: 0, new: 0,
});

/**
 * Narrow one source's postings. `snapshot` ({seen, seenCompanyRoles}) is MUTATED as
 * rows are accepted, so two sources (or two postings) cannot both queue the same job.
 */
export function runFunnel(jobs, { sourceId, filters, sinceDays, snapshot, now = Date.now() }) {
  const counts = emptyCounts();
  const offers = [];
  for (const job of jobs ?? []) {
    counts.fetched++;
    const url = typeof job?.url === 'string' ? job.url.trim() : '';
    const title = typeof job?.title === 'string' ? job.title.trim() : '';
    if (!/^https?:\/\//i.test(url) || !title) { counts.invalid++; continue; }

    if (titleGate(title, filters)) { counts.droppedTitle++; continue; }

    const region = classifyLatam(
      { location: job.location, title, description: job.description },
      filters.latam,
    );
    if (region.eligible === false) { counts.droppedRegion++; continue; }

    const age = ageInDays(job.postedAt, now);
    if (age !== null && sinceDays > 0 && age > sinceDays) { counts.droppedAge++; continue; }

    const key = normalizeUrlForDedup(url);
    if (snapshot.seen.has(key)) { counts.dupUrl++; continue; }
    const company = typeof job.company === 'string' && job.company.trim() ? job.company.trim() : '?';
    const roleKey = ['?', 'Confidencial'].includes(company) ? null : companyRoleDedupKey(company, title);
    if (roleKey && snapshot.seenCompanyRoles.has(roleKey)) { counts.dupRole++; continue; }
    snapshot.seen.add(key);
    if (roleKey) snapshot.seenCompanyRoles.add(roleKey);

    const unknown = region.eligible === 'unknown';
    if (unknown) counts.locUnknown++;
    if (age === null) counts.undated++; // undated among the NEW rows: the ones the age gate could not judge
    counts.new++;
    offers.push({
      url,
      company,
      title,
      location: typeof job.location === 'string' ? job.location.trim() : '',
      postedAt: typeof job.postedAt === 'number' ? job.postedAt : undefined,
      note: `remote-latam:${sourceId}${unknown ? ' loc?' : ''}`,
      source: `remote-latam:${sourceId}`,
    });
  }
  return { offers, counts };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────

const HELP = `Usage: node scripts/scan-remote-latam.mjs [--dry-run] [--since DAYS] [--source ID] [--verify]
                                    [--limit N] [--catalog FILE] [--json]
  --since DAYS   keep postings newer than DAYS (default $JOBAGE or 3); undated postings are kept and counted
  --source ID    run only this catalog source (even if it is disabled there)
  --verify       drop dead postings with check-liveness.mjs before writing
  --limit N      write at most N new rows
  --dry-run      print everything, write nothing`;

function parseArgs(argv) {
  const out = { dryRun: false, verify: false, json: false, since: undefined, source: undefined, limit: undefined, catalog: undefined, help: false };
  const seen = new Set();
  const take = (flag, i) => {
    if (seen.has(flag)) throw new Error(`${flag} was given more than once`);
    seen.add(flag);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--verify') out.verify = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--since') { out.since = Number(take(a, i)); i++; }
    else if (a === '--limit') { out.limit = Number(take(a, i)); i++; }
    else if (a === '--source') { out.source = take(a, i); i++; }
    else if (a === '--catalog') { out.catalog = take(a, i); i++; }
    else throw new Error(`unknown argument: ${a}`);
  }
  for (const k of ['since', 'limit']) {
    if (out[k] !== undefined && (!Number.isFinite(out[k]) || out[k] < 0)) throw new Error(`--${k} must be a number >= 0`);
  }
  return out;
}

const pad = (v, n) => String(v).padStart(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeLog(rows) {
  mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  if (!existsSync(LOG_PATH)) appendFileSync(LOG_PATH, LOG_HEADER.join('\t') + '\n');
  appendFileSync(LOG_PATH, rows.map((r) => r.join('\t')).join('\n') + '\n');
}

/**
 * @param {string[]} argv
 * @param {{providers?: Map<string, object>}} [deps] test seam: a provider map replaces
 *   the one loaded from providers/, so the whole CLI can run with no network.
 * @returns {Promise<number>} exit code (2 when any source failed)
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  if (args.help) { console.log(HELP); return 0; }
  const sinceDays = args.since ?? Number(process.env.JOBAGE ?? 3);

  const { file, usingTemplate } = resolveCatalogPath(args.catalog);
  const catalog = parseCatalog(readFileSync(file, 'utf8'));
  if (usingTemplate) console.error(`(no remote-latam.yml found; using the template ${path.relative(CODE_ROOT, file)} — copy it to customize)`);

  let sources = args.source
    ? catalog.sources.filter((s) => s.id === args.source)
    : catalog.sources.filter((s) => s.enabled);
  if (args.source && sources.length === 0) throw new Error(`no source "${args.source}" in ${path.basename(file)}`);

  const providers = deps.providers ?? await loadProviders(PROVIDERS_DIR);
  const snapshot = loadDedupSnapshot();
  const now = Date.now();
  const ctx = { ...makeHttpCtx(), sinceMs: sinceDays > 0 ? now - sinceDays * DAY_MS : undefined, includeUndated: true };

  const all = [];
  const perSource = [];
  let errors = 0;
  for (const [i, src] of sources.entries()) {
    if (i > 0) await sleep(PAUSE_BETWEEN_SOURCES_MS);
    const provider = providers.get(src.provider);
    if (!provider) {
      errors++;
      perSource.push({ id: src.id, counts: emptyCounts(), error: `unknown provider "${src.provider}"` });
      continue;
    }
    try {
      const jobs = await provider.fetch({ ...src, name: src.id }, ctx);
      const { offers, counts } = runFunnel(jobs, { sourceId: src.id, filters: catalog.filters, sinceDays, snapshot, now });
      all.push(...offers);
      perSource.push({ id: src.id, counts, error: '' });
    } catch (err) {
      errors++;
      perSource.push({ id: src.id, counts: emptyCounts(), error: String(err?.message ?? err).slice(0, 160) });
    }
  }

  let fresh = args.limit !== undefined ? all.slice(0, args.limit) : all;
  let expired = [];
  if (args.verify && fresh.length > 0) ({ kept: fresh, expired } = dropExpired(fresh));

  if (args.json) {
    console.log(JSON.stringify({ since: sinceDays, dryRun: args.dryRun, sources: perSource, new: fresh.length, expired: expired.length }));
  } else {
    console.log(`\nremote-latam  since ${sinceDays}d  ${args.dryRun ? '(dry run)' : ''}\n`);
    console.log(`${'source'.padEnd(16)} ${pad('fetch', 5)} ${pad('title', 5)} ${pad('region', 6)} ${pad('age', 4)} ${pad('dupe', 4)} ${pad('loc?', 4)} ${pad('NEW', 4)}`);
    for (const { id, counts: c, error } of perSource) {
      console.log(`${id.padEnd(16)} ${pad(c.fetched, 5)} ${pad(`-${c.droppedTitle}`, 5)} ${pad(`-${c.droppedRegion}`, 6)} ${pad(`-${c.droppedAge}`, 4)} ${pad(`-${c.dupUrl + c.dupRole}`, 4)} ${pad(c.locUnknown, 4)} ${pad(c.new, 4)}${error ? `  ⚠️ ${error}` : ''}`);
    }
    if (args.verify) console.log(`\nliveness: -${expired.length} dead`);
    console.log(`\n${fresh.length} new row(s)${args.limit !== undefined && all.length > fresh.length ? ` (capped from ${all.length})` : ''}`);
    for (const o of fresh) console.log('  ' + formatPipelineOffer(o));
  }

  const ts = new Date().toISOString();
  writeLog(perSource.map(({ id, counts: c, error }) => [ts, id, sinceDays, c.fetched, c.invalid, c.droppedTitle,
    c.droppedRegion, c.droppedAge, c.undated, c.locUnknown, c.dupUrl, c.dupRole, c.new, error ? error.replace(/\s+/g, ' ') : '', args.dryRun ? 1 : 0]));

  if (args.dryRun) { if (!args.json) console.log('\n(dry run — nothing written to data/pipeline.md)'); }
  else if (fresh.length > 0) {
    await appendToPipeline(fresh);
    await appendToScanHistory(fresh, localToday(), 'added');
    const r = await sortPipeline();
    if (!args.json) {
      console.log(`\nAppended ${fresh.length} row(s) to data/pipeline.md (queue only; run /career-ops pipeline yourself).`);
      if (r.changed) console.log(`Pending re-sorted newest-first (${r.rows} rows)`);
    }
  }
  return errors > 0 ? 2 : 0;
}

if (isMainModule(import.meta.url)) {
  main().then((code) => { process.exitCode = code; })
    .catch((err) => { console.error('Fatal:', err.message); process.exitCode = 1; });
}
