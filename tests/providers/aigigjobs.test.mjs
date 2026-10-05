// tests/providers/aigigjobs.test.mjs — AIGigJobs JSON-LD provider.
// No network: stub ctx.fetchText and a stub clock (ctx.sleep) so the 5 s crawl delay is observable.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — aigigjobs');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/aigigjobs.mjs')).href);
  const { resolveProvider } = await import(pathToFileURL(join(ROOT, 'providers/_registry.mjs')).href);
  const aigig = mod.default;
  const { normalizeAigigJob, DEFAULT_PAGES } = mod;
  const ok = (cond, msg) => (cond ? pass(msg) : fail(msg));
  const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
  const iso = (ms) => new Date(ms).toISOString();
  const DAY = 86_400_000;

  ok(aigig.id === 'aigigjobs', 'id is "aigigjobs"');
  ok(aigig.detect({ provider: 'aigigjobs' })?.url === 'https://www.aigigjobs.com', 'detect() claims an explicit provider entry');
  ok([aigig.detect({ name: 'X' }), aigig.detect({ provider: 'remotive' }), aigig.detect({ careers_url: 'https://www.aigigjobs.com/' }), aigig.detect(null)].every((m) => m === null),
    'detect() returns null for missing, other-provider, URL-only and null entries');
  const resolved = resolveProvider({ name: 'A', provider: 'aigigjobs' }, new Map([['aigigjobs', aigig]]));
  ok(resolved && 'provider' in resolved && resolved.provider === aigig, 'registry dispatches an explicit aigigjobs entry');

  // normalizeAigigJob
  const base = {
    '@type': 'JobPosting', title: '  Machine Learning Engineer  ', url: 'https://www.aigigjobs.com/jobs/ml-engineer-micro1-abc',
    description: '<p>Build &amp; evaluate agents</p><script>alert(1)</script>', datePosted: iso(NOW - DAY), validThrough: iso(NOW + 30 * DAY),
    hiringOrganization: { '@type': 'Organization', name: 'micro1' }, employmentType: 'CONTRACTOR', jobLocationType: 'TELECOMMUTE',
    applicantLocationRequirements: { '@type': 'Country', name: 'Brazil' },
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressCountry: 'US' } },
    baseSalary: { '@type': 'MonetaryAmount', currency: 'USD', value: { '@type': 'QuantitativeValue', minValue: 60, maxValue: 150, unitText: 'HOUR' } },
  };
  const j = normalizeAigigJob(base, NOW);
  ok(j && j.title === 'Machine Learning Engineer' && j.url === base.url && j.company === 'micro1' && j.postedAt === NOW - DAY,
    'maps title, posting url, company and datePosted -> ms');
  ok(j?.location === 'Brazil', 'a single applicant country is the location; the company base country in jobLocation is ignored');
  ok(j?.description === 'Build & evaluate agents', 'description: tags and <script> removed, entities decoded after');
  ok(j?.meta?.employmentType === 'CONTRACTOR' && JSON.stringify(j.meta.pay) === JSON.stringify({ min: 60, max: 150, currency: 'USD', unit: 'HOUR' }),
    'employmentType and pay travel in meta');
  ok(j && !('salary' in j), 'pay is NOT in `salary` (the queue would render it without a unit)');

  const multi = normalizeAigigJob({ ...base, applicantLocationRequirements: [{ name: 'Mexico' }, { name: 'Argentina' }, { name: 'Mexico' }] }, NOW);
  ok(multi?.location === 'Mexico, Argentina', 'several applicant countries are joined and de-duplicated');
  const locality = normalizeAigigJob({ ...base, applicantLocationRequirements: undefined, jobLocation: { address: { addressLocality: 'Mexico' } } }, NOW);
  ok(locality?.location === 'Mexico', 'no applicant countries: the PostalAddress locality is used');
  const remote = normalizeAigigJob({ ...base, applicantLocationRequirements: undefined, jobLocation: undefined }, NOW);
  ok(remote?.location === 'Remote', 'no place at all but TELECOMMUTE: "Remote"');
  const none = normalizeAigigJob({ ...base, applicantLocationRequirements: undefined, jobLocation: undefined, jobLocationType: undefined }, NOW);
  ok(none?.location === '', 'no place and not remote: empty location');
  ok(normalizeAigigJob({ ...base, hiringOrganization: { name: 'via Alignerr' } }, NOW)?.company === 'Alignerr', 'a "via " prefix is stripped from the company');
  ok(normalizeAigigJob({ ...base, hiringOrganization: undefined }, NOW)?.company === 'AIGigJobs', 'no organization: falls back to AIGigJobs');
  const nopay = normalizeAigigJob({ ...base, baseSalary: undefined }, NOW);
  ok(nopay && !('pay' in nopay.meta), 'no salary: no pay in meta');
  const annual = normalizeAigigJob({ ...base, baseSalary: { currency: 'USD', value: { minValue: 200000, maxValue: 200000, unitText: 'HOUR' } } }, NOW);
  ok(annual?.meta?.pay?.max === 200000 && annual.meta.pay.unit === 'HOUR', 'an annual salary marked HOUR is passed through untouched (job-class normalizes it)');
  ok(normalizeAigigJob({ ...base, baseSalary: { value: { value: 90 } } }, NOW)?.meta?.pay?.min === 90, 'a single `value` becomes both bounds');
  ok(normalizeAigigJob({ ...base, validThrough: iso(NOW - DAY) }, NOW) === null, 'an expired posting (validThrough) is dropped');
  ok(normalizeAigigJob({ ...base, validThrough: 'garbage' }, NOW) !== null, 'an unparseable validThrough does not drop the posting');
  ok(normalizeAigigJob({ ...base, title: '  ' }, NOW) === null, 'no title: dropped');
  ok(normalizeAigigJob({ ...base, url: undefined }, NOW) === null, 'no url: dropped');
  ok(normalizeAigigJob({ ...base, url: 'https://evil.example/jobs/x' }, NOW) === null, 'a url outside www.aigigjobs.com is dropped');
  ok(normalizeAigigJob({ ...base, url: 'http://www.aigigjobs.com/jobs/x' }, NOW) === null, 'a non-https url is dropped');
  ok(normalizeAigigJob({ ...base, url: 'https://www.aigigjobs.com.evil.example/jobs/x' }, NOW) === null, 'a look-alike host is dropped');
  ok([null, undefined, 'x', 7].every((v) => normalizeAigigJob(v, NOW) === null), 'non-objects are dropped');
  ok(normalizeAigigJob({ ...base, datePosted: undefined }, NOW)?.postedAt === undefined, 'no datePosted: postedAt stays unset');

  // fetch harness
  const ld = (...nodes) => nodes.map((n) => `<script type="application/ld+json">${JSON.stringify(n)}</script>`).join('\n');
  const posting = (slug, extra = {}) => ({ ...base, description: 'plain', title: `Role ${slug}`, url: `https://www.aigigjobs.com/jobs/${slug}`, datePosted: iso(Date.now() - DAY), validThrough: iso(Date.now() + 30 * DAY), ...extra });
  const harness = (pages, extra = {}) => {
    const requested = [];
    const sleeps = [];
    const ctx = {
      fetchText: async (url, opts) => {
        requested.push({ url, redirect: opts?.redirect });
        const key = url.replace('https://www.aigigjobs.com/', '');
        const page = pages[key] ?? pages['*'];
        if (page instanceof Error) throw page;
        return page;
      },
      sleep: async (ms) => { sleeps.push(ms); },
      ...extra,
    };
    return { requested, sleeps, ctx };
  };

  let h = harness({ '*': `<html>${ld(posting('a'), posting('b'))}</html>` });
  let out = await aigig.fetch({ name: 'AIGigJobs', pages: ['locations/brazil', 'skills/python'] }, h.ctx);
  ok(h.requested.length === 2 && h.requested[0].url === 'https://www.aigigjobs.com/locations/brazil' && h.requested[1].url === 'https://www.aigigjobs.com/skills/python',
    'requests exactly the configured pages, in order');
  ok(h.requested.every((r) => r.redirect === 'error'), "every request uses redirect:'error'");
  ok(out.length === 2, 'the same posting on two pages is returned once');
  ok(h.sleeps.length === 1 && h.sleeps[0] === 5000, 'one 5000 ms pause between two pages (the robots.txt Crawl-delay), none before the first');

  h = harness({ '*': `${ld(posting('a'))}` });
  await aigig.fetch({ name: 'A' }, h.ctx);
  ok(h.requested.length === DEFAULT_PAGES.length && h.sleeps.length === DEFAULT_PAGES.length - 1 && h.sleeps.every((ms) => ms === 5000),
    `default pages (${DEFAULT_PAGES.length}) are used when the entry has none, all paced at 5000 ms`);

  h = harness({ '*': `${ld(posting('a'))}` });
  await aigig.fetch({ name: 'A' }, { ...h.ctx, maxPages: 1 });
  ok(h.requested.length === 1 && h.sleeps.length === 0, 'ctx.maxPages: 1 (health probe) is exactly one request and no pause');

  // JSON-LD shapes
  h = harness({ '*': ld([posting('arr1'), posting('arr2')], { '@graph': [posting('g1'), { '@type': 'WebSite', name: 'x' }] }, { '@type': 'Organization', name: 'x' }) });
  out = await aigig.fetch({ name: 'A', pages: ['skills/python'] }, h.ctx);
  ok(out.map((o) => o.url.split('/').pop()).sort().join() === 'arr1,arr2,g1', 'JSON-LD as object, array and @graph; non-JobPosting nodes ignored');
  h = harness({ '*': `<script type="application/ld+json">{not json</script>${ld(posting('ok'))}` });
  out = await aigig.fetch({ name: 'A', pages: ['skills/python'] }, h.ctx);
  ok(out.length === 1, 'a malformed JSON-LD block does not hide the others');
  h = harness({ '*': `<html>${ld({ '@type': 'WebSite' })}</html>` });
  out = await aigig.fetch({ name: 'A', pages: ['skills/python'] }, h.ctx);
  ok(Array.isArray(out) && out.length === 0, 'a page with JSON-LD blocks but no postings is an empty result, not an error');

  let err = null;
  h = harness({ '*': '<html><body>Just a moment...</body></html>' });
  try { await aigig.fetch({ name: 'A', pages: ['skills/python'] }, h.ctx); } catch (e) { err = e; }
  ok(err && /no JSON-LD/.test(err.message), 'a page without any JSON-LD throws (layout change is loud)');

  // validation happens before any request
  for (const bad of [['https://evil.example/x'], ['../etc/passwd'], ['skills/Python'], ['jobs/x'], ['skills/'], [''], [7], 'skills/python', []]) {
    err = null;
    h = harness({ '*': ld(posting('a')) });
    try { await aigig.fetch({ name: 'A', pages: bad }, h.ctx); } catch (e) { err = e; }
    if (!(err && h.requested.length === 0)) fail(`pages ${JSON.stringify(bad)}: expected a throw before any request (requests: ${h.requested.length})`);
  }
  pass('invalid pages (host, traversal, case, unknown section, empty, non-string, non-list) throw before the first request');
  err = null;
  h = harness({ '*': ld(posting('a')) });
  try { await aigig.fetch({ name: 'A', pages: Array.from({ length: 21 }, (_, i) => `skills/s${i}`) }, h.ctx); } catch (e) { err = e; }
  ok(err && /cap/.test(err.message) && h.requested.length === 0, 'more than 20 pages throws before any request');
  h = harness({ '*': ld(posting('a')) });
  await aigig.fetch({ name: 'A', pages: ['/skills/python', 'skills/python'] }, h.ctx);
  ok(h.requested.length === 1, 'a leading slash is tolerated and duplicate pages are fetched once');

  // errors
  const notFound = Object.assign(new Error('HTTP 404'), { status: 404 });
  err = null;
  h = harness({ '*': notFound });
  try { await aigig.fetch({ name: 'A', pages: ['skills/python'] }, h.ctx); } catch (e) { err = e; }
  ok(err === notFound, 'a non-retryable fetch failure propagates unwrapped');
  let attempts = 0;
  out = await aigig.fetch({ name: 'A', pages: ['skills/python'] }, {
    fetchText: async () => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('HTTP 503'), { status: 503 });
      return ld(posting('a'));
    },
    sleep: async () => {},
  });
  ok(attempts === 2 && out.length === 1, 'a transient 503 is retried');
} catch (e) {
  fail(`aigigjobs test crashed: ${e.stack || e.message}`);
}
