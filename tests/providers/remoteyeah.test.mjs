// tests/providers/remoteyeah.test.mjs — RemoteYeah RSS provider. No network: a
// deterministic sample feed and a stub ctx.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — remoteyeah');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/remoteyeah.mjs')).href);
  const { resolveProvider } = await import(pathToFileURL(join(ROOT, 'providers/_registry.mjs')).href);
  const remoteyeah = mod.default;
  const { parseRemoteYeahFeed } = mod;
  const FEED = 'https://remoteyeah.com/rss.xml';

  if (remoteyeah.id === 'remoteyeah') pass('remoteyeah.id is "remoteyeah"');
  else fail(`remoteyeah.id is ${JSON.stringify(remoteyeah.id)}`);

  // detect(): explicit provider only (a board-wide feed has no company URL to sniff).
  const hit = remoteyeah.detect({ name: 'RemoteYeah', provider: 'remoteyeah' });
  if (hit?.url === FEED) pass('remoteyeah.detect() claims an explicit provider entry');
  else fail(`remoteyeah.detect() explicit = ${JSON.stringify(hit)}`);
  const misses = [
    remoteyeah.detect({ name: 'X' }),
    remoteyeah.detect({ name: 'X', provider: 'remotive' }),
    remoteyeah.detect({ name: 'X', careers_url: 'https://remoteyeah.com/jobs' }),
    remoteyeah.detect(null),
    remoteyeah.detect(undefined),
  ];
  if (misses.every((m) => m === null)) pass('remoteyeah.detect() returns null for missing, other-provider, URL-only and non-object entries');
  else fail(`remoteyeah.detect() misses = ${JSON.stringify(misses)}`);
  const resolved = resolveProvider({ name: 'RemoteYeah', provider: 'remoteyeah' }, new Map([['remoteyeah', remoteyeah]]));
  if (resolved && 'provider' in resolved && resolved.provider === remoteyeah) pass('registry dispatches an explicit remoteyeah entry');
  else fail(`registry did not dispatch remoteyeah: ${JSON.stringify(resolved)}`);

  // Deterministic sample: two good items plus every shape that must be dropped.
  const item = (o) => `<item>
    <title>${o.title ?? ''}</title>
    ${o.company === undefined ? '' : `<company>${o.company}</company>`}
    <description>${o.description ?? ''}</description>
    <location>${o.location ?? ''}</location>
    <pubDate>${o.pubDate ?? '2026-10-03T23:31:15+00:00'}</pubDate>
    <link>${o.link ?? ''}</link>
  </item>`;
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Remote jobs</title>
    ${item({ title: ' Remote Software Engineer, Applied AI (Brazil) at Commure ', company: ' Commure ', location: ' Brazil ',
      description: '<![CDATA[<p>Build <b>agents</b> &amp; evals.</p><script>alert(1)</script>]]>',
      link: 'https://remoteyeah.com/jobs/remote-software-engineer-applied-ai-brazil-commure?utm_source=rss&amp;ref=rss' })}
    ${item({ title: '<![CDATA[Remote Staff Engineer at Acme & Sons]]>', company: 'Acme &amp; Sons', location: 'Latin America',
      description: '&lt;p&gt;Escaped &lt;i&gt;markup&lt;/i&gt; stays text&lt;/p&gt;', link: 'https://remoteyeah.com/jobs/remote-staff-engineer-acme?ref=rss&amp;page=2' })}
    ${item({ title: 'Engineer at Scale', company: 'Acme', location: 'Worldwide', link: 'https://remoteyeah.com/jobs/engineer-at-scale' })}
    ${item({ title: 'Remote Backend Dev', location: 'Worldwide', link: 'https://remoteyeah.com/jobs/backend-dev' })}
    ${item({ title: 'Remote Role, bad date', company: 'Dateless', pubDate: 'not-a-date', link: 'https://remoteyeah.com/jobs/bad-date' })}
    ${item({ title: 'No link at all', company: 'Ghost' })}
    ${item({ title: 'Remote Http Role at Insecure', company: 'Insecure', link: 'http://remoteyeah.com/jobs/http' })}
    ${item({ title: 'Remote Evil Role at Evil', company: 'Evil', link: 'https://evil.example/jobs/x' })}
    ${item({ title: 'Remote Suffix Role at Spoof', company: 'Spoof', link: 'https://remoteyeah.com.evil.example/jobs/x' })}
    ${item({ title: '', company: 'Untitled', link: 'https://remoteyeah.com/jobs/untitled' })}
  </channel></rss>`;

  const jobs = parseRemoteYeahFeed(xml, 'Entry Name');
  const byUrl = (u) => jobs.find((j) => j.url === u);

  const a = byUrl('https://remoteyeah.com/jobs/remote-software-engineer-applied-ai-brazil-commure');
  if (a && a.title === 'Software Engineer, Applied AI (Brazil)' && a.company === 'Commure' && a.location === 'Brazil'
      && a.postedAt === Date.parse('2026-10-03T23:31:15+00:00')) {
    pass('maps title (without "Remote " and " at <Company>"), company, location, postedAt; strips utm_source/ref from the url');
  } else {
    fail(`first item = ${JSON.stringify(a)}`);
  }
  if (a?.description === 'Build agents & evals.') pass('description: CDATA HTML becomes plain text, <script> content removed');
  else fail(`description = ${JSON.stringify(a?.description)}`);

  const b = byUrl('https://remoteyeah.com/jobs/remote-staff-engineer-acme?page=2');
  if (b && b.title === 'Staff Engineer' && b.company === 'Acme & Sons' && b.location === 'Latin America') {
    pass('CDATA title and entity-encoded company decode; only tracking params are removed from the url (page=2 kept)');
  } else {
    fail(`second item = ${JSON.stringify(b)}`);
  }
  if (b?.description === 'Escaped markup stays text') pass('escaped markup in the description is stripped as markup, never returned as tags');
  else fail(`escaped description = ${JSON.stringify(b?.description)}`);

  const c = byUrl('https://remoteyeah.com/jobs/engineer-at-scale');
  if (c?.title === 'Engineer at Scale') pass('a title containing " at " is left alone unless the suffix is the item\'s own company');
  else fail(`" at " title = ${JSON.stringify(c?.title)}`);

  const d = byUrl('https://remoteyeah.com/jobs/backend-dev');
  if (d?.company === 'Entry Name' && d.title === 'Backend Dev') pass('company falls back to the entry name when the item has no <company>');
  else fail(`fallback company = ${JSON.stringify(d)}`);

  const e = byUrl('https://remoteyeah.com/jobs/bad-date');
  if (e && !('postedAt' in e)) pass('an unparseable pubDate omits postedAt (NaN-safe)');
  else fail(`bad date row = ${JSON.stringify(e)}`);

  const urls = jobs.map((j) => j.url);
  const droppedOk = !urls.some((u) => /ghost|http$|evil|untitled/.test(u)) && jobs.length === 5;
  if (droppedOk) pass('drops items with no link, http link, foreign host, suffix-spoofed host, or empty title (5 kept)');
  else fail(`kept urls = ${JSON.stringify(urls)}`);
  if (parseRemoteYeahFeed(null).length === 0 && parseRemoteYeahFeed(undefined).length === 0 && parseRemoteYeahFeed(42).length === 0) {
    pass('parseRemoteYeahFeed returns [] for non-string input');
  } else {
    fail('parseRemoteYeahFeed should return [] for non-string input');
  }

  // fetch(): one request, redirect:'error', pinned URL, parsed result.
  const calls = [];
  const ctx = { fetchText: async (url, opts) => { calls.push({ url, redirect: opts?.redirect }); return xml; } };
  const fetched = await remoteyeah.fetch({ name: 'RemoteYeah' }, ctx);
  if (calls.length === 1 && calls[0].url === FEED) pass('fetch() makes exactly one request, to the feed URL');
  else fail(`fetch() requests = ${JSON.stringify(calls)}`);
  if (calls.every((x) => x.redirect === 'error')) pass('fetch() passes redirect:"error" (SSRF guard)');
  else fail(`fetch() redirect opts = ${JSON.stringify(calls)}`);
  if (fetched.length === 5) pass('fetch() returns the parsed postings');
  else fail(`fetch() returned ${fetched.length} jobs`);

  // probe cooperation: no pagination, so ctx.maxPages: 1 is still exactly one list request.
  calls.length = 0;
  await remoteyeah.fetch({ name: 'RemoteYeah' }, { ...ctx, maxPages: 1 });
  if (calls.length === 1) pass('fetch() under ctx.maxPages: 1 still issues exactly one list request');
  else fail(`probe made ${calls.length} requests`);

  // empty vs broken: a real feed with no items is [], anything else throws.
  const empty = await remoteyeah.fetch({ name: 'X' }, { fetchText: async () => '<rss version="2.0"><channel><title>t</title></channel></rss>' });
  if (Array.isArray(empty) && empty.length === 0) pass('a valid feed with no items returns []');
  else fail(`empty feed = ${JSON.stringify(empty)}`);
  for (const [label, body] of [['an HTML error page', '<html><body>502 Bad Gateway</body></html>'], ['an empty body', ''], ['a non-string', null]]) {
    let threw = false;
    try { await remoteyeah.fetch({ name: 'X' }, { fetchText: async () => body }); } catch (err) { threw = /unexpected feed response/.test(err.message); }
    if (threw) pass(`fetch() throws on ${label} instead of reporting 0 postings`);
    else fail(`fetch() should throw on ${label}`);
  }
  // a transport failure propagates unwrapped (the health probe reads its class).
  const boom = Object.assign(new Error('socket hang up'), { status: 503 });
  let seen = null;
  try { await remoteyeah.fetch({ name: 'X' }, { fetchText: async () => { throw boom; } }); } catch (err) { seen = err; }
  if (seen === boom) pass('a ctx.fetchText rejection propagates unwrapped');
  else fail('fetch() must not wrap a ctx.fetchText rejection');
} catch (e) {
  fail(`remoteyeah provider tests crashed: ${e.stack || e.message}`);
}
