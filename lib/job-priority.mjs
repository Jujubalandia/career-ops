/**
 * job-priority.mjs — which queue rows to look at first. Pure and offline.
 *
 *   tier 1  remote role open to LATAM/Brazil in AI engineering and its neighbours
 *           (ai-ml-eng, ai-eval, data-science, data-eng, governance): profile archetypes A and B
 *   tier 2  head / director / manager of data or AI (data-ai-mgmt), remote open to Brazil
 *           or based in São Paulo; AI/data governance based in São Paulo: archetype C
 *   tier 3  everything else (kept, never dropped)
 *
 * The tier rides in the row's note as `prio:N`; sortPending and fresh-pending order by it
 * (tier ascending, then newest first). Rows with no tag are classified from their own title
 * and location by `lineTier`, so scan.mjs portal rows sort the same way.
 */

import { classifyJob } from './job-class.mjs';
import { classifyLatam } from './latam-eligibility.mjs';
import { asciiFold } from './ascii-fold.mjs';

export const TIER1_DOMAINS = ['ai-ml-eng', 'ai-eval', 'data-science', 'data-eng', 'governance'];
const TIER2_DOMAINS = ['data-ai-mgmt', 'governance'];

const fold = (v) => asciiFold(String(v ?? ''));
const IN_PERSON = /\b(hybrid|hibrido|on-?site|presencial)\b/;
const REMOTE_WORDS = /\b(remote|remoto|worldwide|anywhere|global|latam|latin america|americas)\b/;
const SAO_PAULO = /\b(sao paulo|sp)\b/;

/** True when the location text says hybrid / on-site. */
export const isInPerson = (location) => IN_PERSON.test(fold(location));

/**
 * @param {{domain: string, location?: string, remote?: boolean, eligible?: true|false|'unknown'}} job
 *   `remote` defaults to "the location names a remote/region word and not hybrid / on-site"; remote-only boards pass `remote: !isInPerson(location)`; `eligible` is the
 *   classifyLatam verdict (defaults to true: the caller already region-filtered).
 * @returns {1|2|3}
 */
export function priorityTier({ domain, location = '', remote, eligible = true }) {
  const loc = fold(location);
  const isRemote = remote ?? (!IN_PERSON.test(loc) && REMOTE_WORDS.test(loc));
  const open = isRemote && eligible !== false;
  if (open && TIER1_DOMAINS.includes(domain)) return 1;
  if (TIER2_DOMAINS.includes(domain) && (open || SAO_PAULO.test(loc))) return 2;
  return 3;
}

/** `prio:N` for a note. */
export const priorityTag = (tier) => `prio:${tier}`;

/** Tier of a `## Pending` row: its `prio:N` tag, else computed from its own columns. */
export function lineTier(line) {
  const tagged = /\bprio:([123])\b/.exec(line)?.[1];
  if (tagged) return Number(tagged);
  const cols = line.replace(/^- \[ \] /, '').split(' | ');
  const title = cols[2] ?? '';
  const loc4 = cols[3] ?? '';
  const location = /^[a-z-]+: /i.test(loc4) ? '' : loc4;
  const { domain } = classifyJob({ title });
  const where = fold(`${location} ${/\| note: ([^|]*)/.exec(line)?.[1] ?? ''}`);
  const remote = !IN_PERSON.test(where) && (REMOTE_WORDS.test(where) || where.includes('remote-latam'));
  const { eligible } = classifyLatam({ title, location });
  return priorityTier({ domain, location, remote, eligible });
}
