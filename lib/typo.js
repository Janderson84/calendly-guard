/**
 * Domain typo correction engine.
 *
 * Given an invalid email and optionally the prospect's name + company website,
 * generates candidate corrected emails, verifies them, and returns ranked
 * suggestions.
 */

import { extractDomain, levenshtein, splitName, hasMxRecords, verifyEmail } from './investigate.js';

// Common TLD corrections — TLD typos people actually make.
const TLD_FIXES = {
  '.co.uk': ['.com', '.co.uk'],
  '.co':    ['.com'],
  '.con':   ['.com'],
  '.cm':    ['.com'],
  '.comm':  ['.com'],
  '.org.uk': ['.co.uk', '.org'],
  '.eu':    ['.com', '.org', '.net'],
  '.couk':  ['.co.uk'],
  '.uk':    ['.co.uk', '.com'],
  '.com.uk': ['.co.uk', '.com'],
};

// Common free providers — if the domain looks like a typo of one of these,
// suggest the correction.
const FREE_PROVIDERS = [
  'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com',
  'icloud.com', 'aol.com', 'protonmail.com', 'live.com',
];

/**
 * Generate candidate domains from a possibly-typo'd domain.
 * Returns array of { domain, source } candidates.
 */
export function generateDomainCandidates(invalidDomain, companyWebsite) {
  const candidates = [];
  const domain = invalidDomain.toLowerCase();
  const companyDomain = companyWebsite ? extractDomain(companyWebsite)?.toLowerCase() : null;

  // 1. If we have a company website, that's the strongest signal.
  if (companyDomain && companyDomain !== domain) {
    candidates.push({ domain: companyDomain, source: 'company_website' });
  }

  // 2. TLD fixes — check if domain ends with a known typo pattern.
  for (const [badTld, goodTlds] of Object.entries(TLD_FIXES)) {
    if (domain.endsWith(badTld)) {
      const base = domain.slice(0, -badTld.length);
      for (const goodTld of goodTlds) {
        const candidate = base + goodTld;
        if (candidate !== domain) {
          candidates.push({ domain: candidate, source: `tld_fix:${badTld}→${goodTld}` });
        }
      }
    }
  }

  // 3. Free provider fuzzy match — maybe they mistyped gmail.com.
  for (const provider of FREE_PROVIDERS) {
    const dist = levenshtein(domain, provider);
    if (dist > 0 && dist <= 2) {
      candidates.push({ domain: provider, source: `provider_fuzzy(dist=${dist})` });
    }
  }

  // Deduplicate by domain, keeping the first (highest-priority) source.
  const seen = new Set();
  return candidates.filter(c => {
    if (seen.has(c.domain)) return false;
    seen.add(c.domain);
    return true;
  });
}

/**
 * Given a name, try common corporate email patterns.
 * e.g. Imelda Godwin @ joyfulcare.co.uk →
 *   imelda.godwin@, imeldagodwin@, imelda@, i.godwin@, etc.
 */
export function generateEmailPatterns(localPart, firstName, lastName, domain) {
  const f = (firstName || '').toLowerCase().replace(/[^a-z]/g, '');
  const l = (lastName || '').toLowerCase().replace(/[^a-z]/g, '');
  const lPart = (localPart || '').toLowerCase().replace(/[^a-z0-9._-]/g, '');

  const patterns = [];
  if (f && l) {
    patterns.push(`${f}.${l}`, `${f}${l}`, `${f}`, `${f[0]}.${l}`, `${f[0]}${l}`, `${l}`, `${f}_${l}`);
  }
  // Always include the original local part — maybe the domain was the only typo.
  if (lPart && !patterns.includes(lPart)) patterns.push(lPart);

  return patterns.map(p => `${p}@${domain}`);
}
