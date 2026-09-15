// PERMANENT (unlike config/sourceVisibility.js, which is a temporary,
// revertible toggle): an event with no price at all from its source means
// there are simply no tickets left for sale there — showing it anyway
// (as "Price TBA") just wastes a visitor's click on something they can't
// buy. Every public listing/browse/search/discover query excludes rows
// where BOTH min_price and max_price are null.
//
// Deliberately does NOT apply to admin/diagnostic queries (backend/src/
// routes/admin.js) — those need to see the true, complete state of the
// data (including unpriced rows) to do their job.
export function appendPricedOnlyFilter(whereClause) {
  return `${whereClause} AND (min_price IS NOT NULL OR max_price IS NOT NULL)`;
}
