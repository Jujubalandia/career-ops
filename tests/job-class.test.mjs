// tests/job-class.test.mjs — data / AI job classification (lib/job-class.mjs).
// Titles in the first table are real postings from the AIGigJobs corpus (05/10/2026).
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nJob classification');

try {
  const { classifyJob, normalizePay, ENGAGEMENTS, DOMAINS } = await import(pathToFileURL(join(ROOT, 'lib/job-class.mjs')).href);
  const ok = (cond, msg) => (cond ? pass(msg) : fail(msg));
  const C = 'CONTRACTOR';

  // [title, org, employmentType, engagement, domain]
  const golden = [
    // engineering / research that the AI-and-data sources want to keep
    ['Machine Learning Engineer', 'micro1', C, 'freelance-gig', 'ai-ml-eng'],
    ['ML Engineer', 'micro1', C, 'freelance-gig', 'ai-ml-eng'],
    ['Senior Software Engineer — Agentic Coding', 'via Alignerr', C, 'freelance-gig', 'ai-ml-eng'],
    ['MLOps Engineer, LLM Systems (Serving, GPU Kernels, Profiling)', 'Mercor', C, 'freelance-gig', 'ai-ml-eng'],
    ['Software Engineer - Machine Learning', 'via Alignerr', C, 'freelance-gig', 'ai-ml-eng'],
    ['Robotics ML Expert — MuJoCo Environments', 'via Alignerr', C, 'freelance-gig', 'ai-ml-eng'],
    ['LLM Research Scientist (Pre-training & Computer Vision)', 'Mercor', C, 'freelance-gig', 'ai-ml-eng'],
    ['Forward Deployed Engineer', 'micro1', C, 'freelance-gig', 'ai-ml-eng'],
    ['Applied AI Research Engineer', 'Appen', undefined, 'freelance-gig', 'ai-ml-eng'],
    ['Member of Technical Staff, Enterprise AI', 'micro1', 'FULL_TIME', 'employee', 'ai-ml-eng'],
    ['Data Scientist', 'micro1', C, 'freelance-gig', 'data-science'],
    ['Data Science Expert', 'Dorado', C, 'freelance-gig', 'data-science'],
    ['Data Scientist (Masters)', 'via Alignerr', C, 'freelance-gig', 'data-science'],
    ['Senior Python Data Scraping Engineer (Freelance)', 'Toloka', C, 'freelance-gig', 'data-eng'],
    ['E-commerce Data Analyst', 'via Alignerr', C, 'freelance-gig', 'data-analytics'],
    ['AI Benchmark Researcher', 'Outlier', C, 'freelance-gig', 'ai-eval'],
    ['Machine Learning (ML) AI Task Auditor - Freelance AI Trainer Project', 'Meridial', C, 'freelance-gig', 'ai-eval'],
    ['ML Engineer Specialist - Freelance AI Trainer Project', 'Meridial', C, 'freelance-gig', 'ai-ml-eng'],
    // platform task writing: freelance work, but not engineering
    ['Software Engineer Task Author', 'via Alignerr', C, 'freelance-gig', 'ai-training-ops'],
    ['CFD Engineer — AI Task Designer (OpenFOAM)', 'via Alignerr', C, 'freelance-gig', 'ai-training-ops'],
    ['Structural Engineer — AI Task Creator (OpenSees)', 'via Alignerr', C, 'freelance-gig', 'ai-training-ops'],
    // crowd tasks
    ['Data Labeling Specialist', 'via Alignerr', C, 'crowd-task', 'ai-training-ops'],
    ['Dutch Transcription Expert', 'micro1', C, 'crowd-task', 'ai-training-ops'],
    ['AI Data Collection Contributor - Spanish (Mexico)', 'DATAmundi', C, 'crowd-task', 'ai-training-ops'],
    ['EHR Annotation Specialist', 'via Alignerr', C, 'crowd-task', 'ai-training-ops'],
    ['Kinyarwanda Language Specialist - Freelance AI Trainer Project', 'Meridial', C, 'crowd-task', 'ai-training-ops'],
    ['Cantonese Language Evaluator', 'micro1', C, 'crowd-task', 'non-tech'],
    ['Market Curation Editor — Politics', 'Meridial', C, 'crowd-task', 'non-tech'],
    // domain experts
    ['Emergency Medicine Physician (MD)', 'Boron', C, 'expert-panel', 'non-tech'],
    ['Bankruptcy Attorney', 'micro1', C, 'expert-panel', 'non-tech'],
    ['Mathematical Physicist (PhD)', 'Mercor', C, 'expert-panel', 'non-tech'],
    ['Bilingual Russian Psychologist (PhD)', 'micro1', C, 'expert-panel', 'non-tech'],
    ['Freelance Brand Designer', 'Toloka', C, 'expert-panel', 'non-tech'],
    ['Video Editor', 'micro1', C, 'expert-panel', 'non-tech'],
    ['AI Research Evaluator (STEM PhD/MS)', 'Leading AI Lab', C, 'expert-panel', 'ai-eval'],
    // platform work that is neither AI nor data
    ['Software Engineer - Backend', 'via Alignerr', C, 'freelance-gig', 'software-eng'],
    ['DevOps / IaC Engineer', 'via Alignerr', C, 'freelance-gig', 'software-eng'],
    ['Strategic Sourcing Lead – Fulfillment', 'Appen', C, 'freelance-gig', 'non-tech'],
    ['Open Source GitHub Maintainer', 'micro1', C, 'freelance-gig', 'non-tech'],
    // employers that are not platforms (the other catalog sources)
    ['Senior ML Engineer', 'Acme Test Co', 'FULL_TIME', 'employee', 'ai-ml-eng'],
    ['Staff Machine Learning Engineer', 'Acme Test Co', undefined, 'unknown', 'ai-ml-eng'],
    ['AI Consultant', 'Acme Test Co', C, 'contract', 'non-tech'],
    ['Part-time Data Engineer', 'Acme Test Co', 'PART_TIME', 'contract', 'data-eng'],
    // the profile's own archetypes: governance (B) and data / AI management (C)
    ['AI Governance Lead', 'Acme Test Co', 'FULL_TIME', 'employee', 'governance'],
    ['Responsible AI Policy Lead', undefined, undefined, 'unknown', 'governance'],
    ['Data Governance Analyst', undefined, undefined, 'unknown', 'governance'],
    ['Especialista em Governança de Dados', undefined, undefined, 'unknown', 'governance'],
    ['Head of Data & AI', undefined, undefined, 'unknown', 'data-ai-mgmt'],
    ['Head of AI', undefined, undefined, 'unknown', 'data-ai-mgmt'],
    ['Director of Machine Learning', undefined, undefined, 'unknown', 'data-ai-mgmt'],
    ['Data Manager', undefined, undefined, 'unknown', 'data-ai-mgmt'],
    ['AI Engineering Manager', undefined, undefined, 'unknown', 'data-ai-mgmt'],
    ['Data Engineering Manager', undefined, undefined, 'unknown', 'data-ai-mgmt'],
    ['Engineering Manager, Data Platform', undefined, undefined, 'unknown', 'data-ai-mgmt'],
    ['Gerente de Dados e IA', undefined, undefined, 'unknown', 'data-ai-mgmt'],
    ['Gestor de IA', undefined, undefined, 'unknown', 'data-ai-mgmt'],
    ['Diretor de Dados', undefined, undefined, 'unknown', 'data-ai-mgmt'],
    // Portuguese engineering titles
    ['Engenheiro de IA Sênior', undefined, undefined, 'unknown', 'ai-ml-eng'],
    ['Engenheira de Dados', undefined, undefined, 'unknown', 'data-eng'],
    ['Cientista de Dados', undefined, undefined, 'unknown', 'data-science'],
    ['Analista de Dados', undefined, undefined, 'unknown', 'data-analytics'],
    // look-alikes that must NOT become management or engineering
    ['Product Manager, AI', undefined, undefined, 'unknown', 'non-tech'],
    ['Lead ML Engineer', undefined, undefined, 'unknown', 'ai-ml-eng'],
  ];
  let wrong = 0;
  for (const [title, org, type, engagement, domain] of golden) {
    const r = classifyJob({ title, org, employmentType: type });
    if (r.engagement === engagement && r.domain === domain) continue;
    wrong++;
    fail(`"${title}" (${org ?? '-'}, ${type ?? '-'}): expected ${engagement}/${domain}, got ${r.engagement}/${r.domain}`);
  }
  if (wrong === 0) pass(`${golden.length} real titles classify as expected (engagement and domain)`);

  // the vocabularies are closed
  const all = golden.map(([title, org, type]) => classifyJob({ title, org, employmentType: type }));
  ok(all.every((r) => ENGAGEMENTS.includes(r.engagement) && DOMAINS.includes(r.domain)), 'every result is inside the closed ENGAGEMENTS / DOMAINS vocabularies');

  // engagement details
  ok(classifyJob({ title: 'Account Executive', org: 'Appen', employmentType: 'FULL_TIME' }).engagement === 'employee', 'FULL_TIME at a platform is a job, not a gig (the type is read before the org)');
  ok(classifyJob({ title: 'ML Engineer', org: 'Appen', employmentType: 'CONTRACTOR' }).engagement === 'freelance-gig', 'CONTRACTOR at a platform is a gig');
  ok(classifyJob({ title: 'ML Engineer', org: 'Acme Test Co', employmentType: ['FULL_TIME'] }).engagement === 'employee', 'employmentType may be an array');
  ok(classifyJob({ title: 'ML Engineer', org: 'Acme Test Co', employmentType: 'full_time' }).engagement === 'employee', 'employmentType is case-insensitive');
  ok(classifyJob({ title: 'ML Engineer', org: 'Acme Test Co' }).engagement === 'unknown', "no employment type is 'unknown', never guessed as employee");
  ok(classifyJob({ title: 'ML Engineer', org: 'Acme Test Co', employmentType: '' }).engagement === 'unknown', 'an empty employment type is unknown too');

  // seniority comes from classify-tier.mjs
  ok(classifyJob({ title: 'Senior ML Engineer' }).tier === 'senior', 'tier: senior');
  ok(classifyJob({ title: 'Junior Data Analyst' }).tier === 'entry', 'tier: entry');
  ok(classifyJob({ title: 'ML Engineer' }).tier === 'mid', 'tier: mid is the default');

  // pay
  const P = (p) => normalizePay(p);
  const a = P({ min: 250, max: 250, currency: 'USD', unit: 'HOUR' });
  ok(a?.text === '$250/h' && a.tier === 'high', 'pay: a single hourly figure is "$250/h", tier high');
  const b = P({ min: 60, max: 150, currency: 'USD', unit: 'HOUR' });
  ok(b?.text === '$60-150/h' && b.tier === 'high', 'pay: a range is "$60-150/h" and the tier follows the top of the range');
  ok(P({ min: 40, max: 50, unit: 'HOUR' })?.tier === 'mid', 'pay: top of range 50 is tier mid');
  ok(P({ min: 13, max: 13, unit: 'HOUR' })?.tier === 'entry', 'pay: 13/h is tier entry');
  const annual = P({ min: 150000, max: 200000, currency: 'USD', unit: 'HOUR' });
  ok(annual?.min === 72.1 && annual.max === 96.2 && annual.text === '$72.1-96.2/h', 'pay: "200000 per HOUR" is read as a yearly salary (the real 05/10 case), not as $200000/h');
  ok(P({ min: 120000, max: 120000, unit: 'YEAR' })?.text === '$57.7/h', 'pay: a YEAR unit is divided by 2080 hours');
  ok(P({ min: 8000, max: 8000, unit: 'MONTH' })?.text === '$46.2/h', 'pay: a MONTH unit is divided by 173 hours');
  ok(P({ min: 400, max: 400, unit: 'DAY' })?.text === '$50/h', 'pay: a DAY unit is divided by 8 hours');
  const brl = P({ min: 100, max: 100, currency: 'BRL', unit: 'HOUR' });
  ok(brl?.text === 'BRL 100/h' && brl.tier === null, 'pay: a non-USD currency keeps its code and gets no tier');
  ok(P({ min: 90, unit: 'HOUR' })?.text === '$90/h' && P({ max: 90, unit: 'HOUR' })?.text === '$90/h', 'pay: only one bound given is used for both');
  ok(P({ min: 150, max: 60, unit: 'HOUR' })?.text === '$60-150/h', 'pay: swapped bounds are put in order');
  ok(P(null) === null && P(undefined) === null && P('x') === null && P({}) === null && P({ min: 0, max: 0 }) === null && P({ min: NaN }) === null && P({ min: -5, max: -1 }) === null, 'pay: absent, zero, NaN or negative values give null');
  ok(P({ min: 50, unit: 'FORTNIGHT' }) === null, 'pay: an unknown unit gives null instead of a wrong number');

  // label (what goes into the pipeline note)
  ok(classifyJob({ title: 'ML Engineer', org: 'micro1', employmentType: C, pay: { min: 60, max: 150, unit: 'HOUR' } }).label === 'freelance/ai-ml-eng $60-150/h', 'label: freelance/domain plus pay');
  ok(classifyJob({ title: 'ML Engineer', org: 'Acme Test Co' }).label === 'ai-ml-eng', "label: an unknown engagement is omitted, only the domain remains");
  ok(classifyJob({ title: 'ML Engineer', pay: { min: 120, max: 120, unit: 'HOUR' } }).label === 'ai-ml-eng $120/h', 'label: domain plus pay when the engagement is unknown');
  ok(classifyJob({ title: 'ML Engineer', org: 'Acme Test Co', employmentType: 'FULL_TIME' }).label === 'employee/ai-ml-eng', 'label: employee/domain');
  ok(classifyJob({ title: 'Data Labeling Specialist', org: 'via Alignerr', employmentType: C }).label === 'crowd/ai-training-ops', 'label: crowd/domain');
  ok(classifyJob({ title: 'Mathematical Physicist (PhD)', org: 'Mercor', employmentType: C }).label === 'expert/non-tech', 'label: expert/domain');
  ok(!/[|\n]/.test(classifyJob({ title: 'ML Engineer', org: 'micro1', employmentType: C, pay: { min: 1, max: 2, unit: 'HOUR' } }).label), 'label never contains a pipe or newline (it rides inside a pipeline cell)');

  // robustness
  const empty = classifyJob();
  ok(empty.engagement === 'unknown' && empty.domain === 'non-tech' && empty.pay === null && empty.label === 'non-tech', 'no argument does not throw');
  const nulls = classifyJob({ title: null, org: null, employmentType: null, pay: null });
  ok(nulls.domain === 'non-tech' && nulls.engagement === 'unknown', 'null fields do not throw');
  ok(classifyJob({ title: 'MACHINE LEARNING ENGINEER' }).domain === 'ai-ml-eng', 'matching is case-insensitive');
  ok(classifyJob({ title: 'Ingeniero de Aprendizaje Automático' }).domain === 'non-tech', 'an unrecognised language falls to non-tech instead of guessing');
} catch (e) {
  fail(`job-class test crashed: ${e.stack || e.message}`);
}
