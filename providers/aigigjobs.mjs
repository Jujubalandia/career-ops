// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
import { fetchTextWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

// AIGigJobs provider — freelance / contract AI and data gigs (Mercor, micro1, Alignerr,
// Meridial, Appen, Toloka, Outlier...), read from the JSON-LD `JobPosting` blocks the
// site embeds in its listing pages (https://www.aigigjobs.com). No API and no feed.
//
// What the site allows (checked 2026-10-05): robots.txt permits everything outside
// /api/ and /admin/ with `Crawl-delay: 5`; there is no terms page (404). So this
// provider reads only public listing pages, one at a time, 5 s apart.
//
// Each listing page (/locations/<x>, /skills/<x>, /verticals/<x>...) carries 10
// JobPosting blocks and has no pagination, so breadth comes from the entry's `pages`
// list, not from paging. A page with no JSON-LD at all throws (the markup changed or
// this is not an AIGigJobs page) so a layout change is loud, never a silent empty scan.
//
// Every row's `url` is the posting on aigigjobs.com, not the platform's own apply
// link: the site aggregates other marketplaces.
//
// Pay is NOT put in `salary`: the scanner renders that field without a unit, so
// "120 USD" would read as annual. It travels in `meta.pay` for lib/job-class.mjs,
// together with `meta.employmentType`. Some postings mark an annual salary as HOUR
// ("200000 per HOUR"); normalizing that is the classifier's job.
//
// Deliberate deviation from ADDING_A_PROVIDER.md rules 3 and 5: AIGigJobs is a
// meta-aggregator and `pages` is a sample, not the full inventory. It exists for the
// remote-LATAM catalog (scripts/scan-remote-latam.mjs), requested by the operator, and
// is not meant for a portals.yml `job_boards:` entry or an upstream PR as-is.
//
// Wire in via a catalog `sources:` entry with `provider: aigigjobs` and an optional
// `pages: [...]` list.

const BASE = 'https://www.aigigjobs.com';
const TRUSTED_HOST = 'www.aigigjobs.com';
// robots.txt Crawl-delay: 5. The provider guide treats a published delay as a floor.
const INTER_PAGE_DELAY_MS = 5000;
const MAX_PAGES_CAP = 20;
const DESCRIPTION_MAX_CHARS = 1500;
const PAGE_RE = /^(?:locations|skills|verticals|job-types|platforms)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

// 12 pages is ~1 min and ~94 distinct postings on 2026-10-05.
export const DEFAULT_PAGES = [
  'locations/brazil', 'locations/latin-america', 'locations/worldwide', 'locations/mexico',
  'skills/machine-learning', 'skills/data-analysis', 'skills/python', 'skills/nlp',
  'skills/ai-safety', 'skills/software-engineering',
  'verticals/engineering', 'verticals/data-analytics',
];

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Plain text of an HTML/markdown-ish fragment, capped. Entities are decoded AFTER the
// tags are removed, so escaped markup in the prose cannot come back as tags.
function htmlToText(html) {
  const noTags = html.replace(/<(?:script|style)\b[\s\S]*?<\/(?:script|style)>/gi, ' ').replace(/<[^>]*>/g, ' ');
  return decodeEntities(noTags).replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_MAX_CHARS);
}

/** Validate the entry's `pages` (or the default list). Throws before any request. */
function resolvePages(entry) {
  const raw = entry?.pages ?? DEFAULT_PAGES;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('aigigjobs: `pages` must be a non-empty list');
  const pages = [];
  for (const p of raw) {
    const page = typeof p === 'string' ? p.trim().replace(/^\/+/, '') : '';
    if (!PAGE_RE.test(page)) {
      throw new Error(`aigigjobs: invalid page ${JSON.stringify(p)} — expected locations|skills|verticals|job-types|platforms/<slug>`);
    }
    if (!pages.includes(page)) pages.push(page);
  }
  if (pages.length > MAX_PAGES_CAP) {
    throw new Error(`aigigjobs: ${pages.length} pages exceeds the cap of ${MAX_PAGES_CAP}`);
  }
  return pages;
}

/** Every JSON-LD block of a page, parsed; unparseable blocks are skipped. */
function jsonLdBlocks(html) {
  const blocks = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      blocks.push(JSON.parse(m[1]));
    } catch {
      // a broken block must not hide the others
    }
  }
  return { count: [...html.matchAll(re)].length, blocks };
}

// Objects, arrays and @graph all flatten to a list of nodes.
function flatten(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => flatten(n, out));
  else if (node && typeof node === 'object') {
    if (Array.isArray(node['@graph'])) flatten(node['@graph'], out);
    else out.push(node);
  }
  return out;
}

const isJobPosting = (n) => [].concat(n?.['@type'] ?? []).includes('JobPosting');

// Countries the posting accepts. applicantLocationRequirements is an object, an array,
// or absent; jobLocation's country is the company's base (often "US"), so it is NOT used
// when applicant countries exist.
function locationOf(j) {
  const reqs = flatten(j.applicantLocationRequirements).map((r) => str(r?.name)).filter(Boolean);
  if (reqs.length) return [...new Set(reqs)].join(', ');
  const place = flatten(j.jobLocation)[0]?.address;
  const where = str(place?.addressLocality) || str(place?.addressRegion);
  if (where) return where;
  return str(j.jobLocationType).toUpperCase() === 'TELECOMMUTE' ? 'Remote' : '';
}

function payOf(base) {
  if (!base || typeof base !== 'object') return undefined;
  const v = base.value && typeof base.value === 'object' ? base.value : {};
  const min = Number(v.minValue ?? v.value);
  const max = Number(v.maxValue ?? v.value);
  if (!(min > 0) && !(max > 0)) return undefined;
  return { min: min > 0 ? min : max, max: max > 0 ? max : min, currency: str(base.currency) || 'USD', unit: str(v.unitText) || 'HOUR' };
}

// The listing URL: https and exactly the pinned host.
function listingUrl(j) {
  const raw = str(j.url);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === TRUSTED_HOST ? parsed.href : '';
  } catch {
    return '';
  }
}

/**
 * Normalize one JSON-LD JobPosting. Exported for unit tests.
 * Drops: non-objects, no title, no aigigjobs.com posting URL, and postings whose
 * `validThrough` has passed.
 *
 * @param {any} j
 * @param {number} [now] epoch ms, injectable for tests
 */
export function normalizeAigigJob(j, now = Date.now()) {
  if (!j || typeof j !== 'object') return null;
  const title = str(j.title);
  const url = listingUrl(j);
  if (!title || !url) return null;
  const validThrough = Date.parse(str(j.validThrough));
  if (Number.isFinite(validThrough) && validThrough < now) return null;

  const company = str(j.hiringOrganization?.name).replace(/^via\s+/i, '') || 'AIGigJobs';
  /** @type {{ title: string, url: string, company: string, location: string, description?: string, postedAt?: number, meta: { employmentType?: string | string[], pay?: object } }} */
  const job = { title, url, company, location: locationOf(j), meta: {} };
  const description = typeof j.description === 'string' ? htmlToText(j.description) : '';
  if (description) job.description = description;
  const postedAt = Date.parse(str(j.datePosted));
  if (Number.isFinite(postedAt)) job.postedAt = postedAt;
  if (j.employmentType) job.meta.employmentType = j.employmentType;
  const pay = payOf(j.baseSalary);
  if (pay) job.meta.pay = pay;
  return job;
}

/** @type {Provider} */
export default {
  id: 'aigigjobs',

  detect(entry) {
    return entry?.provider === 'aigigjobs' ? { url: BASE } : null;
  },

  async fetch(entry, ctx) {
    const pages = resolvePages(entry); // before any request
    const ctxMaxPages = Number(ctx?.maxPages);
    const pagesToFetch = ctxMaxPages > 0 ? pages.slice(0, ctxMaxPages) : pages;
    const seen = new Set();
    const out = [];

    for (let i = 0; i < pagesToFetch.length; i++) {
      if (i > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const url = `${BASE}/${pagesToFetch[i]}`;
      // redirect:'error' prevents SSRF via server-side redirects
      const html = await fetchTextWithRetry(ctx, url, { redirect: 'error' });
      const { count, blocks } = jsonLdBlocks(typeof html === 'string' ? html : '');
      if (count === 0) {
        throw new Error(`aigigjobs: no JSON-LD on ${pagesToFetch[i]} — the page layout changed or this is not an AIGigJobs page`);
      }
      for (const node of flatten(blocks).filter(isJobPosting)) {
        const job = normalizeAigigJob(node);
        if (job && !seen.has(job.url)) {
          seen.add(job.url);
          out.push(job);
        }
      }
    }
    return out;
  },
};
