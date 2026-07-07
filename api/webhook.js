/**
 * Calendly Guard — Email Validation + Lead Enrichment
 *
 * Flow:
 *  1. Calendly fires invitee.created webhook
 *  2. Fetch the scheduled event from Calendly to get AE + start time
 *  3. Validate invitee email via Reoon
 *  4. If invalid/disposable → post alert to Slack #bad-email, tag the AE
 *  5. If valid → enrich with Apollo.io (person + company data)
 *  6. Update Pipedrive person record with enriched data + add note
 */

const REOON_API_KEY    = process.env.REOON_API_KEY;
const CALENDLY_TOKEN   = process.env.CALENDLY_TOKEN;
const SLACK_BOT_TOKEN  = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL    = process.env.SLACK_CHANNEL || 'bad-email';
const APOLLO_API_KEY   = process.env.APOLLO_API_KEY;
const PIPEDRIVE_API_KEY = process.env.PIPEDRIVE_API_KEY;
const PIPEDRIVE_BASE   = 'https://api.pipedrive.com/v1';
const TG_BOT_TOKEN     = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID       = '8517055255';

// Calendly user UUID → AE info + Slack ID
const AE_MAP = {
  '28ea4155-6f63-476f-bbe8-61e4bc76a7ee': { name: 'Alfred Du',           slack: 'U0A7T58JVHP' },
  'bf87767a-d035-494f-84b8-6954260116fe': { name: 'David Morawietz',      slack: 'U0A89DVTWQ1' },
  '6510c411-b717-4835-8170-4ae1ac0e6643': { name: 'Edgar Arana',          slack: 'U0A6YPUEB7H' },
  'a14a40a4-bffb-40d4-9a9e-59c877a57244': { name: 'Gleidson Rocha',       slack: 'U0A88GBQQQ0' },
  'c829da73-5d2a-4aae-8963-89a9219aa7e8': { name: 'Marc James Beauchamp', slack: 'U0A7T59MFCZ' },
  'ae002a76-0ba4-43b2-939f-7abddeddf190': { name: 'Pedro Cavagnari',      slack: 'U0A7HQWP3GU' },
  'd4456135-4bd4-488f-8e9d-a867e8c8697d': { name: 'Vanessa Fortune',      slack: 'U0A7T58H2MP' },
};

// Reoon statuses treated as undeliverable
const INVALID_STATUSES = ['invalid', 'spamtrap', 'abuse'];

// Deduplication cache — prevent repeat alerts for same booking
// Stores invitee URI → timestamp, expires after 24 hours
const processedBookings = new Map();
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEDUP_MAX_SIZE = 1000;

function isDuplicate(inviteeUri) {
  const now = Date.now();
  // Clean expired entries occasionally (when map gets large)
  if (processedBookings.size > DEDUP_MAX_SIZE) {
    for (const [uri, ts] of processedBookings) {
      if (now - ts > DEDUP_TTL_MS) processedBookings.delete(uri);
    }
  }
  // Check if we've seen this booking
  if (processedBookings.has(inviteeUri)) {
    const ts = processedBookings.get(inviteeUri);
    if (now - ts < DEDUP_TTL_MS) return true;
  }
  // Record this booking
  processedBookings.set(inviteeUri, now);
  return false;
}

// ── Email validation ──────────────────────────────────────────────────────────

async function verifyEmail(email) {
  const url = `https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(email)}&key=${REOON_API_KEY}&mode=quick`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Reoon API ${res.status}`);
  return res.json();
}

// ── Calendly ─────────────────────────────────────────────────────────────────

async function fetchCalendlyEvent(eventUri) {
  const uuid = eventUri.split('/').pop();
  const res = await fetch(`https://api.calendly.com/scheduled_events/${uuid}`, {
    headers: { 'Authorization': `Bearer ${CALENDLY_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Calendly event fetch ${res.status}`);
  return (await res.json()).resource;
}

// ── Apollo enrichment ─────────────────────────────────────────────────────────

async function enrichWithApollo(email) {
  if (!APOLLO_API_KEY) return null;
  try {
    const res = await fetch('https://api.apollo.io/api/v1/people/match', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': APOLLO_API_KEY,
      },
      body: JSON.stringify({
        email,
        reveal_phone_number: true,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const p = data?.person;
    if (!p || !p.id) return null;

    const org = p.organization || {};
    return {
      // Person
      firstName:    p.first_name || null,
      lastName:     p.last_name  || null,
      fullName:     p.name       || null,
      title:        p.title      || null,
      phone:        p.sanitized_phone || null,
      linkedin:     p.linkedin_url || null,
      city:         p.city        || null,
      state:        p.state       || null,
      country:      p.country     || null,
      // Company
      company:      p.organization_name || org.name || null,
      industry:     org.industry        || null,
      employeeCount: org.estimated_num_employees || null,
      website:      org.website_url     || null,
      companyCity:  org.city            || null,
      companyCountry: org.country       || null,
    };
  } catch (err) {
    console.warn('[Guard] Apollo enrichment failed:', err.message);
    return null;
  }
}

// ── Pipedrive ─────────────────────────────────────────────────────────────────

async function pdGet(path) {
  const res = await fetch(`${PIPEDRIVE_BASE}${path}?api_token=${PIPEDRIVE_API_KEY}`);
  if (!res.ok) throw new Error(`PD GET ${path} → ${res.status}`);
  return res.json();
}

async function pdPost(path, body) {
  const res = await fetch(`${PIPEDRIVE_BASE}${path}?api_token=${PIPEDRIVE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PD POST ${path} → ${res.status}`);
  return res.json();
}

async function pdPut(path, body) {
  const res = await fetch(`${PIPEDRIVE_BASE}${path}?api_token=${PIPEDRIVE_API_KEY}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PD PUT ${path} → ${res.status}`);
  return res.json();
}

async function updatePipedrive(email, bookingName, apollo) {
  if (!PIPEDRIVE_API_KEY) return null;

  try {
    // Search for person by email
    const searchRes = await pdGet(`/persons/search?term=${encodeURIComponent(email)}&fields=email&limit=1`);
    const existing = searchRes?.data?.items?.[0]?.item;
    let personId = existing?.id || null;

    // Build update payload — only fill fields Apollo found
    const updates = {};
    if (apollo?.phone && !existing?.phone?.[0]?.value) {
      updates.phone = [{ value: apollo.phone, primary: true, label: 'work' }];
    }
    if (apollo?.title)   updates.job_title = apollo.title;
    if (apollo?.company && !existing?.org_id) {
      // Try to find or create org
      try {
        const orgSearch = await pdGet(`/organizations/search?term=${encodeURIComponent(apollo.company)}&limit=1`);
        const orgMatch = orgSearch?.data?.items?.[0]?.item;
        if (orgMatch?.id) {
          updates.org_id = orgMatch.id;
        } else {
          const newOrg = await pdPost('/organizations', { name: apollo.company });
          if (newOrg?.data?.id) updates.org_id = newOrg.data.id;
        }
      } catch (e) { /* org lookup optional */ }
    }

    if (personId) {
      // Update existing person
      if (Object.keys(updates).length > 0) {
        await pdPut(`/persons/${personId}`, updates);
        console.log(`[Guard] Updated Pipedrive person ${personId}`);
      }
    } else {
      // Create new person
      const newPerson = await pdPost('/persons', {
        name: apollo?.fullName || bookingName,
        email: [{ value: email, primary: true }],
        ...updates,
      });
      personId = newPerson?.data?.id;
      console.log(`[Guard] Created Pipedrive person ${personId}`);
    }

    // Add enrichment note
    if (personId && apollo) {
      const noteLines = ['📋 *Lead enriched via Apollo.io on Calendly booking*', ''];
      if (apollo.title)         noteLines.push(`**Title:** ${apollo.title}`);
      if (apollo.company)       noteLines.push(`**Company:** ${apollo.company}`);
      if (apollo.industry)      noteLines.push(`**Industry:** ${apollo.industry}`);
      if (apollo.employeeCount) noteLines.push(`**Company size:** ~${apollo.employeeCount.toLocaleString()} employees`);
      if (apollo.website)       noteLines.push(`**Website:** ${apollo.website}`);
      if (apollo.phone)         noteLines.push(`**Phone:** ${apollo.phone}`);
      if (apollo.linkedin)      noteLines.push(`**LinkedIn:** ${apollo.linkedin}`);
      const location = [apollo.city, apollo.state, apollo.country].filter(Boolean).join(', ');
      if (location)             noteLines.push(`**Location:** ${location}`);

      await pdPost('/notes', {
        content: noteLines.join('\n'),
        person_id: personId,
      });
      console.log(`[Guard] Added enrichment note to person ${personId}`);
    }

    return personId;
  } catch (err) {
    console.error('[Guard] Pipedrive update failed:', err.message);
    return null;
  }
}

// ── Slack ─────────────────────────────────────────────────────────────────────

async function postSlackAlert({ ae, prospectName, prospectEmail, prospectPhone, meetingTime, eventTypeName, emailStatus }) {
  const aeMention = ae?.slack ? `<@${ae.slack}>` : ae?.name || 'Unknown AE';
  const phone = prospectPhone || '_not provided_';
  const time = meetingTime
    ? new Date(meetingTime).toLocaleString('en-US', {
        timeZone: 'America/Vancouver',
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
      })
    : '_unknown_';

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: SLACK_CHANNEL,
      text: `🚨 Bad email on a new booking — ${ae?.name || 'Unknown AE'}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🚨 *Bad email detected* — ${aeMention}, this meeting has an invalid email address. Reach out to them by phone or troubleshoot the email before the demo.`,
          },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Prospect:*\n${prospectName}` },
            { type: 'mrkdwn', text: `*Email (invalid):*\n${prospectEmail}` },
            { type: 'mrkdwn', text: `*Phone:*\n${phone}` },
            { type: 'mrkdwn', text: `*Demo time:*\n${time}` },
            { type: 'mrkdwn', text: `*Event type:*\n${eventTypeName}` },
            { type: 'mrkdwn', text: `*Email status:*\n\`${emailStatus}\`` },
          ],
        },
        {
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: `Validated by Reoon · Calendly Guard`,
          }],
        },
      ],
    }),
  });

  const data = await res.json();
  if (!data.ok) throw new Error(`Slack error: ${data.error}`);
  return data;
}

// ── Telegram notification ─────────────────────────────────────────────────────

async function notifyTelegram(text) {
  if (!TG_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' }),
    });
  } catch (err) {
    console.warn('[Guard] Telegram notify failed:', err.message);
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { event, payload } = req.body;

  // Only care about new bookings
  if (event !== 'invitee.created') {
    return res.status(200).json({ skipped: true, event });
  }

  const inviteeUri = payload?.uri;
  const email      = payload?.email;
  const name       = payload?.name || 'Unknown';
  const eventUri   = payload?.event;

  // Deduplication check
  if (inviteeUri && isDuplicate(inviteeUri)) {
    console.log(`[Guard] Duplicate booking skipped: ${inviteeUri}`);
    return res.status(200).json({ skipped: true, reason: 'duplicate' });
  }

  // Phone from custom question answers
  const questions = payload?.questions_and_answers || [];
  const phoneQ    = questions.find(q => q.question?.toLowerCase().includes('phone'));
  const phone     = phoneQ?.answer || null;

  if (!email || !eventUri) {
    console.error('[Guard] Missing email or event URI');
    return res.status(200).json({ skipped: true, reason: 'missing_fields' });
  }

  console.log(`[Guard] New booking: ${name} <${email}>`);

  // Fetch the scheduled event to get AE + start time + event type name
  let ae = null;
  let startTime = null;
  let eventTypeName = 'SalesCloser AI Demo';

  try {
    const scheduledEvent = await fetchCalendlyEvent(eventUri);
    startTime = scheduledEvent?.start_time;
    eventTypeName = scheduledEvent?.name || eventTypeName;

    for (const m of scheduledEvent?.event_memberships || []) {
      const uuid = (m?.user || '').split('/').pop();
      if (AE_MAP[uuid]) { ae = AE_MAP[uuid]; break; }
    }
  } catch (err) {
    console.warn('[Guard] Could not fetch Calendly event:', err.message);
  }

  console.log(`[Guard] AE: ${ae?.name || 'unknown'} | Time: ${startTime}`);

  // Not one of James's AEs — skip entirely
  if (!ae) {
    console.log(`[Guard] Host not on SalesCloser team — skipping`);
    return res.status(200).json({ action: 'skipped', reason: 'not_sc_team' });
  }

  // Validate the email
  let verification;
  try {
    verification = await verifyEmail(email);
  } catch (err) {
    console.error('[Guard] Reoon failed, failing open:', err.message);
    return res.status(200).json({ status: 'fail_open', error: err.message });
  }

  const { status, is_disposable } = verification;
  console.log(`[Guard] ${email} → ${status} | disposable: ${is_disposable}`);

  const isInvalid    = INVALID_STATUSES.includes(status);
  const isDisposable = is_disposable === true;

  // ── Invalid email path ──────────────────────────────────────────────────────
  if (isInvalid || isDisposable) {
    const emailStatus = isInvalid ? status : 'disposable';
    console.log(`[Guard] Firing Slack alert for ${email} (${emailStatus})`);

    try {
      await postSlackAlert({ ae, prospectName: name, prospectEmail: email, prospectPhone: phone, meetingTime: startTime, eventTypeName, emailStatus });
      console.log(`[Guard] Slack alert sent`);
    } catch (err) {
      console.error('[Guard] Slack post failed:', err.message);
      return res.status(200).json({ action: 'slack_failed', error: err.message });
    }

    return res.status(200).json({ action: 'alerted', email, emailStatus, ae: ae?.name });
  }

  // ── Valid email path — enrich + update Pipedrive ────────────────────────────
  console.log(`[Guard] ${email} is clean (${status}) — enriching with Apollo`);

  const apollo = await enrichWithApollo(email);
  if (apollo) {
    console.log(`[Guard] Apollo matched: ${apollo.fullName} @ ${apollo.company} | phone: ${apollo.phone || 'none'}`);
  } else {
    console.log(`[Guard] Apollo: no match found`);
  }

  const personId = await updatePipedrive(email, name, apollo);

  // Telegram confirmation on successful enrichment
  if (apollo && personId) {
    const pdLink = `https://wishpond.pipedrive.com/person/${personId}`;
    const lines = [
      `🧬 <b>Apollo enrichment fired</b>`,
      ``,
      `<b>Prospect:</b> ${apollo.fullName || name} &lt;${email}&gt;`,
      `<b>AE:</b> ${ae?.name || 'Unknown'}`,
    ];
    if (apollo.title)         lines.push(`<b>Title:</b> ${apollo.title}`);
    if (apollo.company)       lines.push(`<b>Company:</b> ${apollo.company}`);
    if (apollo.industry)      lines.push(`<b>Industry:</b> ${apollo.industry}`);
    if (apollo.employeeCount) lines.push(`<b>Size:</b> ~${apollo.employeeCount.toLocaleString()} employees`);
    if (apollo.phone)         lines.push(`<b>Phone:</b> ${apollo.phone}`);
    if (apollo.linkedin)      lines.push(`<b>LinkedIn:</b> ${apollo.linkedin}`);
    lines.push(``, `<a href="${pdLink}">View in Pipedrive →</a>`);
    await notifyTelegram(lines.join('\n'));
  }

  return res.status(200).json({
    action:    'clean',
    email,
    status,
    enriched:  !!apollo,
    apollo:    apollo ? { name: apollo.fullName, title: apollo.title, company: apollo.company, phone: apollo.phone } : null,
    pipedrivePersonId: personId,
  });
}
