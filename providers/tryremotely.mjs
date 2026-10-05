// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

// TryRemotely provider — board-wide listings from the site's official public API
// (https://tryremotely.com/api/v1/job-listings, OpenAPI at /openapi.json).
// Read-only, no API key, rate limited to 100 requests/minute/IP. The API terms
// make attribution a condition of use: link back to the listing URL on
// tryremotely.com and name it as the source. Every row this provider returns
// uses that listing URL as its `url`, and the scanner records the source name,
// so the condition is met by construction.
//
// Response: { usage, updated_at, offset, limit, total_count, jobs: [ { slug, title,
//   companyName, workModel, seniorityLevel, locations: [string], pubDate (epoch
//   SECONDS), expiryDate (epoch SECONDS), applicationLink, description (HTML), ... } ] }
// Roughly newest first (pubDate is not strictly monotonic), `?offset=N&limit=100`.
//
// `total_count` is ~86k, so it is NEVER used to bound the walk: the page count
// comes from this module's own constants. Two further stops end the walk early:
//   - a short page (the list is exhausted), and
//   - `ctx.sinceMs`: the list is newest-first, so once a page's oldest posting is
//     older than the scan window every later page is older still.
//
// Location mapping: `locations` (e.g. ["Worldwide"], ["Brazil","Argentina"]) joined
// with ", ". A non-remote workModel ("Hybrid", "On-site") is appended in
// parentheses so a region gate can tell a physical-presence role from a remote one.
//
// Wire in via a `job_boards:` entry with `provider: tryremotely`.

const API_URL = 'https://tryremotely.com/api/v1/job-listings';
const TRUSTED_HOST = 'tryremotely.com';
const PAGE_SIZE = 100;
// The board publishes ~1,300 listings a day across every field and the API has no
// filter, so depth is the only way to reach a scan window: 20 pages (2,000 listings)
// is roughly 1.5 days, 50 (the cap) roughly 3.9 days. Measured 2026-10-05.
const DEFAULT_MAX_PAGES = 20;
const MAX_PAGES_CAP = 50;
// 100 requests/minute is the published ceiling; 700 ms keeps a walk well under it.
const INTER_PAGE_DELAY_MS = 700;
const DESCRIPTION_MAX_CHARS = 1500;

/** @param {string} url */
function assertTryRemotelyUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`tryremotely: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`tryremotely: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`tryremotely: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

/** Resolve the page cap: a positive integer `max_pages` on the entry, capped. */
function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

// NaN-safe: epoch SECONDS -> ms; anything non-finite or non-positive yields undefined.
function secondsToMs(seconds) {
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Plain text of an HTML fragment, capped. Entities are decoded AFTER the tags
// are removed, so escaped markup in the prose cannot come back as tags.
function htmlToText(html) {
  const noTags = html.replace(/<(?:script|style)\b[\s\S]*?<\/(?:script|style)>/gi, ' ').replace(/<[^>]*>/g, ' ');
  return decodeEntities(noTags).replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_MAX_CHARS);
}

// The listing URL: https and exactly tryremotely.com. `applicationLink` is the
// listing page; `guid` is the same URL and is the fallback.
function listingUrl(j) {
  for (const candidate of [j.applicationLink, j.guid]) {
    const raw = str(candidate);
    if (!raw) continue;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === TRUSTED_HOST) return parsed.href;
    } catch {
      // try the next candidate
    }
  }
  return '';
}

/**
 * Normalize one TryRemotely listing. Exported for unit tests.
 *
 * Drops: non-objects, no title, no tryremotely.com listing URL, and postings whose
 * `expiryDate` has passed.
 *
 * @param {any} j
 * @param {string} [fallbackCompany]
 * @param {number} [now] epoch ms, injectable for tests
 * @returns {{ title: string, url: string, company: string, location: string, description?: string, postedAt?: number } | null}
 */
export function normalizeTryRemotelyJob(j, fallbackCompany, now = Date.now()) {
  if (!j || typeof j !== 'object') return null;
  const title = str(j.title);
  if (!title) return null;
  const url = listingUrl(j);
  if (!url) return null;

  const expiresAt = secondsToMs(j.expiryDate);
  if (expiresAt !== undefined && expiresAt < now) return null;

  const company = str(j.companyName) || str(fallbackCompany) || 'TryRemotely';
  const places = Array.isArray(j.locations) ? j.locations.map(str).filter(Boolean) : [];
  const workModel = str(j.workModel);
  const physical = workModel && !/^remote$/i.test(workModel) ? ` (${workModel})` : '';
  const location = `${places.join(', ')}${physical}`.trim();

  /** @type {{ title: string, url: string, company: string, location: string, description?: string, postedAt?: number }} */
  const job = { title, url, company, location };
  const description = typeof j.description === 'string' ? htmlToText(j.description) : '';
  if (description) job.description = description;
  const postedAt = secondsToMs(j.pubDate);
  if (postedAt !== undefined) job.postedAt = postedAt;
  return job;
}

/** @type {Provider} */
export default {
  id: 'tryremotely',

  detect(entry) {
    return entry?.provider === 'tryremotely' ? { url: API_URL } : null;
  },

  async fetch(entry, ctx) {
    assertTryRemotelyUrl(API_URL);
    const ctxMaxPages = Number(ctx?.maxPages);
    const ctxCap = ctxMaxPages > 0 ? ctxMaxPages : Infinity;
    const pagesToFetch = Math.min(resolveMaxPages(entry), ctxCap);
    const sinceMs = Number.isFinite(ctx?.sinceMs) ? ctx.sinceMs : undefined;
    const fallbackCompany = entry?.name;
    const out = [];
    let walkedToEntryCeiling = false;

    for (let page = 0; page < pagesToFetch; page++) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const url = `${API_URL}?offset=${page * PAGE_SIZE}&limit=${PAGE_SIZE}`;
      // redirect:'error' prevents SSRF via server-side redirects
      const json = await fetchJsonWithRetry(ctx, url, { redirect: 'error' });
      if (!json || !Array.isArray(json.jobs)) {
        throw new Error(
          `tryremotely: unexpected API response on page ${page + 1} — expected { jobs: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`,
        );
      }
      for (const j of json.jobs) {
        const normalized = normalizeTryRemotelyJob(j, fallbackCompany);
        if (normalized) out.push(normalized);
      }
      if (json.jobs.length < PAGE_SIZE) break; // short page: the list is exhausted
      // Newest first: when the last posting on this page is already outside the
      // scan window, no later page can hold anything inside it.
      const oldest = secondsToMs(json.jobs[json.jobs.length - 1]?.pubDate);
      if (sinceMs !== undefined && oldest !== undefined && oldest < sinceMs) break;
      // Every page was full and still inside the window: only the entry's own cap
      // (never the health probe's ctx.maxPages) stopped the walk.
      if (page === pagesToFetch - 1 && pagesToFetch === resolveMaxPages(entry)) walkedToEntryCeiling = true;
    }
    if (walkedToEntryCeiling) {
      console.error(`⚠️  tryremotely: ${entry?.name || 'entry'} truncated at max_pages=${pagesToFetch} (${out.length} jobs) — raise max_pages on this entry for more`);
    }
    return out;
  },
};
