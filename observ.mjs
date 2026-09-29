// @ts-check
/**
 * observ.mjs — zero-token daily analytics over data/pipeline.md.
 *
 * Answers "what does today's (or the last N days') scan haul look like":
 * category counts (AI Management / Data Management / ... ), remote-by-category,
 * postings grouped by posted date, on-site/hybrid/remote split, counts by
 * region (including a Brazil interior-São-Paulo / Extrema-MG breakout), a
 * best-fit shortlist from the existing `rank:` field, and the interior-SP/
 * Extrema-MG IT postings specifically. Read-only — never writes to
 * data/pipeline.md, data/scan-history.tsv, or any tracker/report file.
 *
 * Every category/region/work-mode bucket below is a KEYWORD CLASSIFICATION of
 * free-text title/location strings, not a verified fact — there is no
 * structured field for any of these anywhere in the pipeline (confirmed by
 * reading scan.mjs/import-jobs.mjs/portals.yml). Never present a bucket count
 * as ground truth; `printSummary()` says so once, up front.
 *
 * Usage:
 *   node observ.mjs                       (JSON, today's posted-date window)
 *   node observ.mjs --summary             (human-readable report)
 *   node observ.mjs --date 2026-09-25     (a specific posted date)
 *   node observ.mjs --days 7              (rolling window ending at --date)
 *   node observ.mjs --top 5               (best-fit shortlist size, default 10)
 *   node observ.mjs --self-test
 *
 * Scoping: categoryCounts/remoteByCategory/workMode/byRegion/interiorSPRoles
 * are scoped to the --date/--days window (default: today only, by `posted:`).
 * byPostedDate and bestFit are intentionally NOT window-scoped — a date
 * histogram of one day is a degenerate view, and "which pending posting fits
 * me best" is a standing question, not a today-only one.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { flagValue, validateFlags, safeIntFlag } from './lib/cli-flags.mjs';
import { asciiFold } from './lib/ascii-fold.mjs';
import { localToday } from './lib/local-today.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const DATA_ROOT = getCareerOpsRoot();
const PIPELINE_FILE = join(DATA_ROOT, 'data', 'pipeline.md');

// ── Region taxonomy (DRAFT — see AGENTS.md discussion / the plan this shipped
// from). These are the specific regions the user asked to track, not an
// attempt at full Brazilian-geography coverage (YAGNI). Edit freely if a city
// is missing or wrongly grouped — nothing else in the codebase depends on
// these exact groupings.
const REGIONS = {
  campinas_metro: ['campinas', 'americana', 'sumare', 'hortolandia', 'indaiatuba', 'valinhos', 'vinhedo', 'paulinia', 'jundiai'],
  braganca_paulista_region: ['braganca paulista', 'atibaia', 'vargem', 'joanopolis', 'bom jesus dos perdoes'],
  extrema_mg: ['extrema', 'camanducaia'],
};

// Category keyword groups, drawn from the user's own real search config
// (scripts/import-config.sh QUERIES) rather than an invented taxonomy.
// Order matters: Management/Governance are checked before the generic
// Engineering buckets so "AI Governance Engineer" doesn't fall through to
// AI Engineering.
const CATEGORY_PATTERNS = [
  ['AI Management', /\b(ai manager|gerente de ia|gestor(?:a)? de ia|gestao ia|diretor(?:a)? de ia|head of ai)\b/],
  ['Data Management', /\b(data manager|gerente de dados|gestor(?:a)? de dados|gestao de dados|head of data|diretor(?:a)? de dados)\b/],
  ['AI Governance', /\b(ai governance|governanca de ia)\b/],
  ['AI Engineering', /\b(ai engineer|agentic ai|engenheiro(?:a)? de ia|agente de ia|genai|llm engineer)\b/],
  ['Data Engineering', /\b(data engineer|engenheiro(?:a)? de dados)\b/],
];

const LABEL_RE = /^(posted|trust|note|rank):\s*(.*)$/i;
const RANK_RE = /^(\d+(?:\.\d+)?)\/5\s*(?:[—-]\s*)?(.*)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function wordMatch(foldedText, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(foldedText);
}

function addDaysUTC(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// ── Row parsing ─────────────────────────────────────────────────────

/**
 * Parse data/pipeline.md content into classifiable rows plus counts for the
 * rows that carry no classifiable fields.
 *
 * Row grammar (scan.mjs's formatPipelineOffer): `- [ ] url | company | title`
 * plus up to two OPTIONAL positional cells (location, then compensation) and
 * any number of self-labeled `posted:`/`trust:`/`note:`/`rank:` segments in
 * that order. Cells are identified by label prefix, never by raw index —
 * compensation-but-no-location leaves an empty positional cell, and a bare
 * hand-pasted URL row has no cells past the URL at all.
 *
 * `- [x]` (processed) and `- [!]` (unreachable) rows carry none of these
 * fields — pipeline.md mode rewrites `- [x]` rows down to
 * `#NNN | url | company | role | score | PDF`, dropping location/posted
 * entirely — so they're tallied, never classified.
 */
export function parsePendingPipelineRows(content) {
  const rows = [];
  let processedCount = 0;
  let unreachableCount = 0;

  for (const raw of String(content ?? '').split('\n')) {
    if (raw.startsWith('- [x] ')) { processedCount++; continue; }
    if (raw.startsWith('- [!] ')) { unreachableCount++; continue; }
    if (!raw.startsWith('- [ ] ')) continue;

    const cells = raw.slice(6).split('|').map((c) => c.trim());
    const url = cells[0] ?? '';
    const company = cells[1] ?? '';
    const title = cells[2] ?? '';

    let location = '';
    let posIdx = 3;
    let positionalSeen = 0;
    while (posIdx < cells.length && positionalSeen < 2 && !LABEL_RE.test(cells[posIdx])) {
      if (positionalSeen === 0) location = cells[posIdx];
      // positionalSeen === 1 is compensation — parsed but unused, no requested stat needs it.
      positionalSeen++;
      posIdx++;
    }

    const labels = {};
    for (; posIdx < cells.length; posIdx++) {
      const m = cells[posIdx].match(LABEL_RE);
      if (m) labels[m[1].toLowerCase()] = m[2].trim();
    }

    const postedDate = DATE_RE.test(labels.posted ?? '') ? labels.posted : null;
    const rankMatch = labels.rank ? labels.rank.match(RANK_RE) : null;
    const rank = rankMatch ? Number(rankMatch[1]) : null;
    const rankReason = rankMatch ? rankMatch[2].trim() : '';

    rows.push({ url, company, title, location, postedDate, rank, rankReason });
  }

  return { rows, processedCount, unreachableCount };
}

// ── Classification ──────────────────────────────────────────────────

export function classifyCategory(title) {
  const folded = asciiFold(title ?? '');
  for (const [category, re] of CATEGORY_PATTERNS) {
    if (re.test(folded)) return category;
  }
  return 'Other';
}

export function classifyWorkMode(title, location) {
  const foldedTitle = asciiFold(title ?? '');
  const foldedLocation = asciiFold(location ?? '');
  if (wordMatch(foldedTitle, 'hibrido') || wordMatch(foldedTitle, 'hybrid')) return 'hybrid';
  if (wordMatch(foldedLocation, 'remoto') || wordMatch(foldedLocation, 'remote')) return 'remote';
  if (foldedLocation) return 'onsite';
  return 'unknown';
}

/**
 * Region bucket for a location string. Checked on the FIRST comma segment
 * (the city) before falling back to "São Paulo" as the state name — a
 * location like "Campinas, São Paulo, Brazil" always carries the state name
 * too, so checking the whole string for "sao paulo" would misfile every
 * interior-SP city into sao_paulo_capital.
 *
 * 'unclassified' covers both an empty location AND a known-but-unplaceable
 * one (e.g. an international onsite posting with no Brazil signal) — the
 * distinction is already visible via metadata.undatedCount/row inspection if
 * it matters; a second bucket name for it would be more taxonomy than any
 * requested stat needs.
 */
export function classifyRegion(location) {
  const folded = asciiFold(location ?? '');
  if (!folded) return 'unclassified';
  const firstSegment = asciiFold((location ?? '').split(',')[0] ?? '');

  for (const [region, cities] of Object.entries(REGIONS)) {
    if (cities.some((city) => wordMatch(firstSegment, city))) return region;
  }
  if (wordMatch(firstSegment, 'sao paulo')) return 'sao_paulo_capital';
  if (wordMatch(folded, 'brasil') || wordMatch(folded, 'brazil') || folded === 'remoto') return 'other_brazil';
  return 'unclassified';
}

// ── Aggregation ──────────────────────────────────────────────────────

export function groupByPostedDate(rows) {
  const byDate = {};
  let undated = 0;
  for (const row of rows) {
    if (row.postedDate) byDate[row.postedDate] = (byDate[row.postedDate] ?? 0) + 1;
    else undated++;
  }
  return { ...byDate, undated };
}

export function filterByDate(rows, { date, days = 0 } = {}) {
  const start = days > 0 ? addDaysUTC(date, -days) : date;
  return rows.filter((r) => r.postedDate !== null && r.postedDate >= start && r.postedDate <= date);
}

export function computeBestFit(rows, top = 10) {
  const scored = rows.filter((r) => r.rank !== null).sort((a, b) => b.rank - a.rank);
  return {
    scored: scored.slice(0, top).map(({ url, company, title, rank, rankReason }) => ({ url, company, title, rank, rankReason })),
    unscoredCount: rows.length - scored.length,
  };
}

// ── Assembler ────────────────────────────────────────────────────────

/** Pure: everything below the file-read/degrade boundary, given raw pipeline.md content. */
export function computePipelineStats(content, { date = localToday(), days = 0, top = 10 } = {}) {
  const { rows, processedCount, unreachableCount } = parsePendingPipelineRows(content);
  const undatedCount = rows.filter((r) => r.postedDate === null).length;
  const windowRows = filterByDate(rows, { date, days });

  const categoryCounts = {};
  const remoteByCategory = {};
  const workMode = { remote: 0, hybrid: 0, onsite: 0, unknown: 0 };
  const byRegion = {};
  const interiorSPRoles = [];
  const INTERIOR_REGIONS = new Set(['campinas_metro', 'braganca_paulista_region', 'extrema_mg']);

  for (const row of windowRows) {
    const category = classifyCategory(row.title);
    const mode = classifyWorkMode(row.title, row.location);
    const region = classifyRegion(row.location);

    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    workMode[mode] += 1;
    byRegion[region] = (byRegion[region] ?? 0) + 1;
    if (mode === 'remote') remoteByCategory[category] = (remoteByCategory[category] ?? 0) + 1;
    if (INTERIOR_REGIONS.has(region) && category !== 'Other') {
      interiorSPRoles.push({ url: row.url, company: row.company, title: row.title, region, category, rank: row.rank });
    }
  }

  return {
    windowRowCount: windowRows.length,
    totalPendingCount: rows.length,
    processedCount,
    unreachableCount,
    undatedCount,
    categoryCounts,
    remoteByCategory,
    byPostedDate: groupByPostedDate(rows), // global — a single-day histogram is degenerate
    workMode,
    byRegion,
    interiorSPRoles,
    bestFit: computeBestFit(rows, top), // global — "best fit for me" isn't a today-only question
  };
}

/** File I/O + degrade-to-null boundary, mirroring stats.mjs's computeAllStats. */
export function computeObservStats({ date = localToday(), days = 0, top = 10, pipelineFile = PIPELINE_FILE } = {}) {
  const pipelineExists = existsSync(pipelineFile);
  const generatedAt = new Date().toISOString();

  if (!pipelineExists) {
    return {
      metadata: { generatedAt, date, days, sources: { pipeline: false } },
      categoryCounts: null, remoteByCategory: null, byPostedDate: null,
      workMode: null, byRegion: null, interiorSPRoles: null, bestFit: null,
    };
  }

  const content = readFileSync(pipelineFile, 'utf-8');
  const core = computePipelineStats(content, { date, days, top });

  return {
    metadata: {
      generatedAt, date, days,
      sources: { pipeline: true },
      totalPendingCount: core.totalPendingCount,
      windowRowCount: core.windowRowCount,
      processedCount: core.processedCount,
      unreachableCount: core.unreachableCount,
      undatedCount: core.undatedCount,
    },
    categoryCounts: core.categoryCounts,
    remoteByCategory: core.remoteByCategory,
    byPostedDate: core.byPostedDate,
    workMode: core.workMode,
    byRegion: core.byRegion,
    interiorSPRoles: core.interiorSPRoles,
    bestFit: core.bestFit,
  };
}

// ── Summary rendering ────────────────────────────────────────────────

function printCountTable(title, counts) {
  console.log(title);
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) console.log('  (none)');
  for (const [key, count] of entries) console.log(`  ${key}: ${count}`);
  console.log('');
}

function printSummary(stats) {
  console.log(`observ — daily pipeline analytics (${stats.metadata.date}${stats.metadata.days > 0 ? `, ${stats.metadata.days}d window` : ''})`);
  console.log('Categories/regions below are keyword-classified from title+location text, not verified — spot-check if it matters.\n');

  if (!stats.metadata.sources.pipeline) {
    console.log('No data/pipeline.md found — nothing to report yet.');
    return;
  }

  const m = stats.metadata;
  console.log(`Pending: ${m.totalPendingCount} total | ${m.windowRowCount} in window | ${m.undatedCount} undated | ${m.processedCount} processed | ${m.unreachableCount} unreachable\n`);

  printCountTable('By category (window):', stats.categoryCounts);
  printCountTable('Remote, by category (window):', stats.remoteByCategory);
  printCountTable('Work mode (window):', stats.workMode);
  printCountTable('By region (window):', stats.byRegion);

  console.log('By posted date (all pending):');
  const dateEntries = Object.entries(stats.byPostedDate).filter(([k]) => k !== 'undated').sort((a, b) => b[0].localeCompare(a[0]));
  for (const [date, count] of dateEntries) console.log(`  ${date}: ${count}`);
  console.log(`  undated: ${stats.byPostedDate.undated}\n`);

  console.log(`Interior SP / Extrema-MG IT roles (window): ${stats.interiorSPRoles.length}`);
  for (const r of stats.interiorSPRoles) console.log(`  [${r.region}] ${r.company} — ${r.title} (${r.category}${r.rank !== null ? `, rank ${r.rank}/5` : ''})`);
  console.log('');

  console.log(`Best fit (all pending, top ${stats.bestFit.scored.length}, ${stats.bestFit.unscoredCount} unscored):`);
  for (const r of stats.bestFit.scored) console.log(`  ${r.rank}/5 — ${r.company} — ${r.title}`);
}

// ── Self-test ────────────────────────────────────────────────────────

function selfTest() {
  const failures = [];
  const t = (name, cond) => { if (!cond) failures.push(name); };

  t('category: AI Governance Engineer -> AI Governance, not AI Engineering', classifyCategory('AI Governance Engineer') === 'AI Governance');
  t('category: Gestor de Dados -> Data Management', classifyCategory('Gestor de Dados') === 'Data Management');
  t('category: Engenheiro de IA -> AI Engineering', classifyCategory('Engenheiro de IA') === 'AI Engineering');
  t('category: unmatched -> Other', classifyCategory('Staff Product Manager') === 'Other');

  t('region: accented Braganca == unaccented', classifyRegion('Bragança Paulista, São Paulo, Brazil') === 'braganca_paulista_region' && classifyRegion('Braganca Paulista, Sao Paulo, Brazil') === 'braganca_paulista_region');
  t('region: Extrema MG', classifyRegion('Extrema, Minas Gerais, Brazil') === 'extrema_mg');
  t('region: Campinas', classifyRegion('Campinas, São Paulo, Brazil') === 'campinas_metro');
  t('region: plain Sao Paulo is capital, not campinas (state-name collision)', classifyRegion('São Paulo, São Paulo, Brazil') === 'sao_paulo_capital');
  t('region: empty -> unclassified', classifyRegion('') === 'unclassified');

  t('workMode: hybrid signal in title wins over real-city location', classifyWorkMode('[GenAI] Software Engineer III - híbrido Florianópolis', 'Florianopolis, Santa Catarina, Brasil') === 'hybrid');
  t('workMode: Remoto location -> remote', classifyWorkMode('AI Engineer', 'Remoto') === 'remote');
  t('workMode: plain city, no signal -> onsite', classifyWorkMode('AI Engineer', 'São Paulo, São Paulo, Brazil') === 'onsite');
  t('workMode: empty location -> unknown, never guessed', classifyWorkMode('AI Engineer', '') === 'unknown');

  const pipelineFixture = [
    '# Pipeline — Pending URLs', '', '## Pending', '',
    '- [ ] https://x.test/1 | Acme | AI Manager | Remoto | posted: 2026-09-28 | rank: 4.0/5 — strong fit',
    '- [ ] https://x.test/2 | Beta | Gestor de Dados | Campinas, São Paulo, Brazil | posted: 2026-09-28',
    '- [ ] https://x.test/3 | Gama | Unrelated Role | São Paulo, São Paulo, Brazil | posted: 2026-09-27',
    '- [ ] https://x.test/4 | Delta | AI Engineer | Extrema, Minas Gerais, Brazil | posted: 2026-09-26',
    '- [ ] https://x.test/5 | Epsilon | Stale Role Undated',
    '- [x] #10 | https://x.test/6 | Zeta | Processed Role | 4.0/5 | ✅',
    '- [!] https://x.test/7 | Eta | Unreachable Role',
    '',
  ].join('\n');

  const { rows, processedCount, unreachableCount } = parsePendingPipelineRows(pipelineFixture);
  t('parse: 5 pending rows', rows.length === 5);
  t('parse: 1 processed row counted, not classified', processedCount === 1);
  t('parse: 1 unreachable row counted, not classified', unreachableCount === 1);
  t('parse: undated row has postedDate null, not dropped', rows.some((r) => r.url === 'https://x.test/5' && r.postedDate === null));
  t('parse: rank extracted', rows.find((r) => r.url === 'https://x.test/1').rank === 4.0);
  t('parse: no rank: field -> null, not a synthetic score', rows.find((r) => r.url === 'https://x.test/2').rank === null);

  const todayStats = computePipelineStats(pipelineFixture, { date: '2026-09-28', days: 0 });
  t('window: only 2026-09-28 rows in window', todayStats.windowRowCount === 2);
  t('window: undatedCount counts the undated row regardless of window', todayStats.undatedCount === 1);
  t('window: interior SP role found (Campinas)', todayStats.interiorSPRoles.some((r) => r.region === 'campinas_metro'));

  const windowStats = computePipelineStats(pipelineFixture, { date: '2026-09-28', days: 2 });
  t('--days: rolling 2-day window includes 2026-09-26', windowStats.windowRowCount === 4);

  t('byPostedDate: global, not window-scoped', Object.keys(computePipelineStats(pipelineFixture, { date: '2026-09-28', days: 0 }).byPostedDate).length > 2);
  t('bestFit: global, not window-scoped (finds the 2026-09-27/26 rows too if ranked)', computePipelineStats(pipelineFixture, { date: '2026-09-28', days: 0 }).bestFit.unscoredCount === 4);

  if (failures.length) {
    console.error(`❌ observ.mjs self-test: ${failures.length} failure(s):\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('✅ observ.mjs self-test: all checks passed');
  process.exit(0);
}

// ── CLI ──────────────────────────────────────────────────────────────

const KNOWN_FLAGS = ['--date', '--days', '--top', '--json', '--summary', '--self-test', '--help', '-h'];
const USAGE = `Usage:
  node observ.mjs                     # JSON, today's posted-date window
  node observ.mjs --summary           # human-readable report
  node observ.mjs --date YYYY-MM-DD   # a specific posted date (default: today)
  node observ.mjs --days N            # rolling window ending at --date
  node observ.mjs --top N             # best-fit shortlist size (default 10)
  node observ.mjs --self-test         # run in-memory checks, no data files
  node observ.mjs --help|-h           # print this usage block and exit`;

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) selfTest();

  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: ['--date', '--days', '--top'] });

  const date = flagValue(args, '--date') ?? localToday();
  if (!DATE_RE.test(date)) {
    console.error(`--date must be YYYY-MM-DD, got: ${date}`);
    process.exit(1);
  }
  const days = safeIntFlag(flagValue(args, '--days'), 0);
  const top = safeIntFlag(flagValue(args, '--top'), 10);

  const stats = computeObservStats({ date, days, top });
  if (args.includes('--summary')) printSummary(stats);
  else console.log(JSON.stringify(stats, null, 2));
}
