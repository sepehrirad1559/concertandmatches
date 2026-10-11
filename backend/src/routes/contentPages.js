import express from 'express';

const router = express.Router();

// Static informational pages (About / How It Works / FAQ / Contact) —
// server-rendered the same way as routes/seoPages.js and routes/guides.js
// (plain HTML, not the React SPA) so they're real, crawlable, indexable
// pages rather than client-only routes the SPA never actually handles.
// Before this file existed, App.jsx's footer already linked to
// /how-it-works, /faq, and /contact (see that file's "About" column), but
// none of those paths were mounted anywhere — backend, vercel.json rewrites,
// or the SPA's own routing — so every one of those links fell through
// vercel.json's catch-all `/(.*) -> /index.html` rewrite and just
// re-rendered the homepage under a different URL. This gives each of them
// a real page, plus FAQPage/AboutPage structured data where it applies.
//
// No live user/account/order data backs any of this (there's no backend
// for accounts, orders, or refunds in this codebase — see App.jsx's
// "Sign In"/"Sign Up" buttons, which just show a "coming soon" notice) —
// so the copy below sticks to what's actually true of the product: it's a
// price-comparison layer over multiple independent ticket marketplaces,
// not a seller, ticket holder, or payment processor itself. Anything about
// refunds/support is scoped to "contact the seller you bought from" rather
// than inventing a policy ConcertAndMatches doesn't have.

const SITE_ORIGIN = 'https://www.concertandmatches.com';
const SUPPORT_EMAIL = 'service@concertandmatches.com';

function xmlEscape(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Minimal shared page chrome — a real <header>/<footer> with links back
// into the main site (so these pages aren't crawl dead-ends either), plus
// the same meta/OG/Twitter/canonical pattern seoPages.js already uses.
// Deliberately NOT the full React SPA shell prerender.js merges into (that
// machinery exists specifically to preserve the live-price/buy-ticket UI
// on /event pages) — these are plain static content pages with nothing
// dynamic to hand off to, so there's no reason to carry that extra
// complexity and its failure modes here.
function pageShell({ title, description, path, h1, bodyHtml, jsonLd }) {
  const url = `${SITE_ORIGIN}${path}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${xmlEscape(title)}</title>
<meta name="description" content="${xmlEscape(description)}" />
<link rel="canonical" href="${xmlEscape(url)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="ConcertAndMatches" />
<meta property="og:title" content="${xmlEscape(title)}" />
<meta property="og:description" content="${xmlEscape(description)}" />
<meta property="og:url" content="${xmlEscape(url)}" />
<meta property="og:image" content="${SITE_ORIGIN}/og-image.png" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${xmlEscape(title)}" />
<meta name="twitter:description" content="${xmlEscape(description)}" />
<meta name="twitter:image" content="${SITE_ORIGIN}/og-image.png" />
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ''}
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; line-height: 1.6; color: #1a0733; }
  h1 { font-size: 28px; margin-bottom: 8px; }
  h2 { font-size: 20px; margin-top: 36px; }
  nav a, footer a { color: #6c3fc5; text-decoration: none; }
  nav a:hover, footer a:hover { text-decoration: underline; }
  details { margin: 14px 0; border: 1px solid #e3d9f5; border-radius: 10px; padding: 12px 16px; }
  details summary { font-weight: 700; cursor: pointer; }
  details p { margin: 10px 0 2px; }
  footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid #e3d9f5; font-size: 13.5px; color: #555; }
</style>
</head>
<body>
<nav aria-label="breadcrumb"><a href="/">ConcertAndMatches</a> &raquo; ${xmlEscape(h1)}</nav>
<h1>${xmlEscape(h1)}</h1>
${bodyHtml}
<footer>
<p><a href="/">Home</a> · <a href="/how-it-works">How It Works</a> · <a href="/faq">FAQ</a> · <a href="/contact">Contact Us</a></p>
</footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------
// About / How It Works
// ---------------------------------------------------------------------

function aboutBody() {
  return `
<p>ConcertAndMatches is a ticket price comparison site. We don't sell tickets ourselves — instead, we pull together listings for concerts, sports, theater, and comedy shows from multiple independent ticket marketplaces, and show them side by side so you can see which seller has the price, section, or seat you want before you buy.</p>

<h2>What we do</h2>
<p>Every event page on this site lists the sellers we found tickets on for that specific show, along with the price each one is currently showing. We refresh this listing data from our partner marketplaces on a regular sync schedule, so prices reflect what those sellers had listed as of the last sync — not a live, by-the-second quote. Always confirm the final price, fees, and seat location on the seller's own site before completing a purchase.</p>

<h2>What we don't do</h2>
<p>We're not a box office, a primary ticket seller, or a payment processor. When you click through to buy a ticket, you leave ConcertAndMatches and complete your purchase directly on the seller's website, under that seller's own terms, refund policy, and customer support. We may earn a referral commission when you buy through one of our links — that doesn't change the price you pay, and it doesn't influence which sellers we show for a given event.</p>

<h2>Why compare</h2>
<p>Ticket prices for the same show can vary a surprising amount between marketplaces, especially for in-demand events, because each seller sets its own pricing and fees independently. Comparing them in one place can save you from overpaying on the first listing you find.</p>

<p>Have a question we didn't answer here? Check our <a href="/faq">FAQ</a> or <a href="/contact">contact us</a>.</p>`;
}

router.get(['/about', '/how-it-works'], (req, res) => {
  const title = 'About ConcertAndMatches — How Our Ticket Price Comparison Works';
  const description = 'ConcertAndMatches compares concert, sports, theater, and comedy ticket prices across multiple marketplaces so you can find the best deal before you buy.';
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'AboutPage',
    name: title,
    description,
    url: `${SITE_ORIGIN}${req.path}`,
    publisher: { '@type': 'Organization', name: 'ConcertAndMatches', url: SITE_ORIGIN },
  };
  const html = pageShell({ title, description, path: req.path, h1: 'How ConcertAndMatches works', bodyHtml: aboutBody(), jsonLd });
  res.set('Content-Type', 'text/html').send(html);
});

// ---------------------------------------------------------------------
// FAQ
// ---------------------------------------------------------------------

// Kept as plain data (not just inline HTML) so the same list drives both
// the visible <details> accordion and the FAQPage JSON-LD below — one
// source of truth, so the structured data can never drift out of sync
// with what's actually on the page (a mismatch Google's rich-results
// guidelines explicitly warn against).
const FAQ_ITEMS = [
  {
    q: 'Does ConcertAndMatches sell tickets?',
    a: 'No. We compare ticket listings from multiple independent marketplaces for a given event. When you choose a seller and click through, you buy directly from that seller — ConcertAndMatches never takes your payment or holds your ticket.',
  },
  {
    q: 'Why do prices differ between sellers for the same event?',
    a: 'Each marketplace sources its own inventory and sets its own prices, fees, and seat maps independently, so the same show can show noticeably different totals from one seller to the next — especially for high-demand events. Comparing them side by side is the main reason this site exists.',
  },
  {
    q: 'Are the prices shown on ConcertAndMatches live?',
    a: "They reflect what each seller had listed as of our last data sync, which runs on a regular schedule rather than updating instantly with every seller change. Prices (and availability) can move between syncs, so always confirm the final price, fees, and seat location on the seller's own site before you complete a purchase.",
  },
  {
    q: 'Is it safe to buy tickets through the sellers listed here?',
    a: "We link to established, independent ticket marketplaces, but ConcertAndMatches isn't the one processing your payment or fulfilling your order — that happens entirely on the seller's site, under their own policies. Review a seller's refund, exchange, and delivery policy before buying if you're unsure.",
  },
  {
    q: 'What if an event is postponed, rescheduled, or cancelled?',
    a: 'Contact the seller you purchased from directly — they hold your order and their own policy determines whether you get a refund, an exchange for the new date, or another remedy. ConcertAndMatches has no record of your purchase and can\'t process refunds or exchanges.',
  },
  {
    q: 'Does ConcertAndMatches charge me anything?',
    a: 'No — browsing and comparing prices on ConcertAndMatches is free. We may earn a referral commission from the seller when you buy through one of our links; this comes from the seller, not from you, and does not change the price you pay or which sellers we show.',
  },
  {
    q: 'Why can\'t I find a specific event?',
    a: "We only list events we found live inventory for from our marketplace partners, so a show that just went on sale, sold out everywhere, or isn't carried by any of our partners won't appear yet. Try checking back later, or search directly on the artist's, team's, or venue's own site.",
  },
  {
    q: 'How do I contact ConcertAndMatches?',
    a: `Email us at ${SUPPORT_EMAIL}. For questions about an order you already placed — refunds, delivery, seat changes — contact the seller you bought from first, since they're the ones holding that order.`,
  },
];

function faqBody() {
  const items = FAQ_ITEMS.map((item) => `<details>
<summary>${xmlEscape(item.q)}</summary>
<p>${xmlEscape(item.a)}</p>
</details>`).join('\n');
  return `<p>Answers to the questions we hear most about comparing and buying tickets through ConcertAndMatches.</p>
${items}
<p>Still stuck? <a href="/contact">Contact us</a> and we'll help if we can.</p>`;
}

router.get('/faq', (req, res) => {
  const title = 'Frequently Asked Questions | ConcertAndMatches';
  const description = 'Answers to common questions about how ConcertAndMatches compares ticket prices, whether prices are live, refunds, and how to contact us.';
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ_ITEMS.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };
  const html = pageShell({ title, description, path: '/faq', h1: 'Frequently asked questions', bodyHtml: faqBody(), jsonLd });
  res.set('Content-Type', 'text/html').send(html);
});

// ---------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------

function contactBody() {
  return `
<p>The fastest way to reach us is email: <a href="mailto:${xmlEscape(SUPPORT_EMAIL)}">${xmlEscape(SUPPORT_EMAIL)}</a>.</p>

<h2>Before you write in</h2>
<p>If your question is about an order you already placed — a refund, an exchange, a delivery problem, or a seat change — that order was placed directly with the seller's marketplace, not with ConcertAndMatches, and they're the ones who can actually act on it. Contacting them first is usually faster than routing through us.</p>

<h2>What we can help with</h2>
<p>Questions about how the site works, a listing that looks wrong or outdated, an event you think is missing, or general feedback — email us at <a href="mailto:${xmlEscape(SUPPORT_EMAIL)}">${xmlEscape(SUPPORT_EMAIL)}</a> and include the event name or page link if it's about something specific.</p>

<p>See also our <a href="/faq">FAQ</a> for answers to the questions we're asked most.</p>`;
}

router.get('/contact', (req, res) => {
  const title = 'Contact Us | ConcertAndMatches';
  const description = 'Get in touch with ConcertAndMatches — questions about how the site works, a listing issue, or feedback.';
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ContactPage',
    name: title,
    url: `${SITE_ORIGIN}/contact`,
  };
  const html = pageShell({ title, description, path: '/contact', h1: 'Contact us', bodyHtml: contactBody(), jsonLd });
  res.set('Content-Type', 'text/html').send(html);
});

export default router;
