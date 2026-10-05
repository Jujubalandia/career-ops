/**
 * latam-eligibility.mjs — can a Brazil-based candidate take this remote job?
 *
 * Pure and offline. Used by scripts/scan-remote-latam.mjs to gate postings from
 * remote-job boards by region. It answers one question with three outcomes:
 *
 *   true       the posting names LATAM, Brazil or "worldwide/anywhere"
 *   false      the posting restricts hiring to a region that excludes Brazil
 *              (US/Canada/EU/UK/APAC..., or a single non-Brazil country)
 *   'unknown'  the posting says nothing usable about region
 *
 * 'unknown' is a real answer, not a failure: boards such as NoDesk publish no
 * location at all. The caller keeps those rows and tags them `loc?`; it must
 * never drop them silently.
 *
 * Precedence, most specific signal first:
 *   1. An explicit restriction phrase in the location ("US only") wins over
 *      everything, including a "worldwide" in the same field.
 *   2. The location field: an accept term means eligible; otherwise a
 *      recognised non-LATAM place means ineligible. A bare "worldwide /
 *      anywhere / global" that sits next to such a place ("Global (US/CAN/EU)")
 *      lists regions instead of naming the world, so it is 'unknown'.
 *   3. A role tied to a physical place with no remote option anywhere in the
 *      text ("ONSITE London") is ineligible.
 *   4. Restriction phrasing in the title/description: "US-based", "must be
 *      authorized to work in the US", "REMOTE (UK)", "CET" time zones. US time
 *      zones are not a restriction: ET/CT overlap suits the candidate.
 *   5. The same text is then searched for accept signals, with a stricter list
 *      (bare "global"/"anywhere" are boilerplate: "a global company",
 *      "anywhere in the US"). "Remote (Global)" and "REMOTE (Worldwide)" count.
 */

import { asciiFold } from './ascii-fold.mjs';

export const DEFAULT_ACCEPT = [
  'latam', 'latin america', 'south america', 'americas',
  'brazil', 'brasil', 'worldwide', 'anywhere', 'global',
];

export const DEFAULT_REJECT = [
  'us only', 'usa only', 'united states only', 'eu only',
  'europe only', 'uk only', 'canada only',
];

// Places that, alone in the location field, exclude a Brazil-based candidate.
// Other LATAM countries are here on purpose: "Mexico" hires in Mexico, and a
// "LATAM" or "Brazil" mention is what makes a multi-country list eligible.
const NON_BRAZIL_PLACES = [
  'united states', 'usa', 'us', 'canada', 'north america',
  'europe', 'eu', 'emea', 'uk', 'united kingdom', 'ireland', 'germany',
  'france', 'spain', 'portugal', 'italy', 'netherlands', 'poland',
  'switzerland', 'sweden', 'india', 'asia', 'apac', 'australia',
  'new zealand', 'africa', 'middle east',
  'argentina', 'chile', 'colombia', 'mexico', 'peru', 'uruguay',
  'ecuador', 'venezuela', 'costa rica', 'panama',
];

// Restriction phrasing found in titles and descriptions (matched on folded text).
const REGION = '(?:us|usa|united states|eu|europe|european union|uk|united kingdom|canada)';
// Time zones that bind a role to Europe. US zones are deliberately absent: a
// Brazil-based candidate overlaps ET/CT/PT, and the profile prefers that overlap.
const EU_TZ = '(?:cet|cest|eet|eest|gmt|bst)';
const RESTRICTION_PATTERNS = [
  new RegExp(`\\b${REGION} (?:only|based|residents?|citizens?)\\b`),
  new RegExp(`\\bmust (?:be )?(?:located|based|reside)(?: in| within)? (?:the )?${REGION}\\b`),
  new RegExp(`\\b(?:authorized|authorised|eligible|legally entitled) to work in (?:the )?${REGION}\\b`),
  new RegExp(`\\bright to work in (?:the )?${REGION}\\b`),
  // "REMOTE (US)", "Remote - UK", "remote CET +/-2": remote, but inside one region.
  new RegExp(`\\bremote (?:${REGION}|${EU_TZ})\\b`),
  new RegExp(`\\btime ?zones? ${EU_TZ}\\b`),
];

// Accept signals trusted inside free text (stricter than the location field).
const TEXT_ACCEPT = [
  'latam', 'latin america', 'south america', 'brazil', 'brasil',
  'worldwide', 'work from anywhere', 'anywhere in the world', 'remote anywhere',
  'remote global', 'global remote', 'remote worldwide', 'worldwide remote',
];

// Accept terms that say "everywhere" instead of naming a place. When the same
// text also names a region that excludes Brazil ("Global (US/CAN/EU/India)"),
// they describe a list of regions, not the world, so the answer is 'unknown'.
const WEAK_ACCEPT = new Set(['worldwide', 'anywhere', 'global']);

// A role tied to a physical place, with no remote option mentioned anywhere.
const ONSITE_RE = /\b(?:onsite|on site|in person|in office|hybrid|presencial|hibrido)\b/;
const REMOTE_RE = /\b(?:remote|remoto|work from home|home office|anywhere)\b/;

const DESCRIPTION_WINDOW = 1500;

/** Fold to lowercase ASCII words; dotted acronyms first ("U.S.A." -> "usa"). */
function fold(value) {
  const raw = String(value ?? '')
    .replace(/\bu\.s\.(?:a\.?)?/gi, 'usa')
    .replace(/\be\.u\./gi, 'eu');
  return asciiFold(raw);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word phrase match on already-folded text. */
function has(folded, phrase) {
  const p = fold(phrase);
  return p !== '' && new RegExp(`(?:^| )${escapeRe(p)}(?: |$)`).test(folded);
}

function firstHit(folded, phrases) {
  return phrases.find((p) => has(folded, p)) ?? null;
}

function restriction(folded, rejectPhrases) {
  const phrase = firstHit(folded, rejectPhrases);
  if (phrase) return phrase;
  const re = RESTRICTION_PATTERNS.find((r) => r.test(folded));
  return re ? folded.match(re)[0] : null;
}

/**
 * @param {{location?: string, title?: string, description?: string}} job
 * @param {{accept?: string[], reject?: string[]}} [cfg] filters.latam from remote-latam.yml
 * @returns {{eligible: true|false|'unknown', reason: string}}
 */
export function classifyLatam(job = {}, cfg = {}) {
  const accept = cfg.accept?.length ? cfg.accept : DEFAULT_ACCEPT;
  const reject = cfg.reject?.length ? cfg.reject : DEFAULT_REJECT;
  const loc = fold(job.location);
  const text = fold(`${job.title ?? ''} ${String(job.description ?? '').slice(0, DESCRIPTION_WINDOW)}`);

  const hardLoc = restriction(loc, reject);
  if (hardLoc) return { eligible: false, reason: `reject:${hardLoc}` };

  if (loc) {
    const ok = firstHit(loc, accept);
    const bad = firstHit(loc, NON_BRAZIL_PLACES);
    if (ok && !(WEAK_ACCEPT.has(fold(ok)) && bad)) return { eligible: true, reason: `accept:${ok}` };
    if (ok && bad) return { eligible: 'unknown', reason: `mixed:${ok}+${bad}` };
    if (bad) return { eligible: false, reason: `place:${bad}` };
  }

  // Physical-presence roles are out when no remote option appears anywhere.
  const where = `${loc} ${text}`;
  if (ONSITE_RE.test(where) && !REMOTE_RE.test(where)) return { eligible: false, reason: 'onsite' };

  const hardText = restriction(text, reject);
  if (hardText) return { eligible: false, reason: `text-restriction:${hardText}` };

  const ok = firstHit(text, TEXT_ACCEPT);
  if (ok) return { eligible: true, reason: `text:${ok}` };

  return { eligible: 'unknown', reason: loc ? `no-signal:${loc}` : 'no-location' };
}
