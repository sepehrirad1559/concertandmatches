// Minimal signed-session helper -- deliberately NOT the jsonwebtoken
// package, to avoid adding a new dependency for what's a simple HMAC-signed
// cookie value: {uid, exp} base64url-encoded, signed with HMAC-SHA256. Not
// a general JWT implementation (no alg negotiation, no third-party
// verification) -- this app only ever signs and verifies its own tokens,
// so that flexibility (and its associated attack surface, e.g. alg
// confusion) isn't needed.
import { createHmac, timingSafeEqual } from 'crypto';

function getSecret() {
  // SESSION_SECRET is the real name; JWT_SECRET is accepted too since an
  // earlier prototype's .env.example already documented that name (see
  // backend/.env.example) and reusing it means one less new env var for
  // whoever sets this up.
  const secret = process.env.SESSION_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('SESSION_SECRET (or JWT_SECRET) is not configured on the server');
  }
  return secret;
}

function sign(payloadB64) {
  return createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
}

export function createSessionToken(userId, { expiresInMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
  const payload = { uid: userId, exp: Date.now() + expiresInMs };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadB64}.${sign(payloadB64)}`;
}

// Returns the decoded { uid, exp } payload if the token is well-formed,
// correctly signed, and not expired -- null for anything else (missing,
// tampered, expired, or signed under a since-rotated secret).
export function verifySessionToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;

  let expectedSig;
  try {
    expectedSig = sign(payloadB64);
  } catch {
    return null; // secret not configured
  }
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.uid !== 'number' || typeof payload.exp !== 'number' || payload.exp < Date.now()) {
    return null;
  }
  return payload;
}

// Tiny hand-rolled cookie parser -- avoids adding the cookie-parser package
// for the one cookie this app actually reads.
export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((pair) => {
      const idx = pair.indexOf('=');
      if (idx === -1) return [pair.trim(), ''];
      return [pair.slice(0, idx).trim(), decodeURIComponent(pair.slice(idx + 1).trim())];
    }),
  );
}
