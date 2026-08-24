// Tests for the cross-source event-matching logic (utils/matching.js) —
// this is the core of the whole price-comparison feature: get it wrong and
// either two different concerts get shown as "offers" for one event
// (embarrassing, or worse, sends someone to buy the wrong tickets), or two
// listings of the SAME concert never get merged (comparison feature looks
// broken even though both sources have it).
//
// Run with: node --test backend/test (no external test framework — Node's
// built-in test runner, so no npm install is required to run these).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTokens, tokenSimilarity, isSameDay, isCloseInTime, isSameEvent } from '../src/utils/matching.js';

describe('normalizeTokens', () => {
  test('lowercases, strips punctuation, and drops stopwords', () => {
    // 'the', 'world', and 'tour' are all in STOPWORDS — only 'beyonce' survives.
    assert.deepEqual(normalizeTokens('The Beyoncé World Tour!'), ['beyonce']);
  });

  test('normalizes British/American venue spelling variants', () => {
    assert.deepEqual(normalizeTokens('Royal Theatre'), ['royal', 'theater']);
  });

  test('returns empty array for empty/null input', () => {
    assert.deepEqual(normalizeTokens(''), []);
    assert.deepEqual(normalizeTokens(null), []);
    assert.deepEqual(normalizeTokens(undefined), []);
  });
});

describe('tokenSimilarity', () => {
  test('identical strings score 1', () => {
    assert.equal(tokenSimilarity('Beyoncé', 'Beyoncé'), 1);
  });

  test('completely different strings score 0', () => {
    assert.equal(tokenSimilarity('Beyoncé', 'Chance The Rapper'), 0);
  });

  test('partial overlap scores between 0 and 1', () => {
    // 'World'/'Tour' are stopwords, so use a non-stopword extra word to get
    // genuine partial overlap instead of both sides collapsing to the same
    // single token.
    const score = tokenSimilarity('Beyoncé Renaissance Tour', 'Beyoncé');
    assert.ok(score > 0 && score < 1, `expected 0 < score < 1, got ${score}`);
  });
});

describe('isSameDay', () => {
  test('same UTC calendar day, different times, is a match', () => {
    assert.equal(isSameDay('2026-08-22T19:00:00Z', '2026-08-22T23:30:00Z'), true);
  });

  test('different days is not a match', () => {
    assert.equal(isSameDay('2026-08-22T19:00:00Z', '2026-08-23T19:00:00Z'), false);
  });

  test('invalid dates never match', () => {
    assert.equal(isSameDay('not-a-date', '2026-08-22T19:00:00Z'), false);
    assert.equal(isSameDay(null, '2026-08-22T19:00:00Z'), false);
  });
});

describe('isCloseInTime', () => {
  test('same instant is close', () => {
    assert.equal(isCloseInTime('2026-08-22T19:00:00Z', '2026-08-22T19:00:00Z'), true);
  });

  test('a couple hours apart (cross-source formatting slop) is close', () => {
    assert.equal(isCloseInTime('2026-08-22T19:00:00Z', '2026-08-22T21:30:00Z'), true);
  });

  test('a full day-vs-evening gap on the same calendar day is NOT close', () => {
    assert.equal(isCloseInTime('2026-08-22T13:00:00Z', '2026-08-22T23:00:00Z'), false);
  });

  test('null/invalid inputs are never close', () => {
    assert.equal(isCloseInTime(null, '2026-08-22T19:00:00Z'), false);
    assert.equal(isCloseInTime('not a date', '2026-08-22T19:00:00Z'), false);
  });
});

describe('isSameEvent', () => {
  const base = {
    source: 'ticketmaster',
    date: '2026-08-22T19:00:00Z',
    city: 'Denver',
    state: 'CO',
    venue_name: "Ophelia's Electric Soapbox",
    artist_name: 'Oh He Dead',
    title: 'An Evening With Oh He Dead',
  };

  test('same show from a different source, strong title match, merges', () => {
    const other = { ...base, source: 'seatgeek', title: 'Oh He Dead Live', venue_name: 'Ophelia Soapbox' };
    assert.equal(isSameEvent(base, other), true);
  });

  test('never merges two rows from the SAME source', () => {
    const other = { ...base };
    assert.equal(isSameEvent(base, other), false);
  });

  test('different city never merges, even with an identical title', () => {
    const other = { ...base, source: 'seatgeek', city: 'Austin' };
    assert.equal(isSameEvent(base, other), false);
  });

  test('different date never merges', () => {
    const other = { ...base, source: 'seatgeek', date: '2026-08-23T19:00:00Z' };
    assert.equal(isSameEvent(base, other), false);
  });

  // The regression this whole matching module exists to prevent (see the
  // comments in matching.js) — two different artists at the same big venue
  // on the same night must NOT be merged just because they share a venue.
  test('same venue + date but different artists does NOT merge (the Sphere/arena regression)', () => {
    const chanceTheRapper = { ...base, artist_name: 'Chance The Rapper', title: 'Chance The Rapper' };
    const jackHarlow = { ...base, source: 'seatgeek', artist_name: 'Jack Harlow', title: 'Jack Harlow' };
    assert.equal(isSameEvent(chanceTheRapper, jackHarlow), false);
  });

  test('null/undefined inputs never match', () => {
    assert.equal(isSameEvent(null, base), false);
    assert.equal(isSameEvent(base, undefined), false);
  });

  // Regression test for the bug reported live: sports games from
  // Ticketmaster and SeatGeek weren't merging into one comparison card.
  // Root cause — Ticketmaster's artist_name is always null (see
  // services/ticketmaster.js's storeEvent, no artist_name column in its
  // INSERT), so `a.artist_name || a.title` falls back to Ticketmaster's
  // title (the full matchup). SeatGeek's artist_name IS set, but to only
  // ONE team for a game — so the artist-preferring comparison ends up
  // matching a two-team title against a one-team name. Fixed by also
  // comparing title-to-title directly and taking the stronger score.
  test('sports game merges via title-to-title even though SeatGeek only has one team as artist_name', () => {
    const tm = {
      source: 'ticketmaster', date: '2026-11-02T20:00:00Z', city: 'Philadelphia', state: 'PA',
      venue_name: 'Wells Fargo Center', artist_name: null,
      title: 'Philadelphia 76ers vs. Boston Celtics',
    };
    const sg = {
      source: 'seatgeek', date: '2026-11-02T20:00:00Z', city: 'Philadelphia', state: 'PA',
      venue_name: 'Wells Fargo Center', artist_name: 'Philadelphia 76ers',
      title: 'Philadelphia 76ers vs. Boston Celtics',
    };
    assert.equal(isSameEvent(tm, sg), true);
  });

  // isSameDay alone (calendar day only) let two DIFFERENT games at the same
  // venue on the same date pass the venue-match branch's weak title floor —
  // e.g. a doubleheader's 1pm and 7pm games, both "Mets vs. Phillies" at
  // the same park. Requiring the times themselves to be close closes this.
  test('same-day doubleheader at the same venue does NOT merge (different games, same date)', () => {
    const game1 = {
      source: 'ticketmaster', date: '2026-07-04T17:00:00Z', city: 'Philadelphia', state: 'PA',
      venue_name: 'Citizens Bank Park', artist_name: null,
      title: 'New York Mets vs. Philadelphia Phillies',
    };
    const game2 = {
      source: 'seatgeek', date: '2026-07-04T23:30:00Z', city: 'Philadelphia', state: 'PA',
      venue_name: 'Citizens Bank Park', artist_name: 'New York Mets',
      title: 'New York Mets vs. Philadelphia Phillies',
    };
    assert.equal(isSameEvent(game1, game2), false);
  });

  test('sports game merges when one source abbreviates the city (LA vs Los Angeles)', () => {
    const tm = {
      source: 'ticketmaster', date: '2026-12-05T19:30:00Z', city: 'Los Angeles', state: 'CA',
      venue_name: 'Crypto.com Arena', artist_name: null,
      title: 'Los Angeles Lakers vs. Golden State Warriors',
    };
    const sg = {
      source: 'seatgeek', date: '2026-12-05T19:30:00Z', city: 'Los Angeles', state: 'CA',
      venue_name: 'Crypto.com Arena', artist_name: 'LA Lakers',
      title: 'LA Lakers vs. GS Warriors',
    };
    assert.equal(isSameEvent(tm, sg), true);
  });
});
