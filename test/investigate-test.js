/**
 * Quick test for the email investigation logic.
 * Run: node test/investigate-test.js
 *
 * Tests against the real examples from James's Slack:
 *   1. joyfulcareuk@gmail.co.uk → should suggest something @joyfulcare.co.uk
 *   2. pvanaerden@aris.eu → should suggest @aris-project.eu
 *   3. ida@colombinfruit.org → should suggest @colombianfruit.org
 *
 * Note: These tests mock the network calls (Apollo, Reoon, DNS) since
 * we don't have API keys in this environment. They validate the
 * domain correction and email pattern generation logic.
 */

import { generateDomainCandidates, generateEmailPatterns } from '../lib/typo.js';
import { splitName, extractDomain, levenshtein } from '../lib/investigate.js';

let pass = 0, fail = 0;

function assert(condition, msg) {
  if (condition) { pass++; console.log(`  ✅ ${msg}`); }
  else           { fail++; console.log(`  ❌ ${msg}`); }
}

console.log('\n── Test 1: joyfulcareuk@gmail.co.uk ──');
{
  const [localPart, domain] = 'joyfulcareuk@gmail.co.uk'.split('@');
  // Simulate Apollo finding "Joyful Care Limited" with website joyfulcare.co.uk
  const candidates = generateDomainCandidates(domain, 'https://joyfulcare.co.uk');
  console.log('  Domain candidates:', candidates.map(c => `${c.domain} (${c.source})`));
  assert(candidates.some(c => c.domain === 'joyfulcare.co.uk'), 'company website domain in candidates');

  const patterns = generateEmailPatterns(localPart, 'Imelda', 'Godwin', 'joyfulcare.co.uk');
  console.log('  Email patterns:', patterns);
  assert(patterns.includes('imelda.godwin@joyfulcare.co.uk'), 'first.last pattern generated');
  assert(patterns.includes('imelda@joyfulcare.co.uk'), 'first name only pattern generated');
  assert(patterns.includes('joyfulcareuk@joyfulcare.co.uk'), 'original local part preserved');
}

console.log('\n── Test 2: pvanaerden@aris.eu ──');
{
  const [localPart, domain] = 'pvanaerden@aris.eu'.split('@');
  // TLD fix: .eu → .com, .org, .net
  const candidates = generateDomainCandidates(domain, null);
  console.log('  Domain candidates:', candidates.map(c => `${c.domain} (${c.source})`));
  assert(candidates.some(c => c.domain === 'aris.com'), '.eu→.com TLD fix');
  assert(candidates.some(c => c.domain === 'aris.org'), '.eu→.org TLD fix');

  // With company website
  const candidates2 = generateDomainCandidates(domain, 'https://aris-project.eu');
  console.log('  With company website:', candidates2.map(c => `${c.domain} (${c.source})`));
  assert(candidates2.some(c => c.domain === 'aris-project.eu'), 'company website domain in candidates');

  const patterns = generateEmailPatterns(localPart, 'Peter', 'Van Aerden', 'aris-project.eu');
  console.log('  Email patterns:', patterns);
  assert(patterns.includes('peter.van.aerden@aris-project.eu'.replace('van.', 'van')), 'name pattern generated');
}

console.log('\n── Test 3: ida@colombinfruit.org ──');
{
  const [localPart, domain] = 'ida@colombinfruit.org'.split('@');
  // Apollo finds company website colombianfruit.org
  const candidates = generateDomainCandidates(domain, 'https://colombianfruit.org');
  console.log('  Domain candidates:', candidates.map(c => `${c.domain} (${c.source})`));
  assert(candidates.some(c => c.domain === 'colombianfruit.org'), 'company website domain in candidates');

  const patterns = generateEmailPatterns(localPart, 'Ivonne', '', 'colombianfruit.org');
  console.log('  Email patterns:', patterns);
  assert(patterns.includes('ida@colombianfruit.org'), 'original local part with corrected domain');
}

console.log('\n── Test 4: TLD typo detection ──');
{
  const candidates = generateDomainCandidates('gmail.co', null);
  console.log('  gmail.co candidates:', candidates.map(c => `${c.domain} (${c.source})`));
  assert(candidates.some(c => c.domain === 'gmail.com'), 'gmail.co→gmail.com provider fuzzy match');

  const candidates2 = generateDomainCandidates('gmail.con', null);
  console.log('  gmail.con candidates:', candidates2.map(c => `${c.domain} (${c.source})`));
  assert(candidates2.some(c => c.domain === 'gmail.com'), 'gmail.con→gmail.com TLD fix');
}

console.log('\n── Test 5: Levenshtein distance ──');
{
  assert(levenshtein('colombin', 'colombian') === 1, 'colombin→colombian: distance 1 (transposition)');
  assert(levenshtein('gmail', 'gmail') === 0, 'identical strings: distance 0');
  assert(levenshtein('test', 'tent') === 1, 'test→tent: distance 1');
}

console.log('\n── Test 6: Name splitting ──');
{
  const s1 = splitName('Imelda Godwin');
  assert(s1.first === 'Imelda' && s1.last === 'Godwin', 'two-word name split');

  const s2 = splitName('Peter Van Aerden');
  assert(s2.first === 'Peter' && s2.last === 'Van Aerden', 'three-word name: first + rest');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
