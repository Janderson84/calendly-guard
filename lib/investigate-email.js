/**
 * investigateInvalidEmail — the main entry point for email correction.
 *
 * Called when Reoon says an email is invalid. Tries to find the correct
 * email using a multi-strategy approach:
 *
 * 1. Apollo name search — search by prospect name to find their real email
 * 2. Domain typo correction — fix common domain typos (TLD swaps, transpositions)
 * 3. Email pattern generation — try common corporate email patterns with corrected domain
 * 4. Verify candidates via MX + Reoon
 *
 * Returns a structured result with suggestions ranked by confidence.
 */

import { resolveMx } from 'node:dns/promises';
import { hasMxRecords, verifyEmail, apolloMatch, extractDomain, levenshtein, splitName } from './investigate.js';
import { generateDomainCandidates, generateEmailPatterns } from './typo.js';

/**
 * @param {Object} params
 * @param {string} params.email - the invalid email
 * @param {string} params.name - prospect name from Calendly
 * @param {string} [params.phone] - prospect phone from Calendly (optional)
 * @returns {Promise<Object>} investigation result with suggestions
 */
export async function investigateInvalidEmail({ email, name, phone }) {
  const result = {
    originalEmail: email,
    prospectName: name,
    suggestions: [],
    apolloMatch: null,
    investigationNotes: [],
  };

  const [localPart, invalidDomain] = email.split('@');
  const { first, last } = splitName(name);

  // ── Strategy 1: Apollo name search ──────────────────────────────
  // Try to find the person by name — Apollo may return their real email.
  let apolloByName = null;
  if (first && last) {
    apolloByName = await apolloMatch({ firstName: first, lastName: last });
  }

  if (apolloByName?.email) {
    result.investigationNotes.push(`Apollo found person by name: ${apolloByName.email}`);
    result.suggestions.push({
      email: apolloByName.email,
      source: 'apollo_name_match',
      confidence: 'high',
      company: apolloByName.company,
      title: apolloByName.title,
      phone: apolloByName.phone || phone,
      linkedin: apolloByName.linkedin,
      website: apolloByName.website,
    });
  }
  result.apolloMatch = apolloByName;

  // Use company info from Apollo to power domain correction
  const companyWebsite = apolloByName?.website || null;
  const companyDomain = apolloByName?.companyDomain || null;

  // ── Strategy 2: Domain typo correction ──────────────────────────
  const domainCandidates = generateDomainCandidates(invalidDomain, companyWebsite);

  for (const candidate of domainCandidates) {
    // 2a. Check MX records first — cheap filter.
    const hasMx = await hasMxRecords(candidate.domain);
    if (!hasMx) {
      result.investigationNotes.push(`Skipped ${candidate.domain} — no MX records (source: ${candidate.source})`);
      continue;
    }

    // 2b. Generate email patterns for this domain.
    const candidateEmails = generateEmailPatterns(localPart, first, last, candidate.domain);

    // 2c. For each candidate email, verify via Reoon.
    //     Limit to top 5 per domain to stay within rate limits.
    const emailsToCheck = candidateEmails.slice(0, 5);

    for (const candidateEmail of emailsToCheck) {
      if (candidateEmail.toLowerCase() === email.toLowerCase()) continue;

      try {
        const verification = await verifyEmail(candidateEmail);
        const status = verification.status;

        if (status === 'valid') {
          result.investigationNotes.push(`✅ ${candidateEmail} verified valid (source: ${candidate.source})`);
          result.suggestions.push({
            email: candidateEmail,
            source: `domain_correction (${candidate.source})`,
            confidence: 'high',
            company: apolloByName?.company || null,
            title: apolloByName?.title || null,
            phone: apolloByName?.phone || phone,
            linkedin: apolloByName?.linkedin || null,
            website: apolloByName?.website || null,
          });
        } else if (status === 'catch_all' || status === 'accept_all') {
          // Domain accepts everything — can't confirm but worth flagging.
          result.investigationNotes.push(`⚠️ ${candidateEmail} → ${status} (source: ${candidate.source})`);
          if (!result.suggestions.find(s => s.email === candidateEmail)) {
            result.suggestions.push({
              email: candidateEmail,
              source: `domain_correction (${candidate.source})`,
              confidence: 'medium',
              company: apolloByName?.company || null,
              title: apolloByName?.title || null,
              phone: apolloByName?.phone || phone,
              linkedin: apolloByName?.linkedin || null,
              website: apolloByName?.website || null,
            });
          }
        }
      } catch (e) {
        result.investigationNotes.push(`Reoon failed for ${candidateEmail}: ${e.message}`);
      }
    }
  }

  // ── Strategy 3: If we have a company domain, try apollo with it ─
  if (companyDomain && !result.suggestions.length) {
    const apolloByCompany = await apolloMatch({ firstName: first, lastName: last, companyName: apolloByName?.company });
    if (apolloByCompany?.email && apolloByCompany.email !== email) {
      result.investigationNotes.push(`Apollo found person by name+company: ${apolloByCompany.email}`);
      result.suggestions.push({
        email: apolloByCompany.email,
        source: 'apollo_name_company_match',
        confidence: 'high',
        company: apolloByCompany.company,
        title: apolloByCompany.title,
        phone: apolloByCompany.phone || phone,
        linkedin: apolloByCompany.linkedin,
        website: apolloByCompany.website,
      });
    }
  }

  // Sort: high confidence first
  const confRank = { high: 0, medium: 1, low: 2 };
  result.suggestions.sort((a, b) => (confRank[a.confidence] || 3) - (confRank[b.confidence] || 3));

  return result;
}
