// tests/remote-latam-runner.test.mjs — catalog, funnel and CLI of scripts/scan-remote-latam.mjs.
// No network. The pure parts (catalog, title/age gates, funnel) run in this process.
// The CLI scenario runs in a CHILD process with its own environment: scan.mjs resolves
// the queue / history paths from env at load time, and test-all.mjs runs every suite
// in one process, so setting CAREER_OPS_* here would leak into every later test.
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import { pass, fail, rmSync, ROOT, NODE } from './helpers.mjs';

console.log('\nRemote LATAM — runner');

const ok = (cond, msg) => (cond ? pass(msg) : fail(msg));
const throwsWith = (fn, re, msg) => {
  try { fn(); fail(`${msg}: did not throw`); }
  catch (e) { ok(re.test(e.message), `${msg} (${e.message.slice(0, 70)})`); }
};

const TMP = mkdtempSync(join(tmpdir(), 'remote-latam-runner-'));

try {
  const RUNNER_URL = pathToFileURL(join(ROOT, 'scripts/scan-remote-latam.mjs')).href;
  const { parseCatalog, titleGate, classGate, ageInDays, runFunnel, LOG_HEADER } = await import(RUNNER_URL);
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
  const providerIds = new Set(readdirSync(join(ROOT, 'providers')).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).map((f) => f.slice(0, -4)));
  const missing = tpl.sources.filter((s) => !providerIds.has(s.provider)).map((s) => s.provider);
  ok(missing.length === 0, `every template source has a provider in providers/ ${missing.length ? `(missing: ${missing})` : ''}`);

  // ── title gate: the shipped regexes against real titles from the live dry-runs ─
  const keep = ['Senior AI Engineer', 'Agentic AI Engineer', 'LLM Engineer', 'Staff ML Engineer', 'AI Governance Lead',
    'AI Governance Analyst', 'Head of Data & AI', 'Data Manager', 'Engenheiro de IA Sênior', 'Gerente de Dados e IA',
    'Prompt Engineer', 'Back-end Engineer Senior – LLM & Agentic AI', 'Software Engineer, Applied AI (Brazil)'];
  const drop = ['Customer Service Agent', 'Japanese Speaking Customer Service Agent', 'Community Engagement Manager, Data Centers (Texas)',
    'SEO & AI Search Manager', 'AI Content Analyst (No Experience Required)', 'Business Analyst with AI Experience',
    'Principal Data Operations Analyst', 'AI Trainers Network - Marathi', 'Junior AI Engineer', 'Sales Engineer, AI',
    'Frontend Developer', 'Real Estate Agent', 'AI Data Annotator', 'Data Engineer', 'Estagiário de IA', 'Product Manager, AI'];
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
  ok([...snap.seen].some((k) => k.includes('/jobs/ok')), 'snapshot grows as rows are accepted');
  const again = runFunnel(jobs, { sourceId: 'stub2', filters, sinceDays: 7, snapshot: snap, now: NOW });
  ok(again.counts.new === 0, 'a second source cannot queue what the first one already took');
  ok(runFunnel(jobs, { sourceId: 'x', filters, sinceDays: 0, snapshot: mk(), now: NOW }).counts.droppedAge === 0, 'sinceDays 0 disables the age gate');
  ok(runFunnel(undefined, { sourceId: 'x', filters, sinceDays: 7, snapshot: mk() }).counts.fetched === 0, 'undefined jobs does not throw');

  // ── class gate and class label ────────────────────────────────────────────────
  const gigs = [
    { title: 'Machine Learning Engineer', url: 'https://www.aigig-test.example/jobs/ml', company: 'micro1', location: 'Brazil', postedAt: NOW - DAY, meta: { employmentType: 'CONTRACTOR', pay: { min: 60, max: 150, currency: 'USD', unit: 'HOUR' } } },
    { title: 'Data Scientist', url: 'https://www.aigig-test.example/jobs/ds', company: 'Alignerr', location: 'Brazil', postedAt: NOW - DAY, meta: { employmentType: 'CONTRACTOR' } },
    { title: 'Senior ML Engineer', url: 'https://www.aigig-test.example/jobs/emp', company: 'Acme Test Co', location: 'Brazil', postedAt: NOW - DAY, meta: { employmentType: 'FULL_TIME' } },
    { title: 'Data Labeling Specialist', url: 'https://www.aigig-test.example/jobs/label', company: 'Alignerr', location: 'Brazil', postedAt: NOW - DAY, meta: { employmentType: 'CONTRACTOR' } },
    { title: 'Bankruptcy Attorney', url: 'https://www.aigig-test.example/jobs/law', company: 'micro1', location: 'Brazil', postedAt: NOW - DAY, meta: { employmentType: 'CONTRACTOR' } },
    { title: 'Software Engineer - Backend', url: 'https://www.aigig-test.example/jobs/be', company: 'Alignerr', location: 'Brazil', postedAt: NOW - DAY, meta: { employmentType: 'CONTRACTOR' } },
    { title: 'ML Engineer', url: 'https://www.aigig-test.example/jobs/noeng', company: 'Acme Test Co', location: 'Brazil', postedAt: NOW - DAY },
    { title: 'Machine Learning Engineer (US only)', url: 'https://www.aigig-test.example/jobs/us', company: 'micro1', location: 'USA Only', postedAt: NOW - DAY, meta: { employmentType: 'CONTRACTOR' } },
  ];
  const CLASSES = ['ai-ml-eng', 'data-science', 'data-eng', 'data-analytics', 'ai-eval'];
  const gated = runFunnel(gigs, { sourceId: 'gig', filters: { include: /NEVERMATCH/, exclude: /ML Engineer/i, latam: { accept: [], reject: [] } }, sinceDays: 7, snapshot: mk(), now: NOW, classes: CLASSES, engagements: ['freelance-gig', 'contract', 'employee'] });
  ok(gated.counts.new === 3 && gated.offers.map((o) => o.url.split('/').pop()).join() === 'ml,ds,emp',
    `class gate replaces the title gate (the include/exclude regexes are ignored): ml, ds, emp kept (${gated.offers.map((o) => o.url.split('/').pop())})`);
  ok(gated.counts.droppedClass === 4 && gated.counts.droppedTitle === 0, `class drops: labelling, attorney, backend, and the unknown engagement (${gated.counts.droppedClass} of 4; title drops ${gated.counts.droppedTitle})`);
  ok(gated.counts.droppedRegion === 1, 'the region gate still runs after the class gate');
  ok(gated.offers[0].note === 'remote-latam:gig freelance/ai-ml-eng $60-150/h', `label and pay in the note (${gated.offers[0].note})`);
  ok(gated.offers[1].note === 'remote-latam:gig freelance/data-science', `label without pay (${gated.offers[1].note})`);
  ok(gated.offers[2].note === 'remote-latam:gig employee/ai-ml-eng', `FULL_TIME is labelled employee (${gated.offers[2].note})`);
  const noEng = runFunnel(gigs, { sourceId: 'gig', filters, sinceDays: 7, snapshot: mk(), now: NOW, classes: CLASSES });
  ok(noEng.offers.some((o) => o.url.endsWith('/noeng')), '`classes` without `engagements` accepts an unknown engagement');
  ok(classGate({ domain: 'ai-ml-eng', engagement: 'unknown' }, { classes: CLASSES, engagements: ['employee'] }) === 'engagement'
    && classGate({ domain: 'non-tech', engagement: 'employee' }, { classes: CLASSES }) === 'class'
    && classGate({ domain: 'data-eng', engagement: 'employee' }, { classes: CLASSES, engagements: ['employee'] }) === null, 'classGate reasons: class, engagement, null');

  // a source with no `classes` keeps the title gate AND still gets a label in the note
  const plain = runFunnel([job({ url: 'https://acme-test.example/jobs/lbl', title: 'AI Governance Lead' })], { sourceId: 'stub', filters, sinceDays: 7, snapshot: mk(), now: NOW });
  ok(plain.offers[0]?.note === 'remote-latam:stub governance', `every source gets a class label (${plain.offers[0]?.note})`);
  const plainLoc = runFunnel([job({ url: 'https://acme-test.example/jobs/lbl2', title: 'AI Engineer', location: '' })], { sourceId: 'stub', filters, sinceDays: 7, snapshot: mk(), now: NOW });
  ok(plainLoc.offers[0]?.note === 'remote-latam:stub ai-ml-eng loc?', `label comes before loc? (${plainLoc.offers[0]?.note})`);
  ok(LOG_HEADER[LOG_HEADER.length - 1] === 'dropped_class', 'LOG_HEADER ends with dropped_class (older columns keep their positions)');

  // catalog: classes / engagements
  const cat = (extra) => `sources:\n  - id: g\n    provider: stub\n${extra}`;
  ok(JSON.stringify(parseCatalog(cat('    classes: [ai-ml-eng]\n    engagements: [freelance-gig]\n')).sources[0].classes) === '["ai-ml-eng"]', 'catalog accepts classes and engagements');
  throwsWith(() => parseCatalog(cat('    classes: [ai-engineering]\n')), /unknown classes "ai-engineering"/, 'an unknown class is rejected and named');
  throwsWith(() => parseCatalog(cat('    classes: [ai-ml-eng]\n    engagements: [gig]\n')), /unknown engagements "gig"/, 'an unknown engagement is rejected and named');
  throwsWith(() => parseCatalog(cat('    classes: []\n')), /non-empty list/, 'an empty classes list is rejected');
  throwsWith(() => parseCatalog(cat('    classes: ai-ml-eng\n')), /non-empty list/, 'classes must be a list');
  throwsWith(() => parseCatalog(cat('    engagements: [employee]\n')), /without `classes`/, 'engagements without classes is rejected');

  // ── CLI end to end, in a child process (stub providers, temp queue) ───────────
  const PIPELINE = join(TMP, 'pipeline.md');
  const HISTORY = join(TMP, 'scan-history.tsv');
  const LOG = join(TMP, 'remote-latam.tsv');
  const CATALOG = join(TMP, 'catalog.yml');
  const SKELETON = '# Pipeline\n\n## Pending\n\n## Processed\n';
  writeFileSync(PIPELINE, SKELETON);
  writeFileSync(CATALOG, [
    "filters:", "  include: '\\bAI\\b'", "  exclude: 'junior'",
    'sources:',
    '  - {id: alpha, provider: stub-a}',
    '  - {id: beta, provider: stub-b}',
    '  - {id: broken, provider: stub-broken}',
    '  - {id: nobody, provider: stub-missing}',
    '  - {id: off, provider: stub-a, enabled: false}',
  ].join('\n'));

  const CHILD = join(TMP, 'child.mjs');
  writeFileSync(CHILD, `
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const { main } = await import(process.env.RUNNER_URL);
const { PIPELINE, HISTORY, LOG, CATALOG, SKELETON } = process.env;
const DAY = 86400000;
const calls = { a: 0, b: 0 };
const providers = new Map([
  ['stub-a', { id: 'stub-a', fetch: async () => { calls.a++; return [
    { title: 'AI Platform Engineer', url: 'https://cli-test.example/a/1', company: 'Cli Test Co', location: 'LATAM', postedAt: Date.now() - DAY },
    { title: 'AI Agent Lead', url: 'https://cli-test.example/a/2', company: 'Cli Test Co', location: 'Remote' },
  ]; } }],
  ['stub-b', { id: 'stub-b', fetch: async () => { calls.b++; return [
    { title: 'AI Platform Engineer', url: 'https://cli-test.example/b/9', company: 'Cli Test Co', location: 'LATAM' },
    { title: 'AI Safety Engineer', url: 'https://cli-test.example/b/1', company: 'Beta Test Co', location: 'Brazil' },
  ]; } }],
  ['stub-broken', { id: 'stub-broken', fetch: async () => { throw new Error('HTTP 500 from the board'); } }],
]);
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
const steps = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const results = [];
for (const step of steps) {
  if (step.reset) { writeFileSync(PIPELINE, SKELETON); writeFileSync(HISTORY, ''); }
  if (step.preLog !== undefined) writeFileSync(LOG, step.preLog);
  const real = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  let code = null, error = '';
  try { code = await main(step.argv, { providers }); } catch (e) { error = String(e.message || e); } finally { console.log = real; }
  results.push({ argv: step.argv, code, error, out: lines.join('\\n'), pipeline: read(PIPELINE), history: read(HISTORY), log: read(LOG), calls: { ...calls } });
}
process.stdout.write(JSON.stringify(results));
`);
  const withCatalog = (args) => ['--catalog', CATALOG, ...args];
  const steps = [
    { argv: withCatalog(['--since', '7', '--dry-run', '--json']) },            // 0 dry run
    { argv: withCatalog(['--since', '7']) },                                   // 1 real run
    { argv: withCatalog(['--since', '7', '--json']) },                         // 2 second run
    { argv: withCatalog(['--source', 'off', '--dry-run', '--json']) },         // 3 --source on a disabled source
    { reset: true, argv: withCatalog(['--source', 'alpha', '--limit', '1', '--dry-run', '--json']) }, // 4 --limit
    { argv: ['--bogus'] },                                                     // 5 argument errors
    { argv: ['--since', '1', '--since', '2'] },                                // 6
    { argv: ['--since', '-1'] },                                               // 7
    { argv: ['--since'] },                                                     // 8
    { argv: withCatalog(['--source', 'nope']) },                               // 9
    { argv: ['--help'] },                                                      // 10
    { preLog: 'timestamp\tsource\tnew\n2026-01-01T00:00:00Z\told\t1\n', argv: withCatalog(['--source', 'alpha', '--dry-run', '--json']) }, // 11 log written by an older version
  ];
  const specFile = join(TMP, 'steps.json');
  writeFileSync(specFile, JSON.stringify(steps));
  const run = spawnSync(NODE, [CHILD, specFile], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, RUNNER_URL, PIPELINE, HISTORY, LOG, CATALOG, SKELETON,
      CAREER_OPS_PIPELINE: PIPELINE, CAREER_OPS_SCAN_HISTORY: HISTORY, CAREER_OPS_REMOTE_LATAM_LOG: LOG },
  });
  let R = [];
  try { R = JSON.parse(run.stdout); } catch { fail(`CLI child produced no JSON (exit ${run.status}): ${(run.stderr || run.stdout).slice(0, 300)}`); }

  if (R.length === steps.length) {
    const rows = (text) => text.split('\n').filter((l) => l.startsWith('- [ ] '));
    const json = (i) => JSON.parse(R[i].out.split('\n').find((l) => l.startsWith('{')));

    // dry run: reports, writes nothing
    ok(R[0].code === 2, 'exit code 2 when a source fails (broken + unknown provider)');
    const summary = json(0);
    ok(summary.new === 3 && summary.dryRun === true, `dry run reports 3 new (${summary.new})`);
    ok(rows(R[0].pipeline).length === 0, 'dry run leaves the queue untouched');
    ok(summary.sources.find((s) => s.id === 'broken').error.includes('HTTP 500'), 'a failing source records its error');
    ok(summary.sources.find((s) => s.id === 'nobody').error.includes('unknown provider'), 'an unknown provider is reported, not thrown');
    ok(summary.sources.some((s) => s.id === 'alpha') && !summary.sources.some((s) => s.id === 'off'), 'disabled sources are skipped');
    ok(summary.sources.find((s) => s.id === 'beta').counts.dupRole === 1, 'cross-source company+role dupe is caught');

    // real run: queue, history, sort, log
    const queued = rows(R[1].pipeline);
    ok(queued.length === 3, `3 rows appended (${queued.length})`);
    ok(queued.every((l) => /\| note: remote-latam:(alpha|beta)/.test(l)), 'rows carry the source note');
    ok(queued.some((l) => l.includes('posted:')), 'dated rows carry posted:');
    const hist = R[1].history.trim().split('\n');
    ok(hist[0].startsWith('url\t') && hist.length === 4, `scan-history has header + 3 rows (${hist.length})`);
    ok(hist.slice(1).every((l) => l.split('\t')[2].startsWith('remote-latam:')), 'history portal column names the source');
    const logLines = R[1].log.trim().split('\n');
    ok(logLines[0] === LOG_HEADER.join('\t'), 'run log has the header');
    ok(logLines.length > 1 && logLines.every((l) => l.split('\t').length === LOG_HEADER.length), 'every log row has one cell per column');

    // second run: everything is now known, queue byte-identical
    ok(json(2).new === 0, 'second run finds 0 new');
    ok(R[2].pipeline === R[1].pipeline, 'second run leaves the queue byte-identical');

    // --source targets one source, even a disabled one; --limit caps writes
    ok(R[3].calls.a === R[2].calls.a + 1, '--source runs a disabled source on request');
    ok(json(4).new === 1, '--limit caps the new rows');

    // argument errors and help
    ok(/unknown argument/.test(R[5].error), 'unknown flag is rejected');
    ok(/more than once/.test(R[6].error), 'repeated flag is rejected');
    ok(/>= 0/.test(R[7].error), 'negative --since is rejected');
    ok(/needs a value/.test(R[8].error), 'flag without value is rejected');
    ok(/no source "nope"/.test(R[9].error), 'unknown --source is reported');
    ok(R[10].code === 0 && /--dry-run/.test(R[10].out), '--help prints usage and exits 0');

    // a log written under an older header gets a fresh header before the new rows
    const old = R[11].log.trim().split('\n');
    ok(old[0].startsWith('timestamp\tsource\tnew') && old[1].startsWith('2026-01-01') && old[2] === LOG_HEADER.join('\t') && old[3].split('\t').length === LOG_HEADER.length,
      'a log with a different header keeps its old rows and gets the new header before the new ones');
  } else {
    fail(`CLI child returned ${R.length} results, expected ${steps.length}`);
  }

  // The real environment must be untouched by this suite.
  ok(process.env.CAREER_OPS_PIPELINE === undefined || !String(process.env.CAREER_OPS_PIPELINE).includes('remote-latam-runner-'),
    'this suite does not leak CAREER_OPS_* paths into the shared test process');
} catch (e) {
  fail(`remote-latam-runner test crashed: ${e.stack || e.message}`);
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
