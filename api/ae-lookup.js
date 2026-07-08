/**
 * AE lookup endpoint — GET /api/ae-lookup?email=donavyn.m@salescloser.ai
 *
 * Looks up a SalesCloser AE by their email address. Returns their Calendly
 * UUID and Slack user ID so you can add them to config/aes.json.
 *
 * Flow:
 *  1. Query Calendly /users endpoint for the email
 *  2. Query Slack users.lookupByEmail for the Slack ID
 *  3. Return both + a ready-to-paste JSON block for config/aes.json
 */

const CALENDLY_TOKEN  = process.env.CALENDLY_TOKEN;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed — use GET' });
  }

  const email = req.query.email;
  if (!email) {
    return res.status(400).json({
      error: 'Missing email parameter',
      usage: 'GET /api/ae-lookup?email=donavyn.m@salescloser.ai',
    });
  }

  const result = {
    email,
    calendly: null,
    slack: null,
    configEntry: null,
    errors: [],
  };

  // ── Calendly lookup ──────────────────────────────────────────────
  if (!CALENDLY_TOKEN) {
    result.errors.push('CALENDLY_TOKEN not set');
  } else {
    try {
      // List all users in the organization and find by email
      const meRes = await fetch('https://api.calendly.com/users/me', {
        headers: { 'Authorization': `Bearer ${CALENDLY_TOKEN}` },
      });
      if (!meRes.ok) {
        result.errors.push(`Calendly /users/me failed: ${meRes.status}`);
      } else {
        const meData = await meRes.json();
        const organizationUri = meData?.resource?.current_organization;

        if (!organizationUri) {
          result.errors.push('Could not determine Calendly organization');
        } else {
          // List all organization members
          const membersRes = await fetch(
            `https://api.calendly.com/organization_memberships?organization=${encodeURIComponent(organizationUri)}`,
            { headers: { 'Authorization': `Bearer ${CALENDLY_TOKEN}` } },
          );
          if (!membersRes.ok) {
            result.errors.push(`Calendly members list failed: ${membersRes.status}`);
          } else {
            const membersData = await membersRes.json();
            const members = membersData.collection || [];

            // Paginate if needed
            let nextUri = membersData.pagination?.next_page;
            while (nextUri) {
              const nextRes = await fetch(nextUri, {
                headers: { 'Authorization': `Bearer ${CALENDLY_TOKEN}` },
              });
              if (!nextRes.ok) break;
              const nextData = await nextRes.json();
              members.push(...(nextData.collection || []));
              nextUri = nextData.pagination?.next_page;
            }

            // Find the member by email
            const emailLower = email.toLowerCase();
            const member = members.find(m => {
              const memberEmail = m?.user?.email;
              return memberEmail && memberEmail.toLowerCase() === emailLower;
            });

            if (member) {
              const uuid = member.user.uri.split('/').pop();
              result.calendly = {
                uuid,
                email: member.user.email,
                name: member.user.name,
                scheduling_url: member.user.scheduling_url,
              };
            } else {
              // List available emails for debugging
              const availableEmails = members.map(m => m?.user?.email).filter(Boolean);
              result.errors.push(`Email not found in Calendly organization. Available members: ${availableEmails.join(', ')}`);
            }
          }
        }
      }
    } catch (err) {
      result.errors.push(`Calendly lookup error: ${err.message}`);
    }
  }

  // ── Slack lookup ─────────────────────────────────────────────────
  if (!SLACK_BOT_TOKEN) {
    result.errors.push('SLACK_BOT_TOKEN not set');
  } else {
    try {
      const slackRes = await fetch(
        `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`,
        {
          headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` },
        },
      );
      const slackData = await slackRes.json();
      if (slackData.ok && slackData.user) {
        result.slack = {
          id: slackData.user.id,
          name: slackData.user.name,
          real_name: slackData.user.real_name,
        };
      } else {
        result.errors.push(`Slack lookup failed: ${slackData.error || 'user not found'}`);
      }
    } catch (err) {
      result.errors.push(`Slack lookup error: ${err.message}`);
    }
  }

  // ── Build config entry ───────────────────────────────────────────
  if (result.calendly?.uuid) {
    result.configEntry = {
      calendly_uuid: result.calendly.uuid,
      name: result.calendly.name || result.slack?.real_name || email,
      slack_id: result.slack?.id || 'ADD_SLACK_ID',
    };
  }

  res.status(200).json(result);
}
