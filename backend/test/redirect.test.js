// Tests for the affiliate-redirect security logic (routes/redirect.js).
// The domain whitelist is the whole defense against this becoming an open
// redirect (spec §14's explicit requirement) — worth testing directly, not
// just trusting the code by inspection.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedDestination, buildDestination, detectDeviceType } from '../src/routes/redirect.js';

describe('isAllowedDestination', () => {
  test('allows an exact whitelisted domain', () => {
    assert.equal(isAllowedDestination('https://www.ticketmaster.com/some-event'), true);
    assert.equal(isAllowedDestination('https://seatgeek.com/e/some-event'), true);
  });

  test('allows a subdomain of a whitelisted domain', () => {
    assert.equal(isAllowedDestination('https://ticketmaster.evyy.net/c/123'), true);
  });

  test('rejects a domain not on the whitelist', () => {
    assert.equal(isAllowedDestination('https://evil-phishing-site.com/tickets'), false);
  });

  test('rejects a lookalike domain (whitelisted name as a suffix trick)', () => {
    // e.g. "ticketmaster.com.evil.com" must NOT pass just because the
    // substring "ticketmaster.com" appears in the hostname.
    assert.equal(isAllowedDestination('https://ticketmaster.com.evil.com/tickets'), false);
  });

  test('rejects malformed URLs rather than throwing', () => {
    assert.equal(isAllowedDestination('not a url'), false);
    assert.equal(isAllowedDestination(''), false);
  });
});

describe('buildDestination', () => {
  test('wraps the seller URL in the affiliate template when one exists', () => {
    const dest = buildDestination('https://www.ticketmaster.com/event/123', 'https://ticketmaster.evyy.net/c/1?u={url}');
    assert.equal(dest, 'https://ticketmaster.evyy.net/c/1?u=' + encodeURIComponent('https://www.ticketmaster.com/event/123'));
  });

  test('returns the raw seller URL when there is no template', () => {
    const dest = buildDestination('https://seatgeek.com/e/123', null);
    assert.equal(dest, 'https://seatgeek.com/e/123');
  });

  test('returns null when there is no seller URL at all', () => {
    assert.equal(buildDestination(null, 'https://x.com/{url}'), null);
    assert.equal(buildDestination(undefined, null), null);
  });
});

describe('detectDeviceType', () => {
  test('detects mobile user agents', () => {
    assert.equal(detectDeviceType('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'mobile');
    assert.equal(detectDeviceType('Mozilla/5.0 (Linux; Android 13)'), 'mobile');
  });

  test('detects tablet user agents', () => {
    assert.equal(detectDeviceType('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'), 'tablet');
  });

  test('defaults to desktop', () => {
    assert.equal(detectDeviceType('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'desktop');
    assert.equal(detectDeviceType(''), 'desktop');
    assert.equal(detectDeviceType(undefined), 'desktop');
  });
});
