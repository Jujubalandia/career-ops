/**
 * job-class.mjs — classify a data / AI job posting. Pure and offline.
 *
 * Remote boards mix real engineering work with labelling gigs and domain-expert
 * panels, and the title alone does not say which. This module answers three
 * questions with small closed vocabularies, so a source can keep what it wants
 * (a catalog `classes:` list) and every queued row can say what it is:
 *
 *   engagement  how the work is bought
 *     employee       a salaried role (FULL_TIME)
 *     contract       project / consulting work that is not a platform task
 *     freelance-gig  freelance or task work sold through a platform
 *     crowd-task     annotation, labelling, transcription, data collection
 *     expert-panel   domain experts (PhD, lawyers, physicians...) grading or writing
 *     unknown        the source gives no employment type: never guessed as "employee"
 *
 *   domain      what the work is about (first match wins, order below)
 *     governance     AI / data governance, responsible AI, model risk (profile archetype B)
 *     data-ai-mgmt   head / director / manager of data or AI (profile archetype C)
 *     ai-eval        evaluating or red-teaming models, AI safety, task auditing
 *     ai-ml-eng      ML / LLM / agent engineering and research, MLOps
 *     data-science   data scientists, statistics, econometrics
 *     data-eng       data engineers and scraping/pipeline engineers
 *     data-analytics data analysts
 *     ai-training-ops task authoring, labelling, transcription, data collection
 *     software-eng   general software / devops / firmware
 *     non-tech       everything else
 *
 *   pay         normalised to US$/hour, with a tier (the board's own `unit` is not
 *               trusted: "200000 per HOUR" is an annual salary, and is read as one)
 *
 * It is heuristic title matching. The catalog, not this file, decides which
 * classes a source lets into the queue.
 */

import { classifyTier } from '../classify-tier.mjs';
import { asciiFold } from './ascii-fold.mjs';

export const ENGAGEMENTS = ['employee', 'contract', 'freelance-gig', 'crowd-task', 'expert-panel', 'unknown'];
export const DOMAINS = ['governance', 'data-ai-mgmt', 'ai-eval', 'ai-ml-eng', 'data-science', 'data-eng', 'data-analytics', 'ai-training-ops', 'software-eng', 'non-tech'];

// Marketplaces that sell contractor work to AI labs. A posting from one of these is
// a platform gig unless the board says FULL_TIME.
export const PLATFORM_ORGS = /\b(alignerr|micro1|mercor|meridial|toloka|appen|outlier|scale ai|datamundi|superannotate|dorado|leading ai lab|boron)\b/;

const CROWD_TASK = /\b(annotat\w*|labell?ing|labeler|transcri\w*|contributor|data collection|raters?|language (specialist|evaluator)|curation editor)\b/;
const EXPERT_PANEL = /\b(ph ?d|md|attorney|lawyer|counsel|physician|physicist|psycholog\w*|pharmaceutical|journalist|writer|educator|instructor|photographer|(brand|graphic|ux|ui|product|interior) designer|(video|copy|photo) editor|animator|cbrn|nuclear|behavioral health|compliance)\b/;
const GIG_TITLE = /\b(freelance|ai trainer|task (author|auditor|designer|creator))\b/;

// A manager of data/AI, not a product manager: "Product Manager, AI" is a different job.
const MGMT = new RegExp([
  '(?:head|director|chief) (?:of )?(?:\\w+ ){0,3}(?:data|ai|ml|machine learning)',
  '(?:diretor\\w*|gerente|gestor\\w*) (?:de )?(?:\\w+ ){0,2}(?:dados|ia|inteligencia artificial)',
  '(?:data|ai|ml|machine learning|dados|ia)(?: \\w+){0,2} (?<!product )manager',
  '(?<!product )manager,? (?:\\w+ ){0,3}(?:data|ai|ml|machine learning)',
].map((a) => `(?:${a})`).join('|'));
const GOVERNANCE = /\b(ai governance|governanca (de |da )?(ia|dados|inteligencia artificial)|responsible ai|ai (policy|ethics|compliance|risk)|model risk|iso 42001|data governance)\b/;

const DOMAIN_RULES = [
  ['governance', GOVERNANCE],
  ['data-ai-mgmt', new RegExp(`\\b(?:${MGMT.source})\\b`)],
  ['ai-eval', /\b(ai (research )?evaluator|benchmark\w*|red ?team\w*|ai safety|model (evaluation|audit)|task auditor|reasoning (and|&) evaluation|competitive evaluations)\b/],
  ['ai-ml-eng', /\b(machine learning|ml|mlops|llm\w*|agentic|applied ai|ai (research )?engineer|engenheir[oa] de (ia|inteligencia artificial|machine learning)|agentes? de ia|member of technical staff|forward deployed|robotics ml|ai systems)\b/],
  ['data-science', /\b(data scien\w*|cientista de dados|statistic\w*|econometric\w*|quantitative)\b/],
  ['data-eng', /\b(data (engineer\w*|scraping|pipeline\w*)|engenheir[oa] de dados|scraping engineer|etl)\b/],
  ['data-analytics', /\b(data analy\w*|analista de dados)\b/],
  ['ai-training-ops', /\b(task (author|designer|creator)|ai trainer|data labeling|annotat\w*|transcri\w*|data collection)\b/],
  ['software-eng', /\b(software|backend|devops|infra\w*|firmware|mechatronics|full ?stack|developer|engineer\w*|cfd|structural|lean 4)\b/],
];

const HOURS_PER_YEAR = 2080;
const HOURS_PER_MONTH = 173;
// Above this an "hourly" figure is not an hourly figure.
const IMPLAUSIBLE_HOURLY = 1000;

const fold = (value) => asciiFold(String(value ?? ''));

function engagementOf(title, org, employmentType) {
  const t = fold(title);
  const types = (Array.isArray(employmentType) ? employmentType : [employmentType]).map((e) => String(e ?? '').toUpperCase());
  if (CROWD_TASK.test(t)) return 'crowd-task';
  if (EXPERT_PANEL.test(t)) return 'expert-panel';
  if (types.includes('FULL_TIME')) return 'employee'; // before the org: a full-time job at Appen is a job
  if (GIG_TITLE.test(t) || PLATFORM_ORGS.test(fold(org))) return 'freelance-gig';
  if (types.some((e) => e === 'CONTRACTOR' || e === 'PART_TIME' || e === 'TEMPORARY')) return 'contract';
  return 'unknown';
}

function domainOf(title) {
  const t = fold(title);
  if (!t) return 'non-tech';
  for (const [name, re] of DOMAIN_RULES) if (re.test(t)) return name;
  return 'non-tech';
}

const num = (n) => (Number.isFinite(n) && n > 0 ? n : null);
const round = (n) => (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10);

/**
 * Normalise a board's pay figure to hourly. `unit` is HOUR | DAY | WEEK | MONTH | YEAR.
 * Returns null when there is nothing usable.
 *
 * @param {{min?: number, max?: number, currency?: string, unit?: string}} [pay]
 * @returns {{min: number, max: number, currency: string, tier: 'high'|'mid'|'entry'|null, text: string} | null}
 */
export function normalizePay(pay) {
  if (!pay || typeof pay !== 'object') return null;
  let min = num(pay.min);
  let max = num(pay.max);
  if (min === null && max === null) return null;
  if (min === null) min = max;
  if (max === null) max = min;
  if (min > max) [min, max] = [max, min];

  const unit = String(pay.unit ?? 'HOUR').toUpperCase();
  let per = { HOUR: 1, DAY: 8, WEEK: 40, MONTH: HOURS_PER_MONTH, YEAR: HOURS_PER_YEAR }[unit];
  if (per === undefined) return null;
  if (per === 1 && max > IMPLAUSIBLE_HOURLY) per = HOURS_PER_YEAR; // "200000 per HOUR" is a yearly salary
  const lo = round(min / per);
  const hi = round(max / per);

  const currency = String(pay.currency ?? 'USD').toUpperCase();
  const usd = currency === 'USD';
  const tier = usd ? (hi >= 100 ? 'high' : hi >= 50 ? 'mid' : 'entry') : null;
  const sym = usd ? '$' : `${currency} `;
  const text = lo === hi ? `${sym}${hi}/h` : `${sym}${lo}-${hi}/h`;
  return { min: lo, max: hi, currency, tier, text };
}

const ENGAGEMENT_SHORT = { employee: 'employee', contract: 'contract', 'freelance-gig': 'freelance', 'crowd-task': 'crowd', 'expert-panel': 'expert' };

/**
 * @param {{title?: string, org?: string, employmentType?: string|string[], pay?: object}} job
 * @returns {{engagement: string, domain: string, tier: string, pay: object|null, label: string}}
 */
export function classifyJob(job = {}) {
  const title = String(job?.title ?? '');
  const engagement = engagementOf(title, job?.org, job?.employmentType);
  const domain = domainOf(title);
  const pay = normalizePay(job?.pay);
  const head = ENGAGEMENT_SHORT[engagement] ? `${ENGAGEMENT_SHORT[engagement]}/${domain}` : domain;
  return {
    engagement,
    domain,
    tier: classifyTier(title),
    pay,
    label: pay ? `${head} ${pay.text}` : head,
  };
}
