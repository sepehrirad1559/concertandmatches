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
// decide what to serve" use case, so this replaces that rewrite rule.
//
// 2026-09-16 consolidation: this logic previously existed in TWO diverging
// copies — this file (frontend/middleware.js) and a newer, more complete
// one at the repo ROOT (middleware.mjs). Vercel Routing Middleware is only
// picked up from the Project Root Directory it's configured to build —
// this project has no root-level package.json/vite config, only
// frontend/package.json + frontend's own vite/vercel config, which means
// Vercel's Root Directory is "frontend" and this file
// (frontend/middleware.js) is the one that actually ships. The root-level
// middleware.mjs was therefore dead code — every improvement made there
// (the fuller PLAIN_CONTENT_PREFIXES list, real content-type passthrough
// for /sitemap.xml) never reached production. This file now carries that
// merged, corrected logic, and the stray root copy has been removed so
// there's a single source of truth. This is the most likely root cause of
// event pages still showing the homepage's title/canonical/og:url to
// Googlebot (Search Console: "Duplicate, Google chose different canonical
// than user") — see backend/src/routes/prerender.js for the per-event HTML
// this now actually serves to bots.
//
// Approach: read the User-Agent directly off the incoming request (no
// framework helpers needed), and for a request that (a) targets
// /event/:id-slug and (b) looks like a known bot/crawler/link-preview
// fetcher, proxy the response body from the backend's already-working
// /prerender/event/:id route (see backend/src/routes/prerender.js) instead
// of letting the request fall through to the SPA's index.html. Real users
// and JS-executing crawlers (Googlebot itself renders JS fine, but Search
// Console showed it was NOT reliably doing so for this canonical/title) are
// unaffected for the interactive SPA experience — they still get index.html
// for /event/:id when their UA doesn't match the bot list.
//
// IMPORTANT: every branch that should "do nothing and let the normal SPA/
// rewrite handle this request" must return `next()` from `@vercel/functions`
// — NOT a bare `return;` (undefined). A bare `return;` previously shipped
// (commit 37084ad1, 2026-08-23) and broke this middleware's matcher
// (`/event/:path*`, which runs on every single event-detail-page request,
// not just bot ones) for real human visitors, since Vercel's edge runtime
// does not treat `undefined` as "continue normally". Every code sample in
// https://vercel.com/docs/routing-middleware/api for framework=other
// returns something (next()/rewrite()/a Response) — keep it that way.
import { next } from '@vercel/functions';

const BOT_UA_REGEX = /bot|crawl|spider|facebookexternalhit|slackbot|twitterbot|linkedinbot|whatsapp|telegrambot|discordbot|applebot|pinterest|bingpreview|duckduckbot|yandexbot|redditbot|skypeuripreview|facebot|ia_archiver|embedly|quora link preview|vkshare|w3c_validator/i;

const PRERENDER_ORIGIN = 'https://concertandmatches-production.up.railway.app';

// /guide, /sitemap.xml, and the programmatic SEO pages (routes/seoPages.js:
// /artists, /cities, /venues, /leagues, /teams) are all plain
// server-rendered content pages — not an interactive comparison UI — so
// unlike /event/:id there's no SPA experience worth reserving for humans
// here. Proxying them straight through for EVERY request (not just
// recognized bots) keeps this one route in one place, and guarantees
// crawlers and humans see byte-identical content (no dynamic-rendering
// divergence to worry about). vercel.json also has direct rewrites for most
// of these paths; handling them here too is redundant but harmless — this
// middleware runs before rewrites either way — and keeps all "proxy to the
// backend" logic in one place instead of split across two config systems.
const PLAIN_CONTENT_PREFIXES = ['/guide', '/sitemap.xml', '/artists', '/cities', '/venues', '/leagues', '/teams'];

export const config = {
  matcher: [
    '/event/:path*',
    '/guide',
    '/guide/:path*',
    '/sitemap.xml',
    '/artists',
    '/artists/:path*',
    '/cities',
    '/cities/:path*',
    '/venues',
    '/venues/:path*',
    '/leagues',
    '/leagues/:path*',
    '/teams',
    '/teams/:path*',
  ],
};

export default async function middleware(request) {
  const url = new URL(request.url);
  const userAgent = request.headers.get('user-agent') || '';

  const isPlainContentPath = PLAIN_CONTENT_PREFIXES.some(
    (p) => url.pathname === p || url.pathname.startsWith(`${p}/`)
  );
  if (isPlainContentPath) {
    return proxyTo(`${PRERENDER_ORIGIN}${url.pathname}${url.search}`, userAgent);
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
    // Pass through the backend's real content-type (routes/sitemap.js sends
    // application/xml; every HTML page sends text/html) instead of
    // hardcoding text/html, which would otherwise mislabel the sitemap.
    const contentType = upstream.headers.get('content-type') || 'text/html; charset=utf-8';
    return new Response(body, {
      status: upstream.status,
      headers: { 'content-type': contentType },
    });
  } catch (err) {
    // If the backend is unreachable for any reason, don't break the page —
    // let the request fall through to the normal SPA instead of erroring.
    return next();
  }
}
