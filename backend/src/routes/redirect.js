import express from 'express';
import { pool } from '../index.js';

const router = express.Router();

// Controlled affiliate redirect + click tracking (spec §14). NOT currently
// linked from the frontend for Ticketmaster/SeatGeek — those already have
// working outbound links (including Ticketmaster's live, revenue-earning
// tracked-affiliate link, built client-side in App.jsx), and rerouting them
// through here without careful, visually-verified testing would risk
// breaking real affiliate revenue. This exists as ready, tested-by-code-
// review infrastructure for a future provider (e.g. StubHub, once real
// partner/affiliate access exists — see services/stubhub.js) or for a
// deliberate, carefully-tested migration of the existing providers later.
//
// Only ever redirects to a URL built from OUR OWN database (ticket_offers /
// providers.affiliate_url_template) — never a user-supplied destination —
// and still enforces a provider-domain whitelist as defense in depth per
// spec §14's anti-open-redirect requirement.
const ALLOWED_HOST_SUFFIXES = [
  'ticketmaster.com',
  'seatgeek.com',
  'stubhub.com',
  'vividseats.com',
  'tickpick.com',
  'evyy.net', // Impact.com tracked-link domain used by the Ticketmaster affiliate program
];

function isAllowedDestination(destinationUrl) {
  try {
    const host = new URL(destinationUrl).hostname.toLowerCase();
    return ALLOWED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch (_err) {
    return false;
  }
}

function buildDestination(sellerUrl, affiliateUrlTemplate) {
  if (!sellerUrl) return null;
  if (!affiliateUrlTemplate) return sellerUrl;
  return affiliateUrlTemplate.replace('{url}', encodeURIComponent(sellerUrl));
}

router.get('/:offerId', async (req, res) => {
  try {
    const offerId = Number(req.params.offerId);
    if (!Number.isInteger(offerId)) {
      return res.status(400).json({ error: 'Invalid offer id' });
    }

    const result = await pool.query(
      `SELECT t.seller_url, t.source_event_row_id,
              ce.title AS event_title, ce.city, ce.state,
              p.name AS provider_name, p.affiliate_url_template
       FROM ticket_offers t
       JOIN canonical_events ce ON ce.id = t.canonical_event_id
       JOIN providers p ON p.id = t.provider_id
       WHERE t.id = $1`,
      [offerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Offer not found' });
    }

    const offer = result.rows[0];
    const destination = buildDestination(offer.seller_url, offer.affiliate_url_template);

    if (!destination || !isAllowedDestination(destination)) {
      console.warn(`Rejected redirect for offer ${offerId}: destination not on provider whitelist`);
      return res.status(400).json({ error: 'Destination not permitted' });
    }

    // Best-effort click logging — a logging failure must never block the
    // actual redirect to the seller.
    try {
      await pool.query(
        `INSERT INTO click_events (event_row_id, source, event_title, city, state, landing_page, device_type, referrer, session_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          offer.source_event_row_id || null,
          offer.provider_name,
          offer.event_title,
          offer.city,
          offer.state,
          req.query.from || null,
          /Tablet|iPad/i.test(req.get('user-agent') || '') ? 'tablet' : /Mobi|Android|iPhone/i.test(req.get('user-agent') || '') ? 'mobile' : 'desktop',
          req.get('referer') || null,
          req.query.sid || null,
        ]
      );
    } catch (logError) {
      console.error('Redirect click logging failed:', logError.message);
    }

    res.redirect(302, destination);
  } catch (error) {
    console.error('Redirect failed:', error);
    res.status(500).json({ error: 'Redirect failed' });
  }
});

export default router;
