// tests/remote-latam-eligibility.test.mjs — region gate for the remote-LATAM sources.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nRemote LATAM — eligibility');

try {
  const { classifyLatam, DEFAULT_ACCEPT } = await import(
    pathToFileURL(join(ROOT, 'lib/latam-eligibility.mjs')).href
  );

  const check = (label, job, want, cfg) => {
    const got = classifyLatam(job, cfg).eligible;
    if (got === want) pass(`${label} -> ${JSON.stringify(want)}`);
    else fail(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)} (${classifyLatam(job, cfg).reason})`);
  };

  // Location values as the boards publish them (Remotive candidate_required_location,
  // Himalayas locationRestrictions, Jobicy jobGeo, Get on Board countries).
  check('Remotive "Worldwide"', { location: 'Worldwide' }, true);
  check('Remotive "LATAM"', { location: 'LATAM' }, true);
  check('Remotive "Americas"', { location: 'Americas' }, true);
  check('Remotive "Brazil"', { location: 'Brazil' }, true);
  check('accented "São Paulo, Brasil"', { location: 'São Paulo, Brasil' }, true);
  check('Jobicy "Anywhere"', { location: 'Anywhere' }, true);
  check('"Latin America"', { location: 'Latin America' }, true);
  check('"Global"', { location: 'Global' }, true);
  check('Himalayas "Brazil, Argentina"', { location: 'Brazil, Argentina' }, true);

  check('Remotive "USA Only"', { location: 'USA Only' }, false);
  check('"USA, Canada"', { location: 'USA, Canada' }, false);
  check('Himalayas "United States, Canada"', { location: 'United States, Canada' }, false);
  check('"Europe"', { location: 'Europe' }, false);
  check('"North America" is not "Americas"', { location: 'North America' }, false);
  check('"Remote - EMEA"', { location: 'Remote - EMEA' }, false);
  check('"Germany"', { location: 'Germany' }, false);
  check('"Remote (US)"', { location: 'Remote (US)' }, false);
  check('dotted "U.S.A."', { location: 'U.S.A.' }, false);
  check('another LATAM country alone ("Argentina")', { location: 'Argentina' }, false);
  check('"Mexico" alone', { location: 'Mexico' }, false);

  // An explicit restriction beats a "worldwide" in the same field.
  check('"Worldwide (US only)"', { location: 'Worldwide (US only)' }, false);

  // Empty or bare "Remote": decided by title/description, else 'unknown'.
  check('empty location, no text', {}, 'unknown');
  check('"Remote" alone', { location: 'Remote', title: 'AI Engineer' }, 'unknown');
  check('"Remote" + description names LATAM',
    { location: 'Remote', title: 'AI Engineer', description: 'We hire anywhere in LATAM.' }, true);
  check('"Remote" + must be authorized to work in the US',
    { location: 'Remote', title: 'AI Engineer', description: 'Candidates must be authorized to work in the United States.' }, false);
  check('"Remote" + "US-based" in the title',
    { location: 'Remote', title: 'Senior AI Engineer (US-based)' }, false);
  check('empty location + "work from anywhere"',
    { title: 'ML Engineer', description: 'Work from anywhere, async team.' }, true);

  // Words that look like signals but are not.
  check('"contact us" is not a US restriction',
    { location: 'Remote', title: 'AI Engineer', description: 'Contact us for details.' }, 'unknown');
  check('"a global company" is not an accept signal in free text',
    { location: 'Remote', title: 'AI Engineer', description: 'We are a global company.' }, 'unknown');
  check('"anywhere in the US" is not an accept signal',
    { location: 'Remote', title: 'AI Engineer', description: 'Work from home anywhere in the US.' }, 'unknown');

  // Cases found by the first live dry-run (Hacker News "Who is hiring?" lines,
  // where location rides inside the title).
  check('HN "ONSITE London, UK" with no remote option',
    { title: 'Planlab.ai / Platform Engineer / ONSITE in London, UK / 100k-160k GBP' }, false);
  check('HN "On-site Berlin"',
    { title: 'Charly / (Founding) AI Systems Engineer / 60-100k EUR / On-site Berlin' }, false);
  check('onsite location field "Boston, MA Onsite"', { location: 'Boston, MA Onsite' }, false);
  check('onsite wording is fine when a remote option is also offered',
    { title: 'Kraken Tech / Senior Engineer / London, Paris, Berlin, New York, Remote' }, 'unknown');
  check('HN "REMOTE (UK)"', { title: 'AssumeAI / AI Engineer / Contract / REMOTE (UK)' }, false);
  check('HN "REMOTE (US)"', { title: 'Tahoma AI / Founding Engineer / REMOTE (US) / Full-time' }, false);
  check('HN "REMOTE (CET +/-2)"', { title: 'JUPUS / Engineering Manager, Applied AI / REMOTE (CET ±2)' }, false);
  check('Working Nomads "Time zone: CET"', { location: 'Time zone: CET (+/- 3 hours)' }, false);
  check('US time zones are not a restriction (ET/CT overlap is welcome)',
    { location: 'Remote', title: 'AI Engineer', description: 'Overlap with EST hours required.' }, 'unknown');
  check('HN "REMOTE (Worldwide)" in the title',
    { title: 'Tether / AI Harness Engineer / REMOTE (Worldwide) / Full-time' }, true);
  check('HN "Remote (Global)" in the title',
    { title: 'Enveritas / Backend Software Engineer / Remote (Global) / nonprofit' }, true);
  check('"Global" that lists regions excluding Brazil is not "the world"',
    { location: 'Global (US/CAN/EU/India)' }, 'unknown');
  check('"Worldwide" with an excluded region listed',
    { location: 'Worldwide, Europe' }, 'unknown');
  check('"LATAM" still wins next to other regions',
    { location: 'Northern America, LATAM, Europe, APAC' }, true);

  // Found by the live run of the RemoteYeah / TryRemotely providers: structured
  // location fields name a country the short place list did not know.
  for (const country of ['Egypt', 'China', 'Nigeria', 'Vietnam', 'Japan', 'Poland', 'Türkiye', 'Egypt, China']) {
    check(`any country is a restriction: "${country}"`, { location: country }, false);
  }
  check('Brazil next to another country is still eligible', { location: 'Brazil, Egypt' }, true);
  check('"Toronto (Hybrid)" decides on its own, even if the text says remote',
    { location: 'Toronto (Hybrid)', title: 'TPM, AI Programs', description: 'You can work remotely some days.' }, false);
  check('"Berlin, Germany (On-site)"', { location: 'Berlin, Germany (On-site)' }, false);
  check('"São Paulo (Hybrid)" stays eligible (a target of the profile)', { location: 'São Paulo (Hybrid)' }, true);
  check('a plain "Remote" location is not an on-site tag',
    { location: 'Remote', title: 'AI Engineer' }, 'unknown');

  // Robustness and config.
  check('null fields do not throw', { location: null, title: undefined, description: null }, 'unknown');
  check('no argument does not throw', undefined, 'unknown');
  check('custom accept list from remote-latam.yml',
    { location: 'Remote - Chile' }, true, { accept: ['chile'] });
  check('custom reject phrase from remote-latam.yml',
    { location: 'Worldwide, Dutch only' }, false, { reject: ['dutch only'] });
  check('empty cfg lists fall back to the defaults',
    { location: 'Worldwide' }, true, { accept: [], reject: [] });

  if (Array.isArray(DEFAULT_ACCEPT) && DEFAULT_ACCEPT.includes('brazil')) pass('DEFAULT_ACCEPT exported and includes brazil');
  else fail('DEFAULT_ACCEPT missing or without brazil');

  // The reason string is what the runner writes into the pipeline note.
  const r = classifyLatam({ location: 'USA Only' });
  if (r.eligible === false && /^reject:/.test(r.reason)) pass(`reason is machine-readable (${r.reason})`);
  else fail(`unexpected reason shape: ${JSON.stringify(r)}`);
} catch (e) {
  fail(`remote-latam-eligibility test crashed: ${e.message}`);
}
