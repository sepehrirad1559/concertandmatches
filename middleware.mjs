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

// 2026-09-17: verified live with Google's own Rich Results Test tool
// against this exact regex — the tool (and Search Console's URL Inspection)
// fetches as "Google-InspectionTool", which does NOT contain the substring
// "bot", so it was silently falling through to the plain SPA shell despite
// the /bot/i check below, making it impossible to verify this fix with
// Google's own testing tools. Google documents its full crawler/fetcher
// token list at https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers
// — added those tokens explicitly (inspectiontool, googleother, storebot,
// google-extended) rather than relying solely on the generic /bot/i catch-
// all. This is not cloaking risk: every one of these fetchers is Google's
// own, and per Google's own guidance dynamic rendering should serve them
// the SAME content a JS-executing Googlebot would eventually construct.
const BOT_UA_REGEX = /bot|crawl|spider|inspectiontool|facebookexternalhit|slackbot|twitterbot|linkedinbot|whatsapp|telegrambot|discordbot|applebot|pinterest|bingpreview|duckduckbot|yandexbot|redditbot|skypeuripreview|facebot|ia_archiver|embedly|quora link preview|vkshare|w3c_validator/i;

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
    // /event/:path* intentionally removed 2026-10-09: event pages are now
    // served via an unconditional vercel.json rewrite straight to
    // backend/src/routes/prerender.js (see that file's header comment for
    // why — this middleware's bot-branch below had three separate, hard-
    // to-diagnose production incidents on this exact path over the past
    // few weeks: UA strings it didn't recognize, a silent fetch failure
    // indistinguishable from "not a bot" on this Vercel plan, and CDN cache
    // poisoning serving one visitor's response to every later visitor
    // regardless of User-Agent). Leaving the bot-detection code below in
    // place (now unreachable — matcher controls what this file even
    // receives) rather than deleting it, in case event-specific UA
    // branching is ever needed again; it just no longer fires.
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
    // Safe to let the CDN cache these — every visitor (bot or not) gets the
    // same byte-identical response (see PLAIN_CONTENT_PREFIXES' comment
    // above), so there's no UA-dependent content for a cache hit to serve
    // to the wrong audience the way there is for /event/:id below.
    return proxyTo(`${PRERENDER_ORIGIN}${url.pathname}${url.search}`, userAgent, { cacheable: true });
  }

  if (!BOT_UA_REGEX.test(userAgent)) {
    return next(); // not a recognized bot — fall through to the normal SPA rewrite
  }

  // url.pathname looks like "/event/3048-shahin-najafi-erfan-anaheim". This
  // branch's response genuinely differs by User-Agent (bot vs. not), so it
  // must never be cached — see proxyTo's cache-control comment below.
  const pathParam = url.pathname.replace(/^\/event\//, '');
  return proxyTo(`${PRERENDER_ORIGIN}/prerender/event/${pathParam}`, userAgent, { cacheable: false });
}

// 2026-10-08: Search Console's "Test Live URL" was repeatedly showing
// Googlebot getting the plain SPA shell (homepage title/og:url) instead of
// this per-event prerendered HTML, for event pages that should match the bot
// branch above — confirmed NOT a UA-matching problem (the backend's own
// /prerender/event/:id endpoint answers correctly and fast when called
// directly) and traced to this proxy's silent catch-and-fall-through: this
// project's Vercel plan doesn't expose historical Edge Middleware logs, so a
// failed/timed-out fetch here was indistinguishable from "not a bot" with no
// way to tell which from outside the Vercel dashboard. That silent failure
// is the direct, confirmed cause of thousands of event pages showing up in
// GSC as "Soft 404" and "Duplicate, Google chose different canonical than
// user" (Search Console: 1,726 + 563 pages respectively, as of this date).
//
// Two changes to make that failure diagnosable without needing Vercel's own
// (plan-gated) logs:
//   1. An explicit timeout via AbortController. The fetch below previously
//      had none, so a slow/hanging origin response would ride all the way
//      out to Vercel's own hard Edge Function execution limit before this
//      caught anything — worse for a bot waiting on a response than failing
//      fast and falling back.
//   2. x-prerender-proxy response header: "ok" on success, "fallback:<reason>"
//      on failure. Google Search Console's own URL Inspection > Test Live
//      URL > Page Availability panel reports the response headers it
//      received, so this can be checked straight from GSC — no Vercel log
//      access, no ability to spoof a bot User-Agent, and no waiting on an
//      actual Google recrawl required to tell which failure mode this is.
async function proxyTo(upstreamUrl, userAgent, { cacheable } = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const upstream = await fetch(upstreamUrl, {
      headers: { 'user-agent': userAgent },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const body = await upstream.text();
    // Pass through the backend's real content-type (routes/sitemap.js sends
    // application/xml; every HTML page sends text/html) instead of
    // hardcoding text/html, which would otherwise mislabel the sitemap.
    const contentType = upstream.headers.get('content-type') || 'text/html; charset=utf-8';
    const headers = { 'content-type': contentType, 'x-prerender-proxy': 'ok' };
    // 2026-10-08: found WHY the x-prerender-proxy header above never showed
    // up in Search Console's live test at all, bot-match or not — Vercel's
    // edge CDN was serving a cached response for this exact /event/:id path
    // (confirmed: X-Vercel-Cache: HIT, Etag match, Content-Disposition:
    // inline; filename="index.html" — the plain SPA shell, not this
    // proxy's output) WITHOUT re-invoking this middleware at all. Whichever
    // response got cached first for a given path — almost certainly a real
    // visitor's non-bot next() → static index.html — was then served to
    // every later request for that same path regardless of User-Agent,
    // including Googlebot's. Explicit no-store on the UA-dependent /event
    // branch (see the `cacheable` call sites above, and the matching
    // vercel.json headers rule for the non-bot/static fallback path) stops
    // the CDN from caching that branch's output, so every request actually
    // re-runs this middleware's UA check instead of replaying whatever the
    // first visitor happened to get. The plain-content branch (/guide,
    // /artists, etc.) is deliberately left cacheable — its response is
    // identical for every User-Agent, so there's no wrong-audience risk and
    // caching it reduces load on the Railway origin as intended.
    if (!cacheable) {
      headers['cache-control'] = 'private, no-store, must-revalidate';
    }
    return new Response(body, {
      status: upstream.status,
      headers,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const reason = err?.name === 'AbortError' ? 'timeout' : (err?.message || 'unknown-error');
    console.error(`[middleware] prerender proxy failed (${reason}) for ${upstreamUrl}`);
    // If the backend is unreachable for any reason, don't break the page —
    // let the request fall through to the normal SPA instead of erroring.
    // (Deliberately still next() rather than a hand-built Response here: a
    // bare `return;` instead of next() previously broke this middleware for
    // every real visitor — commit 37084ad1, 2026-08-23 — and reconstructing
    // the fallback ourselves would mean re-fetching this same URL, which
    // would re-enter this same middleware and risk a request loop. next()
    // is the only change-nothing-about-risk option here; the x-prerender-
    // proxy header above is what makes the failure visible instead.)
    return next();
  }
}
