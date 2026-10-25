// tests/job-priority.test.mjs — queue tiers. Pure, no network.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nJob priority — tiers');
try {
  const { priorityTier, lineTier, priorityTag, isInPerson } = await import(pathToFileURL(join(ROOT, 'lib/job-priority.mjs')).href);
  const ok = (cond, msg) => (cond ? pass(msg) : fail(msg));

  ok(priorityTier({ domain: 'ai-ml-eng', location: 'Worldwide' }) === 1, 'remote AI engineer open to LATAM: tier 1');
  ok(priorityTier({ domain: 'ai-ml-eng', location: 'São Paulo (Hybrid)' }) === 3, 'hybrid AI engineer is not tier 1');
  ok(priorityTier({ domain: 'ai-ml-eng', location: 'Germany', eligible: false }) === 3, 'region-ineligible stays out of tier 1');
  ok(priorityTier({ domain: 'data-eng', location: 'Brazil', remote: true }) === 1 && priorityTier({ domain: 'governance', location: 'Remote' }) === 1, 'neighbours (data-eng, governance) are tier 1 when remote');
  ok(priorityTier({ domain: 'data-ai-mgmt', location: 'São Paulo (Hybrid)' }) === 2, 'head/director/manager of data/AI in São Paulo hybrid: tier 2');
  ok(priorityTier({ domain: 'data-ai-mgmt', location: 'Remote - LATAM' }) === 2, 'remote manager of data/AI: tier 2 (engineering comes first)');
  ok(priorityTier({ domain: 'data-ai-mgmt', location: 'Rio de Janeiro (Hybrid)' }) === 3, 'manager outside São Paulo and not remote: tier 3');
  ok(priorityTier({ domain: 'non-tech', location: 'Remote' }) === 3 && priorityTier({ domain: 'software-eng', location: 'Remote' }) === 3, 'unrelated domains: tier 3');
  ok(isInPerson('Toronto (Hybrid)') && isInPerson('São Paulo - Híbrido') && !isInPerson('Brazil'), 'isInPerson reads hybrid / on-site words');
  ok(priorityTier({ domain: 'ai-ml-eng', location: 'São Paulo, SP' }) === 3, 'a bare city is not assumed remote');
  ok(priorityTag(2) === 'prio:2', 'tag format');

  const row = (title, loc, note = '') => `- [ ] https://x/1 | Acme | ${title} | ${loc} | posted: 2026-10-24${note ? ` | note: ${note}` : ''}`;
  ok(lineTier(row('AI Engineer', 'Remote', 'remote-latam:getonbrd prio:2')) === 2, 'an explicit prio tag wins');
  ok(lineTier(row('Senior LLM Engineer', 'Worldwide', 'remote-latam:remotive')) === 1, 'untagged remote-latam row is classified from its columns');
  ok(lineTier(row('Gerente de Dados e IA', 'São Paulo, SP', 'gupy')) === 2, 'untagged Gupy manager in São Paulo: tier 2');
  ok(lineTier(row('Machine Learning Engineer', 'San Francisco, CA')) === 3, 'untagged US-located row: tier 3');
  ok(lineTier('- [ ] https://hand/pasted') === 3, 'bare pasted URL: tier 3 (the sorter keeps hand-pasted rows on top separately)');
} catch (e) {
  fail(`job-priority test crashed: ${e.stack || e.message}`);
}
