// tests/providers/tryremotely.test.mjs — TryRemotely public JSON API provider.
// No network: stub ctx.fetchJson and a stub clock (ctx.sleep) so pacing is observable
// without waiting.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — tryremotely');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/tryremotely.mjs')).href);
  const { resolveProvider } = await import(pathToFileURL(join(ROOT, 'providers/_registry.mjs')).href);
  const tryremotely = mod.default;
  const { normalizeTryRemotelyJob } = mod;
  const API = 'https://tryremotely.com/api/v1/job-listings';
  const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
  const sec = (ms) => Math.floor(ms / 1000);
  const DAY = 86_400_000;

  if (tryremotely.id === 'tryremotely') pass('tryremotely.id is "tryremotely"');
  else fail(`tryremotely.id is ${JSON.stringify(tryremotely.id)}`);

  const hit = tryremotely.detect({ name: 'TryRemotely', provider: 'tryremotely' });
  if (hit?.url === API) pass('tryremotely.detect() claims an explicit provider entry');
  else fail(`tryremotely.detect() explicit = ${JSON.stringify(hit)}`);
  const misses = [
    tryremotely.detect({ name: 'X' }),
    tryremotely.detect({ name: 'X', provider: 'remotive' }),
    tryremotely.detect({ name: 'X', careers_url: 'https://tryremotely.com/jobs' }),
    tryremotely.detect(null),
    tryremotely.detect(undefined),
  ];
  if (misses.every((m) => m === null)) pass('tryremotely.detect() returns null for missing, other-provider, URL-only and non-object entries');
  else fail(`tryremotely.detect() misses = ${JSON.stringify(misses)}`);
  const resolved = resolveProvider({ name: 'T', provider: 'tryremotely' }, new Map([['tryremotely', tryremotely]]));
  if (resolved && 'provider' in resolved && resolved.provider === tryremotely) pass('registry dispatches an explicit tryremotely entry');
  else fail(`registry did not dispatch tryremotely: ${JSON.stringify(resolved)}`);

  // normalizeTryRemotelyJob — mapping.
  const base = {
    slug: 'senior-ai-engineer-1', title: '  Senior AI Engineer  ', companyName: '  Acme Test Co  ', workModel: 'Remote',
    locations: ['Brazil', ' Argentina '], pubDate: sec(NOW - DAY), expiryDate: sec(NOW + 10 * DAY),
    applicationLink: 'https://tryremotely.com/job/senior-ai-engineer-1',
    description: '<h3>About</h3><ul><li>Build agents &amp; evals</li></ul><script>alert(1)</script>',
  };
  const full = normalizeTryRemotelyJob(base, 'Fallback', NOW);
  if (full && full.title === 'Senior AI Engineer' && full.url === 'https://tryremotely.com/job/senior-ai-engineer-1'
      && full.company === 'Acme Test Co' && full.location === 'Brazil, Argentina' && full.postedAt === (NOW - DAY)) {
    pass('maps title, listing url, company, joined locations, pubDate seconds -> ms');
  } else {
    fail(`full row = ${JSON.stringify(full)}`);
  }
  if (full?.description === 'About Build agents & evals') pass('description: HTML becomes plain text, <script> removed, entities decoded after tag removal');
  else fail(`description = ${JSON.stringify(full?.description)}`);

  const hybrid = normalizeTryRemotelyJob({ ...base, workModel: 'Hybrid', locations: ['Toronto'] }, undefined, NOW);
  const onsite = normalizeTryRemotelyJob({ ...base, workModel: 'On-site', locations: [] }, undefined, NOW);
  if (hybrid?.location === 'Toronto (Hybrid)' && onsite?.location === '(On-site)') pass('a non-remote workModel is appended so a region gate can see it');
  else fail(`workModel handling = ${JSON.stringify({ h: hybrid?.location, o: onsite?.location })}`);
  const worldwide = normalizeTryRemotelyJob({ ...base, locations: ['Worldwide'], workModel: 'remote' }, undefined, NOW);
  if (worldwide?.location === 'Worldwide') pass('"remote" workModel adds nothing (case-insensitive)');
  else fail(`remote workModel location = ${JSON.stringify(worldwide?.location)}`);

  const viaGuid = normalizeTryRemotelyJob({ ...base, applicationLink: 'https://elsewhere.example/apply', guid: 'https://tryremotely.com/job/via-guid' }, undefined, NOW);
  if (viaGuid?.url === 'https://tryremotely.com/job/via-guid') pass('url falls back to guid when applicationLink is not a tryremotely.com listing');
  else fail(`guid fallback = ${JSON.stringify(viaGuid?.url)}`);

  const noCo = normalizeTryRemotelyJob({ ...base, companyName: '  ' }, 'Entry Name', NOW);
  const noCoAtAll = normalizeTryRemotelyJob({ ...base, companyName: undefined }, undefined, NOW);
  if (noCo?.company === 'Entry Name' && noCoAtAll?.company === 'TryRemotely') pass('company falls back companyName -> entry name -> "TryRemotely"');
  else fail(`company fallbacks = ${JSON.stringify({ a: noCo?.company, b: noCoAtAll?.company })}`);

  const noDate = normalizeTryRemotelyJob({ ...base, pubDate: undefined }, undefined, NOW);
  const nanDate = normalizeTryRemotelyJob({ ...base, pubDate: 'oops' }, undefined, NOW);
  const zeroDate = normalizeTryRemotelyJob({ ...base, pubDate: 0 }, undefined, NOW);
  if ([noDate, nanDate, zeroDate].every((r) => r && !('postedAt' in r))) pass('postedAt is omitted for absent, non-numeric or zero pubDate (NaN-safe)');
  else fail(`date handling = ${JSON.stringify({ noDate, nanDate, zeroDate })}`);

  const noLocations = normalizeTryRemotelyJob({ ...base, locations: 'Brazil' }, undefined, NOW);
  if (noLocations && noLocations.location === '') pass('a non-array locations value yields an empty location, not a throw');
  else fail(`non-array locations = ${JSON.stringify(noLocations)}`);

  const drops = [
    ['no title', normalizeTryRemotelyJob({ ...base, title: '' }, undefined, NOW)],
    ['blank title', normalizeTryRemotelyJob({ ...base, title: '   ' }, undefined, NOW)],
    ['no listing url', normalizeTryRemotelyJob({ ...base, applicationLink: undefined, guid: undefined }, undefined, NOW)],
    ['foreign host', normalizeTryRemotelyJob({ ...base, applicationLink: 'https://evil.example/job/x', guid: undefined }, undefined, NOW)],
    ['http url', normalizeTryRemotelyJob({ ...base, applicationLink: 'http://tryremotely.com/job/x', guid: undefined }, undefined, NOW)],
    ['suffix-spoofed host', normalizeTryRemotelyJob({ ...base, applicationLink: 'https://tryremotely.com.evil.example/job/x', guid: undefined }, undefined, NOW)],
    ['expired posting', normalizeTryRemotelyJob({ ...base, expiryDate: sec(NOW - DAY) }, undefined, NOW)],
    ['null', normalizeTryRemotelyJob(null, undefined, NOW)],
    ['string', normalizeTryRemotelyJob('nope', undefined, NOW)],
  ];
  const kept = drops.filter(([, r]) => r !== null).map(([label]) => label);
  if (kept.length === 0) pass('drops: no/blank title, no or foreign/http/spoofed listing url, expired, non-object');
  else fail(`these should have been dropped: ${kept.join(', ')}`);

  // fetch(): pagination.
  const mk = (i, ageMs = DAY) => ({
    slug: `role-${i}`, title: `Role ${i}`, companyName: `Co ${i}`, workModel: 'Remote', locations: ['Worldwide'],
    pubDate: sec(Date.now() - ageMs), expiryDate: sec(Date.now() + 30 * DAY), applicationLink: `https://tryremotely.com/job/role-${i}`,
  });
  const page = (n, from, ageMs) => ({ usage: 'x', total_count: 86328, jobs: Array.from({ length: n }, (_, i) => mk(from + i, ageMs)) });
  const harness = (pages, extra = {}) => {
    const requested = [];
    const sleeps = [];
    const ctx = {
      fetchJson: async (url, opts) => {
        requested.push({ url, redirect: opts?.redirect });
        const offset = Number(new URL(url).searchParams.get('offset'));
        return pages[offset / 100] ?? { jobs: [] };
      },
      sleep: async (ms) => { sleeps.push(ms); },
      ...extra,
    };
    return { requested, sleeps, ctx };
  };

  let h = harness([page(100, 0), page(100, 100), page(37, 200)]);
  let out = await tryremotely.fetch({ name: 'TryRemotely', max_pages: 5 }, h.ctx);
  const wantUrls = [`${API}?offset=0&limit=100`, `${API}?offset=100&limit=100`, `${API}?offset=200&limit=100`];
  if (JSON.stringify(h.requested.map((r) => r.url)) === JSON.stringify(wantUrls)) pass('paginates with ?offset=N&limit=100 and stops at the first short page');
  else fail(`requested = ${JSON.stringify(h.requested.map((r) => r.url))}`);
  if (out.length === 237) pass('aggregates the postings of every page (100 + 100 + 37)');
  else fail(`fetch() returned ${out.length} jobs (expected 237)`);
  if (h.requested.every((r) => r.redirect === 'error')) pass('passes redirect:"error" on every page (SSRF guard)');
  else fail(`redirect opts = ${JSON.stringify(h.requested.map((r) => r.redirect))}`);
  if (h.sleeps.length === 2 && h.sleeps.every((ms) => ms >= 600)) pass(`paces pages through the shared sleep (${h.sleeps.length} pauses of ${h.sleeps[0]} ms, none before page 1)`);
  else fail(`sleeps = ${JSON.stringify(h.sleeps)}`);

  // the entry's own cap, never the source's total_count (86k).
  h = harness([page(100, 0), page(100, 100), page(100, 200), page(100, 300)]);
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try { out = await tryremotely.fetch({ name: 'TryRemotely', max_pages: 2 }, h.ctx); } finally { console.error = realError; }
  if (h.requested.length === 2 && out.length === 200) pass('max_pages caps the walk even though total_count is 86328 and every page is full');
  else fail(`max_pages:2 requested ${h.requested.length} pages / ${out.length} jobs`);
  if (errors.length === 1 && /truncated at max_pages=2/.test(errors[0]) && /raise max_pages/.test(errors[0])) pass('warns "raise max_pages" when the entry cap cut the list');
  else fail(`truncation warning = ${JSON.stringify(errors)}`);

  // default cap and hard ceiling.
  h = harness(Array.from({ length: 60 }, (_, i) => page(100, i * 100)));
  console.error = () => {};
  try { await tryremotely.fetch({ name: 'T' }, h.ctx); } finally { console.error = realError; }
  const defaultPages = h.requested.length;
  h = harness(Array.from({ length: 60 }, (_, i) => page(100, i * 100)));
  console.error = () => {};
  try { await tryremotely.fetch({ name: 'T', max_pages: 9999 }, h.ctx); } finally { console.error = realError; }
  if (defaultPages === 20 && h.requested.length === 50) pass(`default cap is 20 pages and a user override is clamped to 50 (got ${defaultPages} and ${h.requested.length})`);
  else fail(`default/ceiling pages = ${defaultPages} / ${h.requested.length}`);

  // sinceMs early stop: newest-first, so an out-of-window last row ends the walk.
  h = harness([page(100, 0, 20 * DAY), page(100, 100, 21 * DAY)], { sinceMs: Date.now() - 7 * DAY });
  out = await tryremotely.fetch({ name: 'T', max_pages: 5 }, h.ctx);
  if (h.requested.length === 1) pass('stops after the first page when its oldest posting is already outside ctx.sinceMs');
  else fail(`sinceMs early stop requested ${h.requested.length} pages`);
  h = harness([page(100, 0, DAY), page(40, 100, 2 * DAY)], { sinceMs: Date.now() - 7 * DAY });
  await tryremotely.fetch({ name: 'T', max_pages: 5 }, h.ctx);
  if (h.requested.length === 2) pass('keeps walking while the page is still inside ctx.sinceMs');
  else fail(`in-window walk requested ${h.requested.length} pages`);

  // probe cooperation: ctx.maxPages: 1 => exactly one list request, and no warning.
  h = harness([page(100, 0), page(100, 100)], { maxPages: 1 });
  const probeErrors = [];
  console.error = (...a) => probeErrors.push(a.join(' '));
  try { await tryremotely.fetch({ name: 'T', max_pages: 5 }, h.ctx); } finally { console.error = realError; }
  if (h.requested.length === 1) pass('under ctx.maxPages: 1 exactly one list request is made');
  else fail(`probe made ${h.requested.length} requests`);
  if (probeErrors.length === 0) pass('a probe cut-off (ctx.maxPages) never prints the "raise max_pages" warning');
  else fail(`probe printed: ${JSON.stringify(probeErrors)}`);

  // empty vs broken.
  h = harness([{ jobs: [] }]);
  out = await tryremotely.fetch({ name: 'T' }, h.ctx);
  if (Array.isArray(out) && out.length === 0 && h.requested.length === 1) pass('a documented-but-empty { jobs: [] } returns [] after one request');
  else fail(`empty jobs = ${JSON.stringify(out)} / ${h.requested.length} requests`);
  for (const [label, body] of [['an array', []], ['null', null], ['an object without jobs', { error: 'nope', status: 500 }]]) {
    let message = '';
    try { await tryremotely.fetch({ name: 'T' }, { fetchJson: async () => body, sleep: async () => {} }); } catch (err) { message = err.message; }
    if (/unexpected API response/.test(message)) pass(`throws on ${label}${body && !Array.isArray(body) ? ' and names the keys received' : ''}`);
    else fail(`should throw on ${label}, got "${message}"`);
  }
  let keysMsg = '';
  try { await tryremotely.fetch({ name: 'T' }, { fetchJson: async () => ({ error: 'x', status: 1 }) }); } catch (err) { keysMsg = err.message; }
  if (/keys: \[error, status\]/.test(keysMsg)) pass('the error names the keys the API actually returned');
  else fail(`keys message = ${keysMsg}`);

  // a non-retryable failure propagates as the very same error.
  const notFound = Object.assign(new Error('HTTP 404'), { status: 404 });
  let seen = null;
  try { await tryremotely.fetch({ name: 'T' }, { fetchJson: async () => { throw notFound; }, sleep: async () => {} }); } catch (err) { seen = err; }
  if (seen === notFound) pass('a non-retryable ctx.fetchJson rejection propagates unwrapped');
  else fail('fetch() must not wrap a ctx.fetchJson rejection');

  // a transient failure is retried (bounded) and then succeeds.
  let attempts = 0;
  const flaky = {
    fetchJson: async () => { attempts++; if (attempts === 1) throw Object.assign(new Error('HTTP 503'), { status: 503 }); return { jobs: [mk(1)] }; },
    sleep: async () => {},
  };
  out = await tryremotely.fetch({ name: 'T' }, flaky);
  if (attempts === 2 && out.length === 1) pass('a 503 is retried once and the page then succeeds');
  else fail(`retry: attempts=${attempts}, jobs=${out.length}`);
} catch (e) {
  fail(`tryremotely provider tests crashed: ${e.stack || e.message}`);
}
