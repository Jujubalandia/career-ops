// tests/remote-latam-runner.test.mjs — catalog, funnel and CLI of scripts/scan-remote-latam.mjs.
// No network: providers are stubs injected through main()'s `deps`, and the queue,
// the scan history and the run log all live in a temp dir (env set BEFORE the import,
// because scan.mjs resolves those paths at load time).
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, rmSync, ROOT } from './helpers.mjs';

console.log('\nRemote LATAM — runner');

const TMP = mkdtempSync(join(tmpdir(), 'remote-latam-runner-'));
const PIPELINE = join(TMP, 'pipeline.md');
const HISTORY = join(TMP, 'scan-history.tsv');
const LOG = join(TMP, 'remote-latam.tsv');
process.env.CAREER_OPS_PIPELINE = PIPELINE;
process.env.CAREER_OPS_SCAN_HISTORY = HISTORY;
process.env.CAREER_OPS_REMOTE_LATAM_LOG = LOG;
const SKELETON = '# Pipeline\n\n## Pending\n\n## Processed\n';
writeFileSync(PIPELINE, SKELETON);

const ok = (cond, msg) => (cond ? pass(msg) : fail(msg));
const throwsWith = (fn, re, msg) => {
  try { fn(); fail(`${msg}: did not throw`); }
  catch (e) { ok(re.test(e.message), `${msg} (${e.message.slice(0, 70)})`); }
};
const rejectsWith = async (promise, re, msg) => {
  try { await promise; fail(`${msg}: did not reject`); }
  catch (e) { ok(re.test(e.message), `${msg} (${e.message.slice(0, 70)})`); }
};
/** Run fn while capturing console.log; returns the captured text. */
async function capture(fn) {
  const real = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try { return { result: await fn(), out: lines.join('\n') }; }
  finally { console.log = real; }
}
const pendingRows = () => readFileSync(PIPELINE, 'utf8').split('\n').filter((l) => l.startsWith('- [ ] '));

try {
  const mod = await import(pathToFileURL(join(ROOT, 'scripts/scan-remote-latam.mjs')).href);
  const { parseCatalog, titleGate, ageInDays, runFunnel, main, LOG_HEADER } = mod;
  const DAY = 86_400_000;
  const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

  // ── catalog ───────────────────────────────────────────────────────────────────
  const min = parseCatalog('sources:\n  - id: a\n    provider: stub\n');
  ok(min.sources.length === 1 && min.sources[0].enabled === true, 'enabled defaults to true');
  ok(min.filters.include === null && min.filters.exclude === null, 'no filters -> null regexes');
  ok(Array.isArray(min.filters.latam.accept) && min.filters.latam.accept.length === 0, 'latam lists default to []');
  ok(parseCatalog('sources:\n  - id: a\n    provider: stub\n    enabled: false\n').sources[0].enabled === false, 'enabled: false is respected');
  ok(parseCatalog("filters:\n  include: 'ai'\nsources:\n  - id: a\n    provider: stub\n").filters.include.test('AI Engineer'), 'filters compile case-insensitive');

  throwsWith(() => parseCatalog(''), /empty or not a YAML mapping/, 'empty file is rejected');
  throwsWith(() => parseCatalog('sources: []'), /non-empty list/, 'empty sources list is rejected');
  throwsWith(() => parseCatalog('sources:\n  - provider: x\n'), /no `id`/, 'source without id is rejected');
  throwsWith(() => parseCatalog('sources:\n  - id: a\n'), /no `provider`/, 'source without provider is rejected');
  throwsWith(() => parseCatalog('sources:\n  - {id: a, provider: x}\n  - {id: a, provider: y}\n'), /duplicate source id "a"/, 'duplicate id is rejected');
  throwsWith(() => parseCatalog("filters:\n  include: '('\nsources:\n  - {id: a, provider: x}\n"), /filters\.include is not a valid regex/, 'bad regex names the key');

  // The shipped template must always parse, and its providers must exist.
  const tpl = parseCatalog(readFileSync(join(ROOT, 'templates/remote-latam.example.yml'), 'utf8'));
  ok(tpl.sources.length > 0 && tpl.filters.include && tpl.filters.exclude, 'templates/remote-latam.example.yml parses');
  const { readdirSync } = await import('fs');
  const providerIds = new Set(readdirSync(join(ROOT, 'providers')).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).map((f) => f.slice(0, -4)));
  const missing = tpl.sources.filter((s) => !providerIds.has(s.provider)).map((s) => s.provider);
  ok(missing.length === 0, `every template source has a provider in providers/ ${missing.length ? `(missing: ${missing})` : ''}`);

  // ── title gate: the shipped regexes against real titles from the live dry-runs ─
  const keep = ['Senior AI Engineer', 'Agentic AI Engineer', 'LLM Engineer', 'Staff ML Engineer', 'AI Governance Lead',
    'Head of Data & AI', 'Data Manager', 'Engenheiro de IA Sênior', 'Gerente de Dados e IA', 'Prompt Engineer',
    'Back-end Engineer Senior – LLM & Agentic AI'];
  const drop = ['Customer Service Agent', 'Japanese Speaking Customer Service Agent', 'Community Engagement Manager, Data Centers (Texas)',
    'SEO & AI Search Manager', 'AI Content Analyst (No Experience Required)', 'Business Analyst with AI Experience',
    'Junior AI Engineer', 'Sales Engineer, AI', 'Frontend Developer', 'Real Estate Agent', 'AI Data Annotator', 'Data Engineer',
    'Estagiário de IA', 'Product Manager, AI'];
  for (const t of keep) ok(titleGate(t, tpl.filters) === null, `title kept: ${t}`);
  for (const t of drop) ok(titleGate(t, tpl.filters) !== null, `title dropped: ${t}`);

  // ── age ───────────────────────────────────────────────────────────────────────
  ok(ageInDays(undefined, NOW) === null && ageInDays(0, NOW) === null && ageInDays(NaN, NOW) === null && ageInDays('2026-10-01', NOW) === null, 'undated / invalid postedAt -> null');
  ok(ageInDays(NOW - 3 * DAY, NOW) === 3, 'postedAt 3 days ago -> 3');
  ok(ageInDays(NOW + DAY, NOW) === 0, 'a future postedAt is clamped to 0');

  // ── funnel ────────────────────────────────────────────────────────────────────
  const filters = { include: /\bAI\b/i, exclude: /junior/i, latam: { accept: [], reject: [] } };
  const mk = () => ({ seen: new Set(['https://acme-test.example/jobs/already-known']), seenCompanyRoles: new Set() });
  const job = (o) => ({ title: 'AI Engineer', url: 'https://acme-test.example/jobs/1', company: 'Acme Test Co', location: 'Worldwide', ...o });
  const jobs = [
    job({ url: 'https://acme-test.example/jobs/ok', postedAt: NOW - DAY }),                                  // new
    job({ url: '', title: 'AI Engineer' }),                                                                  // invalid: no url
    job({ url: 'ftp://acme-test.example/x' }),                                                               // invalid: not http
    job({ url: 'https://acme-test.example/jobs/notitle', title: '  ' }),                                     // invalid: no title
    job({ url: 'https://acme-test.example/jobs/ui', title: 'UI Designer' }),                                 // title: include
    job({ url: 'https://acme-test.example/jobs/jr', title: 'Junior AI Engineer' }),                          // title: exclude
    job({ url: 'https://acme-test.example/jobs/us', location: 'USA Only' }),                                 // region
    job({ url: 'https://acme-test.example/jobs/old', title: 'AI Platform Lead', postedAt: NOW - 30 * DAY }), // age
    job({ url: 'https://acme-test.example/jobs/undated', title: 'AI Research Lead' }),                       // new, undated
    job({ url: 'https://acme-test.example/jobs/unk', title: 'AI Safety Lead', location: '' }),               // new, loc?
    job({ url: 'https://acme-test.example/jobs/already-known', title: 'AI Ops Lead' }),                      // dup url (snapshot)
    job({ url: 'https://acme-test.example/jobs/ok?utm_source=feed', title: 'AI Engineer' }),                 // dup url (tracking param)
    job({ url: 'https://acme-test.example/jobs/ok2', title: 'AI Engineer' }),                                // dup company+role (batch)
    job({ url: 'https://other-test.example/jobs/q', company: '', title: 'AI Support Lead' }),                // new, company '?'
    job({ url: 'https://other-test.example/jobs/r', company: '', title: 'AI Support Lead' }),                // company '?': NOT role-deduped
  ];
  const snap = mk();
  const { offers, counts } = runFunnel(jobs, { sourceId: 'stub', filters, sinceDays: 7, snapshot: snap, now: NOW });
  ok(counts.fetched === jobs.length, `fetched counts every row (${counts.fetched})`);
  ok(counts.invalid === 3, `invalid rows (${counts.invalid} of 3)`);
  ok(counts.droppedTitle === 2, `title drops (${counts.droppedTitle} of 2)`);
  ok(counts.droppedRegion === 1, `region drops (${counts.droppedRegion} of 1)`);
  ok(counts.droppedAge === 1, `age drops (${counts.droppedAge} of 1)`);
  ok(counts.dupUrl === 2, `url dupes: snapshot + tracking param (${counts.dupUrl} of 2)`);
  ok(counts.dupRole === 1, `company+role dupe (${counts.dupRole} of 1)`);
  ok(counts.new === 5 && offers.length === 5, `new rows (${counts.new} of 5)`);
  ok(counts.undated === 4, `undated postings are kept and counted among the new rows (${counts.undated} of 4)`);
  ok(counts.locUnknown === 1 && offers.filter((o) => o.note.endsWith(' loc?')).length === 1, 'unknown region is kept and tagged loc?');
  ok(offers.every((o) => o.note.startsWith('remote-latam:stub') && o.source === 'remote-latam:stub'), 'note and source name the catalog source');
  ok(offers.filter((o) => o.company === '?').length === 2, "company '?' skips the role dedup (two different firms stay)");
  ok(snap.seen.has('https://acme-test.example/jobs/ok') || [...snap.seen].some((k) => k.includes('/jobs/ok')), 'snapshot grows as rows are accepted');
  const again = runFunnel(jobs, { sourceId: 'stub2', filters, sinceDays: 7, snapshot: snap, now: NOW });
  ok(again.counts.new === 0, 'a second source cannot queue what the first one already took');
  ok(runFunnel(jobs, { sourceId: 'x', filters, sinceDays: 0, snapshot: mk(), now: NOW }).counts.droppedAge === 0, 'sinceDays 0 disables the age gate');
  ok(runFunnel(undefined, { sourceId: 'x', filters, sinceDays: 7, snapshot: mk() }).counts.fetched === 0, 'undefined jobs does not throw');

  // ── CLI end to end (stub providers, temp queue) ───────────────────────────────
  const catalogFile = join(TMP, 'catalog.yml');
  writeFileSync(catalogFile, [
    "filters:", "  include: '\\bAI\\b'", "  exclude: 'junior'",
    'sources:',
    '  - {id: alpha, provider: stub-a}',
    '  - {id: beta, provider: stub-b}',
    '  - {id: broken, provider: stub-broken}',
    '  - {id: nobody, provider: stub-missing}',
    '  - {id: off, provider: stub-a, enabled: false}',
  ].join('\n'));
  const calls = { a: 0, b: 0 };
  const providers = new Map([
    ['stub-a', { id: 'stub-a', fetch: async (entry) => {
      calls.a++;
      return [
        { title: 'AI Platform Engineer', url: 'https://cli-test.example/a/1', company: 'Cli Test Co', location: 'LATAM', postedAt: Date.now() - DAY },
        { title: 'AI Agent Lead', url: 'https://cli-test.example/a/2', company: 'Cli Test Co', location: 'Remote' },
      ];
    } }],
    ['stub-b', { id: 'stub-b', fetch: async () => {
      calls.b++;
      return [
        { title: 'AI Platform Engineer', url: 'https://cli-test.example/b/9', company: 'Cli Test Co', location: 'LATAM' }, // role dupe of a/1
        { title: 'AI Safety Engineer', url: 'https://cli-test.example/b/1', company: 'Beta Test Co', location: 'Brazil' },
      ];
    } }],
    ['stub-broken', { id: 'stub-broken', fetch: async () => { throw new Error('HTTP 500 from the board'); } }],
  ]);
  const run = (args) => capture(() => main(['--catalog', catalogFile, ...args], { providers }));

  // dry run: prints, writes nothing to the queue or history
  let r = await run(['--since', '7', '--dry-run', '--json']);
  ok(r.result === 2, 'exit code 2 when a source fails (broken + unknown provider)');
  const summary = JSON.parse(r.out.split('\n').find((l) => l.startsWith('{')));
  ok(summary.new === 3 && summary.dryRun === true, `dry run reports 3 new (${summary.new})`);
  ok(pendingRows().length === 0, 'dry run leaves the queue untouched');
  ok(summary.sources.find((s) => s.id === 'broken').error.includes('HTTP 500'), 'a failing source records its error');
  ok(summary.sources.find((s) => s.id === 'nobody').error.includes('unknown provider'), 'an unknown provider is reported, not thrown');
  ok(summary.sources.some((s) => s.id === 'alpha') && !summary.sources.some((s) => s.id === 'off'), 'disabled sources are skipped');
  ok(summary.sources.find((s) => s.id === 'beta').counts.dupRole === 1, 'cross-source company+role dupe is caught');

  // real run: queue, history, sort, log
  r = await run(['--since', '7']);
  const rows = pendingRows();
  ok(rows.length === 3, `3 rows appended (${rows.length})`);
  ok(rows.every((l) => /\| note: remote-latam:(alpha|beta)/.test(l)), 'rows carry the source note');
  ok(rows[0].includes('posted:') || rows.some((l) => l.includes('posted:')), 'dated rows carry posted:');
  const hist = readFileSync(HISTORY, 'utf8').trim().split('\n');
  ok(hist[0].startsWith('url\t') && hist.length === 4, `scan-history has header + 3 rows (${hist.length})`);
  ok(hist.slice(1).every((l) => l.split('\t')[2].startsWith('remote-latam:')), 'history portal column names the source');
  const logLines = readFileSync(LOG, 'utf8').trim().split('\n');
  ok(logLines[0] === LOG_HEADER.join('\t'), 'run log has the header');
  ok(logLines.length > 1 && logLines.every((l) => l.split('\t').length === LOG_HEADER.length), 'every log row has one cell per column');

  // second run: everything is now known
  const before = readFileSync(PIPELINE, 'utf8');
  r = await run(['--since', '7', '--json']);
  ok(JSON.parse(r.out.split('\n').find((l) => l.startsWith('{'))).new === 0, 'second run finds 0 new');
  ok(readFileSync(PIPELINE, 'utf8') === before, 'second run leaves the queue byte-identical');

  // --source targets one source, even a disabled one; --limit caps writes
  const callsBefore = calls.a;
  r = await run(['--source', 'off', '--dry-run', '--json']);
  ok(calls.a === callsBefore + 1, '--source runs a disabled source on request');
  writeFileSync(PIPELINE, SKELETON); writeFileSync(HISTORY, '');
  r = await run(['--source', 'alpha', '--limit', '1', '--dry-run', '--json']);
  ok(JSON.parse(r.out.split('\n').find((l) => l.startsWith('{'))).new === 1, '--limit caps the new rows');

  // argument errors
  await rejectsWith(main(['--bogus'], { providers }), /unknown argument/, 'unknown flag is rejected');
  await rejectsWith(main(['--since', '1', '--since', '2'], { providers }), /more than once/, 'repeated flag is rejected');
  await rejectsWith(main(['--since', '-1'], { providers }), />= 0/, 'negative --since is rejected');
  await rejectsWith(main(['--since'], { providers }), /needs a value/, 'flag without value is rejected');
  await rejectsWith(main(['--catalog', catalogFile, '--source', 'nope'], { providers }), /no source "nope"/, 'unknown --source is reported');
  const help = await capture(() => main(['--help'], { providers }));
  ok(help.result === 0 && /--dry-run/.test(help.out), '--help prints usage and exits 0');
} catch (e) {
  fail(`remote-latam-runner test crashed: ${e.stack || e.message}`);
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
