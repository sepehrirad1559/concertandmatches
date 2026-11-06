import express from 'express';
import { pool } from '../index.js';
import { requireAuth } from './auth.js';
import { mergeEventsAcrossSources } from './events.js';

const router = express.Router();

// Favorites, added 2026-11-06 alongside routes/auth.js -- every route here
// requires a logged-in user (requireAuth sets req.userId or responds 401
// itself). `event_row_id` stores the SAME `events.id` that the live site
// already uses as the canonical per-event identifier everywhere (event
// detail page URLs built as `/event/${e.id}-...}` in guides.js/seoPages.js,
// and `key={event.id}` on the homepage's EventCard list) -- not a
// `canonical_events` id -- so a favorited event is looked up the same way
// a homepage/search listing is: raw `events` rows merged live via
// mergeEventsAcrossSources, never a separately-cached copy that could show
// a stale price.
router.use(requireAuth);

router.get('/', async (req, res) => {
  const favRows = await pool.query(
    'SELECT event_row_id FROM favorites WHERE user_id = $1 ORDER BY created_at DESC',
    [req.userId],
  );
  const eventRowIds = favRows.rows.map((r) => r.event_row_id);
  if (eventRowIds.length === 0) {
    res.json({ events: [] });
    return;
  }
  const result = await pool.query('SELECT * FROM events WHERE id = ANY($1)', [eventRowIds]);
  const merged = mergeEventsAcrossSources(result.rows);
  // Preserve the user's most-recently-favorited-first order (the query
  // above doesn't guarantee row order matches eventRowIds) rather than
  // whatever order the merge happens to return.
  const order = new Map(eventRowIds.map((id, i) => [id, i]));
  merged.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
  res.json({ events: merged });
});

router.get('/ids', async (req, res) => {
  const result = await pool.query('SELECT event_row_id FROM favorites WHERE user_id = $1', [req.userId]);
  res.json({ eventRowIds: result.rows.map((r) => r.event_row_id) });
});

router.post('/:eventRowId', async (req, res) => {
  const eventRowId = Number(req.params.eventRowId);
  if (!Number.isInteger(eventRowId)) {
    res.status(400).json({ error: 'Invalid event id.' });
    return;
  }
  await pool.query(
    'INSERT INTO favorites (user_id, event_row_id) VALUES ($1, $2) ON CONFLICT (user_id, event_row_id) DO NOTHING',
    [req.userId, eventRowId],
  );
  res.status(201).json({ ok: true });
});

router.delete('/:eventRowId', async (req, res) => {
  const eventRowId = Number(req.params.eventRowId);
  if (!Number.isInteger(eventRowId)) {
    res.status(400).json({ error: 'Invalid event id.' });
    return;
  }
  await pool.query('DELETE FROM favorites WHERE user_id = $1 AND event_row_id = $2', [req.userId, eventRowId]);
  res.json({ ok: true });
});

export default router;
