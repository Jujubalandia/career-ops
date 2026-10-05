import { decodeEntities } from './_html-entities.mjs';
// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// RemoteYeah provider — board-wide RSS feed (https://remoteyeah.com/rss.xml).
// Public, no-auth XML that the site itself lists as "RSS feeds" in its footer;
// robots.txt allows everything and the terms carry no automation clause. Parsed
// in-process with the same tiny tag extractor as providers/weworkremotely.mjs.
//
// Unlike most remote feeds, each <item> carries a structured <location> ("Brazil",
// "Latin America", "Worldwide", or a comma list of regions) and a <company> tag,
// which is what makes a LATAM region gate possible. The feed also decorates the
// text it publishes:
//   - <title> is "Remote <Role> at <Company>": the "Remote " prefix and the
//     " at <Company>" suffix are stripped when the <company> tag confirms it.
//   - <link> ends in `?utm_source=rss&ref=rss`: dropped, the bare posting URL
//     is the dedup key.
//
// One request, no pagination (the feed holds the latest ~200 postings).
//
// Wire in via a `job_boards:` entry with `provider: remoteyeah`.

const FEED_URL = 'https://remoteyeah.com/rss.xml';
const TRUSTED_HOST = 'remoteyeah.com';
const TRACKING_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref'];
const DESCRIPTION_MAX_CHARS = 1500;

/** @param {string} url */
function assertRemoteYeahUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`remoteyeah: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`remoteyeah: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`remoteyeah: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

// NaN-safe Date.parse — `|| undefined` would also coerce a valid epoch 0.
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function fallbackCompany(entry) {
  return typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : 'RemoteYeah';
}

/** @type {Provider} */
export default {
  id: 'remoteyeah',

  detect(entry) {
    return entry?.provider === 'remoteyeah' ? { url: FEED_URL } : null;
  },

  async fetch(entry, ctx) {
    const feedUrl = assertRemoteYeahUrl(FEED_URL);
    // redirect:'error' prevents SSRF via server-side redirects; combined with
    // assertRemoteYeahUrl above it keeps the request pinned to remoteyeah.com.
    const text = await ctx.fetchText(feedUrl, { redirect: 'error' });
    // An empty feed is `[]`; a body that is not an RSS document at all (an HTML error
    // page, a captcha) must fail loudly, or "0 postings" would read as a healthy board.
    if (typeof text !== 'string' || !/<rss\b|<channel\b/i.test(text)) {
      throw new Error('remoteyeah: unexpected feed response — expected an <rss> document');
    }
    return parseRemoteYeahFeed(text, fallbackCompany(entry));
  },
};

// Resolve a tag's inner text: unwrap a CDATA section, else decode entities.
function extractText(inner) {
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1].trim();
  return decodeEntities(inner).trim();
}

// Extract the text of the first <tag>...</tag> in a block. Returns '' when absent.
function tagText(block, tag) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? extractText(m[1]) : '';
}

// Collapse whitespace; decode entities once more for text that was escaped HTML.
function squash(value) {
  return value.replace(/\s+/g, ' ').trim();
}

// Plain text of an HTML fragment, capped. Entities are decoded AFTER the tags
// are removed, so an escaped "&lt;b&gt;" in the prose cannot reintroduce markup.
function htmlToText(html) {
  const noTags = html.replace(/<(?:script|style)\b[\s\S]*?<\/(?:script|style)>/gi, ' ').replace(/<[^>]*>/g, ' ');
  return squash(decodeEntities(noTags)).slice(0, DESCRIPTION_MAX_CHARS);
}

function cleanUrl(value) {
  if (!value) return '';
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== TRUSTED_HOST) return '';
    for (const param of TRACKING_PARAMS) parsed.searchParams.delete(param);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * "Remote Senior ML Engineer at Acme" -> "Senior ML Engineer". The suffix is
 * removed only when it names the item's own <company>, so a title that merely
 * contains " at " ("Engineer at Scale") is left alone.
 */
function tidyTitle(rawTitle, company) {
  let title = squash(rawTitle).replace(/^remote\s+/i, '');
  if (company) {
    title = title.replace(new RegExp(`\\s+at\\s+${escapeRegExp(company)}$`, 'i'), '');
  }
  return title;
}

/**
 * Parse RemoteYeah's public RSS jobs feed. Exported for unit tests.
 *
 * Shape: `<rss><channel><item>...</item>...</channel></rss>`, each item carrying
 * `<title>`, `<company>`, `<location>`, `<category>`, `<description>` (HTML),
 * `<pubDate>` (ISO 8601) and `<link>`. Items without a usable https remoteyeah.com
 * link or without a title are dropped.
 *
 * @param {string} xml - raw RSS feed body
 * @param {string} [defaultCompany] - fallback when an item has no <company>
 * @returns {Array<{title: string, url: string, company: string, location: string, description?: string, postedAt?: number}>}
 */
export function parseRemoteYeahFeed(xml, defaultCompany = 'RemoteYeah') {
  if (typeof xml !== 'string') return [];
  const fallback = typeof defaultCompany === 'string' && defaultCompany.trim() ? defaultCompany.trim() : 'RemoteYeah';
  const jobs = [];
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];

  for (const item of blocks) {
    const url = cleanUrl(tagText(item, 'link'));
    if (!url) continue;

    const rawTitle = tagText(item, 'title');
    if (!rawTitle) continue;

    const company = squash(tagText(item, 'company')) || fallback;
    const title = tidyTitle(rawTitle, company === fallback ? '' : company);
    if (!title) continue;

    /** @type {{title: string, url: string, company: string, location: string, description?: string, postedAt?: number}} */
    const job = { title, url, company, location: squash(tagText(item, 'location')) };
    const description = htmlToText(tagText(item, 'description'));
    if (description) job.description = description;
    const postedAt = toEpochMs(tagText(item, 'pubDate'));
    if (postedAt !== undefined) job.postedAt = postedAt;
    jobs.push(job);
  }

  return jobs;
}
