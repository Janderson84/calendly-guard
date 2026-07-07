/**
 * Shared utility functions for Calendly Guard investigation.
 */

import { resolveMx } from 'node:dns/promises';

/** Levenshtein edit distance. */
export function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

/** Split "Imelda Godwin" → { first: "Imelda", last: "Godwin" }. */
export function splitName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/);
  if (parts.length < 2) return { first: parts[0] || '', last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/** Extract bare domain from URL or email (strip protocol, www, path). */
export function extractDomain(str) {
  if (!str) return null;
  const m = str.match(/(?:https?:\/\/)?(?:www\.)?([^/]+)/);
  return m ? m[1].toLowerCase().replace(/\/.*$/, '') : null;
}

/** DNS MX record lookup — returns true if the domain has mail records. */
export async function hasMxRecords(domain) {
  try {
    const records = await resolveMx(domain);
    return records && records.length > 0;
  } catch {
    return false;
  }
}

/** Reoon email verification. */
export async function verifyEmail(email) {
  const REOON_API_KEY = process.env.REOON_API_KEY;
  const url = `https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(email)}&key=${REOON_API_KEY}&mode=quick`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Reoon API ${res.status}`);
  return res.json();
}

/** Apollo person match — supports email OR name+company lookup. */
export async function apolloMatch({ email, firstName, lastName, companyName }) {
  const APOLLO_API_KEY = process.env.APOLLO_API_KEY;
  if (!APOLLO_API_KEY) return null;
  try {
    const body = { reveal_phone_number: true };
    if (email) {
      body.email = email;
    } else {
      if (firstName)    body.first_name = firstName;
      if (lastName)     body.last_name = lastName;
      if (companyName)  body.organization_name = companyName;
    }
    const res = await fetch('https://api.apollo.io/api/v1/people/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': APOLLO_API_KEY },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const p = data?.person;
    if (!p || !p.id) return null;
    const org = p.organization || {};
    return {
      firstName:     p.first_name || null,
      lastName:      p.last_name  || null,
      fullName:      p.name       || null,
      title:         p.title      || null,
      email:         p.email      || null,
      phone:         p.sanitized_phone || null,
      linkedin:      p.linkedin_url || null,
      company:       p.organization_name || org.name || null,
      industry:      org.industry        || null,
      employeeCount: org.estimated_num_employees || null,
      website:       org.website_url     || null,
      companyDomain: extractDomain(org.website_url) || null,
    };
  } catch (err) {
    console.warn('[Investigate] Apollo match failed:', err.message);
    return null;
  }
}
