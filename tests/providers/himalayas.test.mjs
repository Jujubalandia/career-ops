// tests/providers/himalayas.test.mjs — moved verbatim from test-all.mjs (#1440).
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — himalayas');

try {
  const himalayasModule = await import(pathToFileURL(join(ROOT, 'providers/himalayas.mjs')).href);
  const himalayas = himalayasModule.default;
  const { parseHimalayasResponse } = himalayasModule;

  if (himalayas.id === 'himalayas') pass('himalayas.id is "himalayas"');
  else fail(`himalayas.id is ${JSON.stringify(himalayas.id)}`);

  const hit = himalayas.detect({ name: 'Himalayas', provider: 'himalayas' });
  if (hit && hit.url === 'https://himalayas.app/jobs/api?limit=50') {
    pass('himalayas.detect() claims explicit provider config');
  } else {
    fail(`himalayas.detect() returned ${JSON.stringify(hit)}`);
  }

  if (himalayas.detect({ name: 'Remote Board', provider: 'remotive' }) === null) {
    pass('himalayas.detect() ignores other provider ids');
  } else {
    fail('himalayas.detect() should only claim provider: himalayas');
  }

  const sample = {
    jobs: [
      {
        title: '  Staff AI Engineer  ',
        companyName: ' Acme Labs ',
        companySlug: 'acme-labs',
        locationRestrictions: ['Worldwide', 'Europe'],
        pubDate: 1782538666,
        applicationLink: 'https://himalayas.app/companies/acme-labs/jobs/staff-ai-engineer',
        guid: 'https://himalayas.app/companies/acme-labs/jobs/staff-ai-engineer-guid',
      },
      {
        title: 'Product Manager',
        companyName: 'Fallback Co',
        companySlug: 'fallback-co',
        locationRestrictions: [],
        pubDate: '2026-01-02T09:00:00Z',
        applicationLink: '',
        guid: 'https://himalayas.app/companies/fallback-co/jobs/product-manager',
      },
      {
        title: 'Missing Link Role',
        companyName: 'Dropped Co',
        locationRestrictions: ['United States'],
      },
      {
        title: 'Off Host Role',
        companyName: 'Bad Co',
        locationRestrictions: ['Remote'],
        applicationLink: 'https://example.com/companies/bad/jobs/off-host',
      },
      {
        title: 'HTTP Role',
        companyName: 'Bad Scheme Co',
        locationRestrictions: ['Remote'],
        applicationLink: 'http://himalayas.app/companies/bad/jobs/http-role',
      },
      {
        title: '   ',
        companyName: 'Blank Title Co',
        locationRestrictions: ['Remote'],
        applicationLink: 'https://himalayas.app/companies/blank/jobs/blank-title',
      },
    ],
  };
  const jobs = parseHimalayasResponse(sample);

  if (jobs.length === 2) pass('parseHimalayasResponse keeps 2 jobs (drops missing/off-host/http/blank-title rows)');
  else fail(`parseHimalayasResponse returned ${jobs.length} jobs (expected 2)`);

  if (jobs[0]?.title === 'Staff AI Engineer' && jobs[0]?.company === 'Acme Labs') {
    pass('parseHimalayasResponse trims title and companyName');
  } else {
    fail(`row 0 title/company = ${JSON.stringify({ title: jobs[0]?.title, company: jobs[0]?.company })}`);
  }

  if (jobs[0]?.location === 'Worldwide, Europe') {
    pass('parseHimalayasResponse joins locationRestrictions');
  } else {
    fail(`row 0 location = ${JSON.stringify(jobs[0]?.location)}`);
  }

  if (jobs[0]?.url === 'https://himalayas.app/companies/acme-labs/jobs/staff-ai-engineer') {
    pass('parseHimalayasResponse maps applicationLink to url');
  } else {
    fail(`row 0 url = ${JSON.stringify(jobs[0]?.url)}`);
  }

  if (jobs[0]?.postedAt === 1782538666 * 1000) {
    pass('parseHimalayasResponse converts epoch seconds pubDate -> postedAt ms');
  } else {
    fail(`row 0 postedAt = ${JSON.stringify(jobs[0]?.postedAt)}`);
  }

  if (jobs[1]?.url === 'https://himalayas.app/companies/fallback-co/jobs/product-manager') {
    pass('parseHimalayasResponse falls back to guid when applicationLink is missing');
  } else {
    fail(`row 1 url = ${JSON.stringify(jobs[1]?.url)}`);
  }

  if (jobs[1]?.postedAt === Date.parse('2026-01-02T09:00:00Z')) {
    pass('parseHimalayasResponse parses string pubDate -> postedAt');
  } else {
    fail(`row 1 postedAt = ${JSON.stringify(jobs[1]?.postedAt)}`);
  }

  if (parseHimalayasResponse({}).length === 0 && parseHimalayasResponse(null).length === 0) {
    pass('parseHimalayasResponse empty / non-object payload -> empty result (no crash)');
  } else {
    fail('parseHimalayasResponse invalid payload should yield empty result');
  }

  let capturedUrl = null;
  let capturedOpts = null;
  const fetched = await himalayas.fetch(
    { name: 'Himalayas', provider: 'himalayas' },
    { fetchJson: async (url, opts) => { capturedUrl = url; capturedOpts = opts; return sample; } },
  );

  if (capturedUrl === 'https://himalayas.app/jobs/api?limit=50') {
    pass('himalayas.fetch() requests the pinned API URL');
  } else {
    fail(`himalayas.fetch() requested ${JSON.stringify(capturedUrl)}`);
  }

  if (capturedOpts && capturedOpts.redirect === 'error') {
    pass('himalayas.fetch() passes redirect:"error" to fetchJson');
  } else {
    fail(`himalayas.fetch() should pass redirect:"error", got: ${JSON.stringify(capturedOpts)}`);
  }

  if (fetched[0]?.company === 'Acme Labs' && fetched[0]?.title === 'Staff AI Engineer') {
    pass('provider: himalayas config returns normalized jobs');
  } else {
    fail(`himalayas.fetch() normalized row = ${JSON.stringify(fetched[0])}`);
  }
  // Search mode (entry.queries)
  const { resolveSearch, searchPageUrl } = himalayasModule;
  const item = (n, extra = {}) => ({ title: `AI Engineer ${n}`, companyName: 'Acme', locationRestrictions: [], pubDate: 1782538666, excerpt: 'Builds agents', employmentType: 'Full Time',
    applicationLink: `https://himalayas.app/companies/acme/jobs/ai-engineer-${n}`, ...extra });
  const calls = [];
  const pages = [{ jobs: Array.from({ length: 20 }, (_, i) => item(i)) }, { jobs: [item(0), item(99, { locationRestrictions: ['Brazil'], employmentType: 'Contractor' })] }];
  const searched = await himalayas.fetch({ name: 'H', provider: 'himalayas', queries: ['ai engineer'], country: 'br', max_pages: 3 },
    { sleep: async () => {}, fetchJson: async (url, opts) => { calls.push({ url, opts }); return pages.shift(); } });
  if (calls.length === 2 && calls[0].url === 'https://himalayas.app/jobs/api/search?q=ai+engineer&country=BR&page=1' && calls[1].url.endsWith('&page=2')) {
    pass('search mode: one request per page, country upper-cased, stops on a short page');
  } else fail(`search mode requests = ${JSON.stringify(calls.map((c) => c.url))}`);
  if (calls.every((c) => c.opts.redirect === 'error')) pass('search mode passes redirect:"error"');
  else fail('search mode must pass redirect:"error"');
  if (searched.length === 21 && searched[0].location === 'Worldwide' && searched[0].meta.employmentType === 'FULL_TIME' && searched[0].description === 'Builds agents') {
    pass('search mode: de-duplicates, empty restrictions = Worldwide, type and excerpt mapped');
  } else fail(`search mode rows = ${searched.length} ${JSON.stringify(searched[0])}`);
  if (searched.at(-1).location === 'Brazil' && searched.at(-1).meta.employmentType === 'CONTRACTOR') pass('search mode keeps explicit restrictions');
  else fail(`search mode last row = ${JSON.stringify(searched.at(-1))}`);

  let bad = 0;
  for (const entry of [{ queries: [] }, { queries: [''] }, { queries: ['a'], country: 'Brazil' }, { queries: Array(13).fill('a') }]) {
    try { resolveSearch(entry); bad++; } catch { /* expected */ }
  }
  if (bad === 0) pass('search mode: invalid entries throw before any request');
  else fail(`${bad} invalid search entries were accepted`);
  if (searchPageUrl({ country: '' }, 'a b', 2) === 'https://himalayas.app/jobs/api/search?q=a+b&page=2') pass('search URL omits country when unset');
  else fail('search URL with no country is wrong');
} catch (e) {
  fail(`himalayas provider tests crashed: ${e.message}`);
}
