// Vercel Routing Middleware (framework-agnostic — this is a Vite/React SPA,
// not Next.js). Runs at Vercel's edge before any static file or rewrite is
// served.
//
// Why this exists instead of a vercel.json `has`-conditional rewrite: an
// earlier attempt used a vercel.json rewrite with a `has: [{type: "header",
// key: "user-agent", value: <bot regex>}]` condition pointing at the
// Railway `/prerender/event/:id` route. That was deployed and live-tested
// (via Google's own Rich Results Test tool, which crawls with a genuine
// Googlebot user agent) and confirmed NOT to trigger — the crawler still
// received the plain SPA shell (visible from `vite.svg`/`impact-site-
// verification` markers unique to index.html, absent from the prerender
// template). Vercel's own community reports corroborate that `has`-based
// conditional rewrites are unreliable. Routing Middleware is Vercel's
// documented, more reliable mechanism for exactly this "read a header,
// decide what to serve" use case, so this replaces that rewrite rule
// (see vercel.json — the bot-detection rewrite entry was removed there).
//
// Approach: read the User-Agent directly off the incoming request (no
// framework helpers needed), and for a request that (a) targets
// /event/:id-slug and (b) looks like a known bot/crawler/link-preview
// fetcher, proxy the response body from the backend's already-working
// /prerender/event/:id route (see backend/src/routes/prerender.js) instead
// of letting the request fall through to the SPA's index.html. Real users
// and JS-executing crawlers (Googlebot itself renders JS fine) are
// completely unaffected and never hit this branch's fetch.
// FIX (2026-08-30): every branch below that should "do nothing and let the
// normal SPA/rewrite handle this request" was doing `return;` (undefined).
// That looked like a harmless no-op, but Vercel's documented contract for
// Routing Middleware on non-Next.js ("other") projects is to return
// `next()` from the `@vercel/functions` package — every code sample in
// https://vercel.com/docs/routing-middleware/api for framework=other
// returns something (next()/rewrite()/a Response), and bare `return;` is
// never shown as a valid continuation. Since this middleware's matcher
// (`/event/:path*`) runs on every single event-detail-page request — not
// just bot ones — an undefined return here meant every real visitor
// hitting an event page got whatever Vercel's edge runtime does with an
// undefined middleware result instead of the SPA shell, breaking the event
// page (and therefore the outbound "Search on Ticketmaster/SeatGeek" links
// on it) for real humans. This shipped in commit 37084ad1 (2026-08-23),
// which lines up exactly with clicks/visits going to ~0 in Impact.com's
// dashboard starting that date. See @vercel/functions in package.json.
import { next } from '@vercel/functions';

const BOT_UA_REGEX = /bot|crawl|spider|facebookexternalhit|slackbot|twitterbot|linkedinbot|whatsapp|telegrambot|discordbot|applebot|pinterest|bingpreview|duckduckbot|yandexbot|redditbot|skypeuripreview|facebot|ia_archiver|embedly|quora link preview|vkshare|w3c_validator|whatsapp/i;

const PRERENDER_ORIGIN = 'https://concertandmatches-production.up.railway.app';

// /guide and /guide/:slug (see backend/src/routes/guides.js) are plain
// server-rendered content pages — a list of upcoming shows/prices for one
// artist+city, not an interactive comparison UI — so unlike /event/:id
// there's no SPA experience worth reserving for humans here. Proxying
// them straight through for EVERY request (not just recognized bots)
// keeps this one route in one place instead of duplicating the same
// content as a second React page, and guarantees crawlers and humans see
// byte-identical content (no dynamic-rendering divergence to worry about).
export const config = {
  matcher: ['/event/:path*', '/guide', '/guide/:path*'],
};

export default async function middleware(request) {
  const url = new URL(request.url);
  const userAgent = request.headers.get('user-agent') || '';

  const isGuidePath = url.pathname === '/guide' || url.pathname.startsWith('/guide/');
  if (isGuidePath) {
    return proxyTo(`${PRERENDER_ORIGIN}${url.pathname}`, userAgent);
  }

  if (!BOT_UA_REGEX.test(userAgent)) {
    return next(); // not a recognized bot — fall through to the normal SPA rewrite
  }

  // url.pathname looks like "/event/3048-shahin-najafi-erfan-anaheim"
  const pathParam = url.pathname.replace(/^\/event\//, '');
  return proxyTo(`${PRERENDER_ORIGIN}/prerender/event/${pathParam}`, userAgent);
}

async function proxyTo(upstreamUrl, userAgent) {
  try {
    const upstream = await fetch(upstreamUrl, { headers: { 'user-agent': userAgent } });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  } catch (err) {
    // If the backend is unreachable for any reason, don't break the page —
    // let the request fall through to the normal SPA instead of erroring.
    return next();
  }
}
