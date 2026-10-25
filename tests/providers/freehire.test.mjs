// tests/providers/freehire.test.mjs — FreeHire JSON API provider. No network: ctx.fetchJson is a stub.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — freehire');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/freehire.mjs')).href);
  const fh = mod.default;
  const { normalizeFreehireJob, searchUrl, resolveParams } = mod;
  const ok = (cond, msg) => (cond ? pass(msg) : fail(msg));
  const NOW = Date.now();

  ok(fh.id === 'freehire' && fh.detect({ provider: 'freehire' })?.url, 'id and detect() claim an explicit provider entry');
  ok(fh.detect({ provider: 'remotive' }) === null && fh.detect(null) === null, 'detect() ignores other providers');

  const row = (n, extra = {}) => ({
    title: `AI Engineer ${n}`, url: `https://boards.example.com/job/${n}?utm_source=freehire.me`, company: 'Acme',
    location: 'Brazil', countries: ['br'], work_mode: 'remote', posted_at: new Date(NOW - 86_400_000).toISOString(), closed_at: null,
    enrichment: { summary: 'Builds agents.', employment_type: 'full_time' }, ...extra,
  });
  const j = normalizeFreehireJob(row(1));
  ok(j?.title === 'AI Engineer 1' && j.company === 'Acme' && j.location === 'Brazil (Remote)', 'maps title, company and location + work mode');
  ok(j?.postedAt === Date.parse(row(1).posted_at) && j.meta.employmentType === 'FULL_TIME' && j.description === 'Builds agents.', 'postedAt, employment type and summary travel');
  ok(normalizeFreehireJob(row(2, { location: '', countries: ['br', 'ar'], work_mode: 'hybrid' }))?.location === 'Brazil, Argentina (Hybrid)', 'no location text: country codes become names');
  ok(normalizeFreehireJob(row(3, { closed_at: '2026-10-01T00:00:00Z' })) === null, 'closed posting dropped');
  ok(normalizeFreehireJob(row(4, { url: 'http://x.example/1' })) === null && normalizeFreehireJob(row(5, { title: ' ' })) === null, 'non-https url and empty title dropped');
  ok([null, 'x', 7].every((v) => normalizeFreehireJob(v) === null), 'non-objects dropped');

  const p = resolveParams({ queries: ['ai engineer'], work_mode: 'remote' });
  const u = new URL(searchUrl(p, 'ai engineer', 50, 4));
  ok(u.searchParams.get('regions') === 'latam' && u.searchParams.get('countries') === 'br' && u.searchParams.get('posted_within_days') === '4'
    && u.searchParams.get('offset') === '50' && u.searchParams.get('work_mode') === 'remote' && u.searchParams.get('sort') === 'posted_at',
  'search URL carries the geography OR-group, window, offset, mode and sort');

  const harness = (pages) => {
    const urls = [];
    const sleeps = [];
    return { urls, sleeps, ctx: { sinceMs: NOW - 4 * 86_400_000, sleep: async (ms) => { sleeps.push(ms); }, fetchJson: async (url, opts) => { urls.push({ url, opts }); const r = pages.shift(); if (r instanceof Error) throw r; return r; } } };
  };

  let h = harness([{ data: [row(1), row(2)], meta: {} }, { data: [row(2)], meta: {} }]);
  let out = await fh.fetch({ queries: ['a', 'b'], limit: 50 }, h.ctx);
  ok(h.urls.length === 2 && out.length === 2, 'a short page ends that query; the same url from two queries is returned once');
  ok(h.urls.every((r) => r.opts.redirect === 'error' && /career-ops/.test(r.opts.headers['User-Agent'])), "redirect:'error' and an identifying User-Agent on every request");
  ok(h.sleeps.length === 1, 'a pause between requests, none before the first');

  h = harness([{ data: Array.from({ length: 2 }, (_, i) => row(i)), meta: {} }, { data: [row(9)], meta: {} }]);
  out = await fh.fetch({ queries: ['a'], limit: 2, max_pages: 2 }, h.ctx);
  ok(h.urls.length === 2 && new URL(h.urls[1].url).searchParams.get('offset') === '2' && out.length === 3, 'a full page pages on with offset += limit, up to max_pages');
  h = harness([{ data: [row(1), row(2)], meta: {} }]);
  await fh.fetch({ queries: ['a'], limit: 2, max_pages: 5 }, { ...h.ctx, maxPages: 1 });
  ok(h.urls.length === 1, 'ctx.maxPages (health probe) is a single request');

  let err = null;
  h = harness([{ data: [], meta: { ignored_params: [{ param: 'country' }] } }]);
  try { await fh.fetch({ queries: ['a'] }, h.ctx); } catch (e) { err = e; }
  ok(err && /ignored/.test(err.message), 'meta.ignored_params throws (a typo must not scan the whole catalogue)');
  err = null;
  h = harness([{ nope: 1 }]);
  try { await fh.fetch({ queries: ['a'] }, h.ctx); } catch (e) { err = e; }
  ok(err && /unexpected/.test(err.message), 'a response without data[] throws');

  for (const bad of [{}, { queries: [] }, { queries: [''] }, { queries: ['a'], work_mode: 'moon' }, { queries: ['a'], countries: ['brazil'] }, { queries: ['a'], regions: ['La Tam'] }, { queries: Array(13).fill('a') }]) {
    err = null;
    h = harness([]);
    try { await fh.fetch(bad, h.ctx); } catch (e) { err = e; }
    if (!(err && h.urls.length === 0)) fail(`entry ${JSON.stringify(bad).slice(0, 60)}: expected a throw before any request`);
  }
  pass('invalid entries throw before the first request');
} catch (e) {
  fail(`freehire test crashed: ${e.stack || e.message}`);
}
