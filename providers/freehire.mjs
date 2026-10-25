// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
import { fetchJsonWithRetry, sleep } from './_http.mjs';

// FreeHire provider — IT job aggregator (https://freehire.me), read through its public
// JSON API, which robots.txt asks bots to use instead of the HTML. No key; budget is
// 600 requests/minute. Search is `GET /api/v1/jobs/search`.
//
// Entry fields (all optional but `queries`):
//   queries   list of search strings, one request series each
//   regions   macro-regions, default ['latam']      } joined as an OR group by the API,
//   countries ISO alpha-2, default ['br']           } so "LATAM or Brazil"
//   work_mode remote | hybrid | onsite (omit for any)
//   max_pages pages of `limit` rows per query, default 2
//   limit     rows per page, default 50 (API cap 100)
//
// `meta.work_mode` is remote | hybrid | onsite | unknown; the remote-LATAM runner only treats
// `remote` as remote for FreeHire rows (an aggregator row with no mode is not assumed remote).
//
// The window comes from ctx.sinceMs (posted_within_days); results are newest-first.
// The API ignores unknown params instead of refusing them, and echoes that in
// `meta.ignored_params` / `meta.ignored_values`: a non-empty echo throws, so a typo
// never turns into a silent whole-catalogue scan.
//
// A row's `url` is the posting's own ATS link (FreeHire adds utm_source, which the queue's
// dedup strips). FreeHire also aggregates boards we read directly (himalayas...): the
// scanner's URL/company+role dedup absorbs the overlap.

const BASE = 'https://freehire.me/api/v1/jobs/search';
const USER_AGENT = 'career-ops/1.0 (+https://github.com/santifer/career-ops)';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_MAX_PAGES = 2;
const MAX_QUERIES = 12;
const INTER_REQUEST_DELAY_MS = 300;
const DAY_MS = 86_400_000;
const WORK_MODES = ['remote', 'hybrid', 'onsite'];
const CODE_RE = /^[a-z]{2}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

function countryName(code) {
  try { return regionNames.of(code.toUpperCase()) || code.toUpperCase(); } catch { return code.toUpperCase(); }
}

/** Validate the entry and build the query-independent params. Throws before any request. */
export function resolveParams(entry) {
  const queries = entry?.queries;
  if (!Array.isArray(queries) || queries.length === 0 || queries.some((q) => !str(q))) {
    throw new Error('freehire: `queries` must be a non-empty list of strings');
  }
  if (queries.length > MAX_QUERIES) throw new Error(`freehire: ${queries.length} queries exceeds the cap of ${MAX_QUERIES}`);
  const regions = entry.regions ?? ['latam'];
  const countries = entry.countries ?? ['br'];
  if (!Array.isArray(regions) || regions.some((r) => !SLUG_RE.test(str(r)))) throw new Error('freehire: invalid `regions`');
  if (!Array.isArray(countries) || countries.some((c) => !CODE_RE.test(str(c)))) throw new Error('freehire: `countries` must be ISO alpha-2 codes');
  if (entry.work_mode !== undefined && !WORK_MODES.includes(entry.work_mode)) {
    throw new Error(`freehire: work_mode must be one of ${WORK_MODES.join(', ')}`);
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(entry.limit) || DEFAULT_LIMIT));
  const maxPages = Math.max(1, Number(entry.max_pages) || DEFAULT_MAX_PAGES);
  return { queries: queries.map(str), regions: regions.map(str), countries: countries.map(str), workMode: entry.work_mode, limit, maxPages };
}

/** One search URL. Exported for unit tests. */
export function searchUrl(params, query, offset, sinceDays) {
  const u = new URL(BASE);
  u.searchParams.set('q', query);
  u.searchParams.set('limit', String(params.limit));
  u.searchParams.set('offset', String(offset));
  u.searchParams.set('sort', 'posted_at');
  if (params.regions.length) u.searchParams.set('regions', params.regions.join(','));
  if (params.countries.length) u.searchParams.set('countries', params.countries.join(','));
  if (params.workMode) u.searchParams.set('work_mode', params.workMode);
  if (sinceDays > 0) u.searchParams.set('posted_within_days', String(sinceDays));
  return u.href;
}

/**
 * Normalize one API row. Exported for unit tests. Drops rows without a title or an
 * https URL, and closed postings.
 * @param {any} j
 */
export function normalizeFreehireJob(j) {
  if (!j || typeof j !== 'object' || j.closed_at) return null;
  const title = str(j.title);
  let url = '';
  try {
    const parsed = new URL(str(j.url));
    if (parsed.protocol === 'https:') url = parsed.href;
  } catch { /* no url */ }
  if (!title || !url) return null;

  const countries = Array.isArray(j.countries) ? j.countries.map(str).filter((c) => CODE_RE.test(c)) : [];
  const where = str(j.location) || [...new Set(countries.map(countryName))].join(', ');
  const mode = str(j.work_mode).toLowerCase();
  const location = mode === 'remote' ? `${where || 'Remote'}${where ? ' (Remote)' : ''}` : mode === 'hybrid' ? `${where} (Hybrid)`.trim() : where;

  /** @type {{ title: string, url: string, company: string, location: string, description?: string, postedAt?: number, meta: object }} */
  const job = { title, url, company: str(j.company) || '?', location, meta: { work_mode: mode || 'unknown' } };
  const postedAt = Date.parse(str(j.posted_at));
  if (Number.isFinite(postedAt)) job.postedAt = postedAt;
  const summary = str(j.enrichment?.summary);
  if (summary) job.description = summary;
  const type = str(j.enrichment?.employment_type);
  if (type) job.meta.employmentType = type === 'full_time' ? 'FULL_TIME' : type === 'contract' ? 'CONTRACTOR' : type === 'part_time' ? 'PART_TIME' : undefined;
  return job;
}

/** @type {Provider} */
export default {
  id: 'freehire',

  detect(entry) {
    return entry?.provider === 'freehire' ? { url: BASE } : null;
  },

  async fetch(entry, ctx) {
    const params = resolveParams(entry); // before any request
    const sinceDays = Number.isFinite(ctx?.sinceMs) ? Math.max(1, Math.ceil((Date.now() - ctx.sinceMs) / DAY_MS)) : 0;
    const maxPages = Number(ctx?.maxPages) > 0 ? 1 : params.maxPages;
    const seen = new Set();
    const out = [];
    let first = true;

    for (const query of params.queries) {
      for (let page = 0; page < maxPages; page++) {
        if (!first) await sleep(INTER_REQUEST_DELAY_MS, ctx);
        first = false;
        const json = await fetchJsonWithRetry(ctx, searchUrl(params, query, page * params.limit, sinceDays), {
          redirect: 'error', headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        });
        if (!json || !Array.isArray(json.data)) throw new Error('freehire: unexpected API response — expected { data: [...] }');
        const ignored = [...(json.meta?.ignored_params ?? []), ...(json.meta?.ignored_values ? [json.meta.ignored_values] : [])];
        if (ignored.length) throw new Error(`freehire: the API ignored ${JSON.stringify(ignored).slice(0, 120)} — fix the entry`);
        for (const row of json.data) {
          const job = normalizeFreehireJob(row);
          if (job && !seen.has(job.url)) { seen.add(job.url); out.push(job); }
        }
        if (json.data.length < params.limit) break; // last page for this query
      }
    }
    return out;
  },
};
