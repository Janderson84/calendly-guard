/**
 * Duplicate booking detection via Calendly API.
 *
 * Queries upcoming scheduled events for an organization and checks if the
 * same invitee email has other upcoming bookings.
 */

const CALENDLY_TOKEN = process.env.CALENDLY_TOKEN;

/**
 * Fetch all upcoming events for the organization, then check which ones
 * have the given invitee email.
 *
 * @param {string} inviteeEmail - the email to check
 * @param {string} eventUri - the current event URI (to exclude it)
 * @param {string} organizationUri - the Calendly organization URI
 * @returns {Promise<{count: number, events: Array}>}
 */
export async function checkDuplicateBookings(inviteeEmail, currentEventUri, organizationUri) {
  if (!CALENDLY_TOKEN || !organizationUri) {
    return { count: 0, events: [], error: 'missing_config' };
  }

  try {
    // Get upcoming events for the organization (next 30 days)
    const now = new Date();
    const maxTime = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const params = new URLSearchParams({
      organization: organizationUri,
      status: 'active',
      min_start_time: now.toISOString(),
      max_start_time: maxTime.toISOString(),
    });

    // Paginate through all events
    let allEvents = [];
    let nextUri = `https://api.calendly.com/scheduled_events?${params.toString()}`;

    while (nextUri) {
      const res = await fetch(nextUri, {
        headers: { 'Authorization': `Bearer ${CALENDLY_TOKEN}` },
      });
      if (!res.ok) {
        console.warn(`[Investigate] Calendly events fetch failed: ${res.status}`);
        break;
      }
      const data = await res.json();
      allEvents = allEvents.concat(data.collection || []);
      nextUri = data.pagination?.next_page || null;
    }

    // For each event, fetch invitees and check for matching email.
    // We filter client-side because invitee_email param is unreliable.
    const duplicates = [];
    const emailLower = inviteeEmail.toLowerCase();

    for (const evt of allEvents) {
      // Skip the current event
      if (evt.uri === currentEventUri) continue;

      // Fetch invitees for this event
      try {
        const eventUuid = evt.uri.split('/').pop();
        const invRes = await fetch(`https://api.calendly.com/scheduled_events/${eventUuid}/invitees`, {
          headers: { 'Authorization': `Bearer ${CALENDLY_TOKEN}` },
        });
        if (!invRes.ok) continue;
        const invData = await invRes.json();
        const invitees = invData.collection || [];

        for (const inv of invitees) {
          if ((inv.email || '').toLowerCase() === emailLower) {
            duplicates.push({
              eventUri: evt.uri,
              startTime: evt.start_time,
              eventName: evt.name,
              inviteeUri: inv.uri,
            });
            break;
          }
        }
      } catch (e) {
        // Individual event invitee fetch failures are non-fatal
      }
    }

    return { count: duplicates.length, events: duplicates };
  } catch (err) {
    console.warn('[Investigate] Duplicate check failed:', err.message);
    return { count: 0, events: [], error: err.message };
  }
}
