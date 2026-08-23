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
import { normalizeTokens, tokenSimilarity, isSameDay, isSameEvent } from '../src/utils/matching.js';

describe('normalizeTokens', () => {
  test('lowercases, strips punctuation, and drops stopwords', () => {
    assert.deepEqual(normalizeTokens('The Beyoncé World Tour!'), ['beyonce', 'tour']);
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
    const score = tokenSimilarity('Beyoncé World Tour', 'Beyoncé');
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
});
