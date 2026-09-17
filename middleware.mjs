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
// IMPORTANT — this file's location matters: this Vercel project's Root
// Directory is the repo root (Build and Deployment settings override the
// build/output commands to `cd frontend && npm install && npm run build`
// / `frontend/dist` — there's no "Root Directory" set to "frontend"), so
// Vercel Routing Middleware is only picked up from a `middleware.mjs`/`.js`
// file at THIS location, the true project root. A near-duplicate copy at
// frontend/middleware.js is NOT deployed and must not be treated as the
// live version — confirmed 2026-09-16 via this project's actual Build and
// Deployment settings screen after an earlier attempt to "consolidate" got
// this backwards and briefly shipped the wrong copy.
//
// Approach: read the User-Agent directly off the incoming request (no
// framework helpers needed), and for a request that (a) targets
// /event/:id-slug and (b) looks like a known bot/crawler/link-preview
// fetcher, proxy the response body from the backend's already-working
// /prerender/event/:id route (see backend/src/routes/prerender.js) instead
// of letting the request fall through to the SPA's index.html. Real users
// and JS-executing crawlers (Googlebot itself renders JS fine) are
// completely unaffected and never hit this branch's fetch.
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
