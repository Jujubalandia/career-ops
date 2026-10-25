// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
import { fetchJsonWithRetry, sleep } from './_http.mjs';

// Himalayas provider - board-wide remote jobs API
// (https://himalayas.app/jobs/api?limit=50). Returns { jobs: [...] }. The
// full feed is fetched so scan.mjs's title_filter / location_filter can do
// the local gating consistently with other zero-token board providers.
//
// Wire in via a `job_boards:` entry with `provider: himalayas`.
//
// Search mode: the feed above is only the 50 newest of ~130k postings, which on a
// board that size is hours of coverage. An entry with `queries: [...]` uses
// `/jobs/api/search?q=<query>&country=<ISO>` instead (20 rows per page, `page=N`,
// no cursor on search). `country` (optional, ISO alpha-2, e.g. BR) keeps postings open
// to that country; `max_pages` (default 3) bounds each query. Search results are
// ranked by relevance, not date, so the window is applied by the caller, not here.
// An empty `locationRestrictions` means "no restriction" and is reported as Worldwide.

const FEED_URL = 'https://himalayas.app/jobs/api?limit=50';
const TRUSTED_HOST = 'himalayas.app';
const SEARCH_URL = 'https://himalayas.app/jobs/api/search';
const SEARCH_PAGE_DELAY_MS = 1000;
const DEFAULT_SEARCH_PAGES = 3;
const MAX_QUERIES = 12;

/** @param {string} url */
function assertHimalayasUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`himalayas: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`himalayas: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`himalayas: untrusted hostname "${parsed.hostname}" - must be ${TRUSTED_HOST}`);
  }
  return url;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanHimalayasUrl(value) {
  const raw = cleanText(value);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    const trusted = host === TRUSTED_HOST || host.endsWith(`.${TRUSTED_HOST}`);
    return parsed.protocol === 'https:' && trusted ? parsed.href : '';
  } catch {
    return '';
  }
}

function locationText(value) {
  if (!Array.isArray(value)) return '';
  return value
    .filter(v => typeof v === 'string' && v.trim())
    .map(v => v.trim())
    .join(', ');
}

// Himalayas pubDate is currently epoch seconds. Accept milliseconds and
// parseable date strings too so the parser survives small API shape changes.
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/** @type {Provider} */
export default {
  id: 'himalayas',

  detect(entry) {
    return entry?.provider === 'himalayas' ? { url: FEED_URL } : null;
  },

  /**
   * Fetches and normalizes postings from the Himalayas public feed.
   * @param {{ provider?: string }} entry - The job_boards entry being processed.
   * @param {{ fetchJson: (url: string, opts?: { redirect?: 'error'|'follow'|'manual' }) => Promise<any> }} ctx - HTTP context.
   * @returns {Promise<Array<{title: string, url: string, company: string, location: string, postedAt?: number}>>}
   */
  async fetch(entry, ctx) {
    if (entry?.queries !== undefined) return fetchSearch(entry, ctx);
    const feedUrl = assertHimalayasUrl(FEED_URL);
    // redirect:'error' prevents SSRF via server-side redirects; combined with
    // assertHimalayasUrl above it keeps the request pinned to himalayas.app.
    const json = await ctx.fetchJson(feedUrl, { redirect: 'error' });
    if (!json || !Array.isArray(json.jobs)) {
      throw new Error(`himalayas: unexpected API response - expected { jobs: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`);
    }
    return parseHimalayasResponse(json);
  },
};

/**
 * Parse Himalayas' public jobs API response. Exported for unit tests.
 *
 * Shape: `{ jobs: [...] }`, where each job currently carries `title`,
 * `companyName`, `locationRestrictions`, `applicationLink`, `guid`,
 * `pubDate`, and `companySlug`. `applicationLink` is preferred over `guid`
 * and used as the dedup key after HTTPS + host validation.
 *
 * @param {unknown} json - raw parsed API response
 * @returns {Array<{title: string, url: string, company: string, location: string, postedAt?: number}>}
 */
export function parseHimalayasResponse(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.jobs)) return [];

  const jobs = [];
  for (const item of json.jobs) {
    if (!item || typeof item !== 'object') continue;

    const title = cleanText(item.title);
    if (!title) continue;

    const url = cleanHimalayasUrl(item.applicationLink) || cleanHimalayasUrl(item.guid);
    if (!url) continue;

    jobs.push({
      title,
      url,
      company: cleanText(item.companyName),
      location: locationText(item.locationRestrictions),
      postedAt: toEpochMs(item.pubDate),
    });
  }

  return jobs;
}

/** Validate a search entry. Throws before any request. Exported for unit tests. */
export function resolveSearch(entry) {
  const q = entry?.queries;
  if (!Array.isArray(q) || q.length === 0 || q.some((x) => !cleanText(x))) throw new Error('himalayas: `queries` must be a non-empty list of strings');
  if (q.length > MAX_QUERIES) throw new Error(`himalayas: ${q.length} queries exceeds the cap of ${MAX_QUERIES}`);
  const country = entry.country === undefined ? '' : cleanText(entry.country).toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) throw new Error('himalayas: `country` must be an ISO alpha-2 code');
  return { queries: q.map(cleanText), country, maxPages: Math.max(1, Number(entry.max_pages) || DEFAULT_SEARCH_PAGES) };
}

export function searchPageUrl({ country }, query, page) {
  const u = new URL(SEARCH_URL);
  u.searchParams.set('q', query);
  if (country) u.searchParams.set('country', country);
  u.searchParams.set('page', String(page));
  return u.href;
}

async function fetchSearch(entry, ctx) {
  const s = resolveSearch(entry);
  const seen = new Set();
  const out = [];
  let first = true;
  for (const query of s.queries) {
    for (let page = 1; page <= (Number(ctx?.maxPages) > 0 ? 1 : s.maxPages); page++) {
      if (!first) await sleep(SEARCH_PAGE_DELAY_MS, ctx);
      first = false;
      const json = await fetchJsonWithRetry(ctx, assertHimalayasUrl(searchPageUrl(s, query, page)), { redirect: 'error' });
      if (!json || !Array.isArray(json.jobs)) {
        throw new Error(`himalayas: unexpected search response - expected { jobs: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`);
      }
      for (const item of json.jobs) {
        const [job] = parseHimalayasResponse({ jobs: [item] });
        if (!job || seen.has(job.url)) continue;
        seen.add(job.url);
        if (!job.location) job.location = 'Worldwide';
        const excerpt = cleanText(item.excerpt);
        if (excerpt) job.description = excerpt;
        const type = cleanText(item.employmentType).toLowerCase();
        job.meta = { employmentType: type === 'full time' ? 'FULL_TIME' : type === 'contractor' ? 'CONTRACTOR' : type === 'part time' ? 'PART_TIME' : undefined };
        out.push(job);
      }
      if (json.jobs.length < 20) break; // last page for this query
    }
  }
  return out;
}
