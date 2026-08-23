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
const BOT_UA_REGEX = /bot|crawl|spider|facebookexternalhit|slackbot|twitterbot|linkedinbot|whatsapp|telegrambot|discordbot|applebot|pinterest|bingpreview|duckduckbot|yandexbot|redditbot|skypeuripreview|facebot|ia_archiver|embedly|quora link preview|vkshare|w3c_validator|whatsapp/i;

const PRERENDER_ORIGIN = 'https://concertandmatches-production.up.railway.app';

export const config = {
  matcher: '/event/:path*',
};

export default async function middleware(request) {
  const userAgent = request.headers.get('user-agent') || '';
  if (!BOT_UA_REGEX.test(userAgent)) {
    return; // not a recognized bot — fall through to the normal SPA rewrite
  }

  const url = new URL(request.url);
  // url.pathname looks like "/event/3048-shahin-najafi-erfan-anaheim"
  const pathParam = url.pathname.replace(/^\/event\//, '');

  try {
    const upstream = await fetch(`${PRERENDER_ORIGIN}/prerender/event/${pathParam}`, {
      headers: { 'user-agent': userAgent },
    });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  } catch (err) {
    // If the backend is unreachable for any reason, don't break the page —
    // let the request fall through to the normal SPA instead of erroring.
    return;
  }
}
