// tests/observ.test.mjs — unit coverage for observ.mjs's classification and
// aggregation logic (see the "observ" mode plan for the ground truth each
// case is regression-testing against real data/pipeline.md row shapes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const {
  parsePendingPipelineRows,
  classifyCategory,
  classifyWorkMode,
  classifyRegion,
  groupByPostedDate,
  filterByDate,
  computeBestFit,
  computePipelineStats,
} = await import(pathToFileURL(join(ROOT, 'observ.mjs')).href);

test('classifyCategory: order-of-checks — AI Governance Engineer is Governance, not Engineering', () => {
  assert.equal(classifyCategory('AI Governance Engineer'), 'AI Governance');
});

test('classifyCategory: Data Management title signals', () => {
  assert.equal(classifyCategory('Gestor de Dados'), 'Data Management');
  assert.equal(classifyCategory('Data Manager'), 'Data Management');
  assert.equal(classifyCategory('Head of Data'), 'Data Management');
});

test('classifyCategory: AI Engineering title signals', () => {
  assert.equal(classifyCategory('Engenheiro de IA'), 'AI Engineering');
  assert.equal(classifyCategory('Senior LLM Engineer'), 'AI Engineering');
});

test('classifyCategory: unmatched title -> Other, never dropped', () => {
  assert.equal(classifyCategory('Staff Product Manager'), 'Other');
  assert.equal(classifyCategory(''), 'Other');
});

test('classifyRegion: accented vs unaccented Bragança Paulista agree', () => {
  assert.equal(classifyRegion('Bragança Paulista, São Paulo, Brazil'), 'braganca_paulista_region');
  assert.equal(classifyRegion('Braganca Paulista, Sao Paulo, Brazil'), 'braganca_paulista_region');
});

test('classifyRegion: Extrema, MG', () => {
  assert.equal(classifyRegion('Extrema, Minas Gerais, Brazil'), 'extrema_mg');
});

test('classifyRegion: Campinas metro', () => {
  assert.equal(classifyRegion('Campinas, São Paulo, Brazil'), 'campinas_metro');
  assert.equal(classifyRegion('Indaiatuba, São Paulo, Brazil'), 'campinas_metro');
});

test('classifyRegion: plain São Paulo is the capital, not swallowed by the state-name collision', () => {
  // Every interior-SP city's location string also carries "São Paulo" as the
  // STATE name (e.g. "Campinas, São Paulo, Brazil") — the regression this
  // guards is checking the whole string for "sao paulo" and misfiling every
  // interior city into sao_paulo_capital.
  assert.equal(classifyRegion('São Paulo, São Paulo, Brazil'), 'sao_paulo_capital');
});

test('classifyRegion: empty location -> unclassified, not guessed', () => {
  assert.equal(classifyRegion(''), 'unclassified');
});

test('classifyRegion: international onsite with a Brazil-shaped location is not swallowed', () => {
  assert.equal(classifyRegion('Denver, Colorado, United States'), 'unclassified');
});

test('classifyWorkMode: hybrid signal in the TITLE wins over a real-city location', () => {
  assert.equal(
    classifyWorkMode('[GenAI] Software Engineer III - híbrido Florianópolis', 'Florianopolis, Santa Catarina, Brasil'),
    'hybrid',
  );
});

test('classifyWorkMode: location "Remoto" -> remote', () => {
  assert.equal(classifyWorkMode('AI Engineer', 'Remoto'), 'remote');
});

test('classifyWorkMode: plain city, no signal -> onsite', () => {
  assert.equal(classifyWorkMode('AI Engineer', 'São Paulo, São Paulo, Brazil'), 'onsite');
});

test('classifyWorkMode: empty location, no title signal -> unknown, never guessed onsite', () => {
  assert.equal(classifyWorkMode('AI Engineer', ''), 'unknown');
});

const PIPELINE_FIXTURE = [
  '# Pipeline — Pending URLs', '', '## Pending', '',
  '- [ ] https://x.test/1 | Acme | AI Manager | Remoto | posted: 2026-09-28 | rank: 4.0/5 — strong fit',
  '- [ ] https://x.test/2 | Beta | Gestor de Dados | Campinas, São Paulo, Brazil | posted: 2026-09-28',
  '- [ ] https://x.test/3 | Gama | Unrelated Role | São Paulo, São Paulo, Brazil | posted: 2026-09-27',
  '- [ ] https://x.test/4 | Delta | AI Engineer | Extrema, Minas Gerais, Brazil | posted: 2026-09-26 | rank: 3.5/5 — ok',
  '- [ ] https://x.test/5 | Epsilon | Stale Role Undated',
  '- [x] #10 | https://x.test/6 | Zeta | Processed Role | 4.0/5 | ✅',
  '- [!] https://x.test/7 | Eta | Unreachable Role',
  '',
].join('\n');

test('parsePendingPipelineRows: counts pending/processed/unreachable separately, never silently drops', () => {
  const { rows, processedCount, unreachableCount } = parsePendingPipelineRows(PIPELINE_FIXTURE);
  assert.equal(rows.length, 5);
  assert.equal(processedCount, 1);
  assert.equal(unreachableCount, 1);
});

test('parsePendingPipelineRows: a row with no posted: segment has postedDate null, not dropped', () => {
  const { rows } = parsePendingPipelineRows(PIPELINE_FIXTURE);
  const undated = rows.find((r) => r.url === 'https://x.test/5');
  assert.ok(undated);
  assert.equal(undated.postedDate, null);
});

test('parsePendingPipelineRows: rank extracted as a number; absent rank is null, never a synthetic score', () => {
  const { rows } = parsePendingPipelineRows(PIPELINE_FIXTURE);
  assert.equal(rows.find((r) => r.url === 'https://x.test/1').rank, 4.0);
  assert.equal(rows.find((r) => r.url === 'https://x.test/2').rank, null);
});

test('groupByPostedDate: buckets by date and tallies undated separately, no row lost', () => {
  const { rows } = parsePendingPipelineRows(PIPELINE_FIXTURE);
  const grouped = groupByPostedDate(rows);
  assert.equal(grouped['2026-09-28'], 2);
  assert.equal(grouped['2026-09-27'], 1);
  assert.equal(grouped['2026-09-26'], 1);
  assert.equal(grouped.undated, 1);
});

test('filterByDate: --days rolling window boundary is inclusive on both ends', () => {
  const { rows } = parsePendingPipelineRows(PIPELINE_FIXTURE);
  assert.equal(filterByDate(rows, { date: '2026-09-28', days: 0 }).length, 2);
  assert.equal(filterByDate(rows, { date: '2026-09-28', days: 2 }).length, 4);
});

test('computeBestFit: sorts scored rows descending, buckets the rest as unscoredCount, never fabricates', () => {
  const { rows } = parsePendingPipelineRows(PIPELINE_FIXTURE);
  const fit = computeBestFit(rows, 10);
  assert.equal(fit.scored.length, 2);
  assert.equal(fit.scored[0].rank, 4.0);
  assert.equal(fit.unscoredCount, 3);
});

test('computePipelineStats: window-scoped sections respect --date/--days, byPostedDate and bestFit stay global', () => {
  const today = computePipelineStats(PIPELINE_FIXTURE, { date: '2026-09-28', days: 0 });
  assert.equal(today.windowRowCount, 2);
  assert.equal(today.undatedCount, 1);
  assert.equal(Object.keys(today.byPostedDate).filter((k) => k !== 'undated').length, 3);
  assert.equal(today.bestFit.scored.length, 2);
});

test('computePipelineStats: interior-SP roles list carries region + category + rank', () => {
  const today = computePipelineStats(PIPELINE_FIXTURE, { date: '2026-09-28', days: 0 });
  const campinasRole = today.interiorSPRoles.find((r) => r.company === 'Beta');
  assert.ok(campinasRole);
  assert.equal(campinasRole.region, 'campinas_metro');
  assert.equal(campinasRole.category, 'Data Management');
  assert.equal(campinasRole.rank, null);
});
