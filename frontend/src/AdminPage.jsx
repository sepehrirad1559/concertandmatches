import React, { useState, useEffect, useCallback } from 'react';

// Same-origin admin dashboard, served as part of the main React app at
// /admin so it's exempt from the backend's CORS allowedOrigins restriction
// (see backend/src/index.js) — a separately-hosted admin page (e.g. a
// standalone static site or a published artifact) would be blocked from
// calling the API entirely.
//
// Auth: there is no separate admin user/session system in this backend —
// every /api/admin/* route is gated by a single shared secret compared
// against the `x-sync-key` header (see requireAdminAccess in
// backend/src/routes/admin.js). This page asks for that key at runtime,
// keeps it only in memory + sessionStorage (cleared when the tab closes),
// and never ships it in source. It is not a real multi-user login system —
// it's a shared-secret gate, same as the sync/backfill endpoints already
// use.
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:30001/api';
const SESSION_KEY = 'cam_admin_key';

function authedFetch(path, key) {
  return fetch(`${API_URL}/admin${path}`, {
    headers: { 'x-sync-key': key },
  }).then(async (res) => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 200) {
      throw new Error(body?.error || `Request failed (${res.status})`);
    }
    return body;
  });
}

function Card({ label, value, sub }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #e5e5e5', borderRadius: 10,
      padding: '16px 18px', minWidth: 150,
    }}>
      <div style={{ fontSize: 12, color: '#888', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, marginTop: 4 }}>{value}</div>
      {sub ? <div style={{ fontSize: 12, color: '#999', marginTop: 2 }}>{sub}</div> : null}
    </div>
  );
}

function Section({ title, note, children }) {
  return (
    <div style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: note ? 2 : 10 }}>{title}</h2>
      {note ? <p style={{ fontSize: 12, color: '#999', margin: '0 0 10px' }}>{note}</p> : null}
      {children}
    </div>
  );
}

function SimpleTable({ columns, rows, emptyText = 'No data' }) {
  if (!rows || rows.length === 0) {
    return <p style={{ fontSize: 13, color: '#999' }}>{emptyText}</p>;
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={{
                textAlign: 'left', padding: '6px 10px', borderBottom: '2px solid #eee',
                color: '#666', fontWeight: 600, whiteSpace: 'nowrap',
              }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #f2f2f2' }}>
              {columns.map((c) => (
                <td key={c.key} style={{ padding: '6px 10px', whiteSpace: c.wrap ? 'normal' : 'nowrap' }}>
                  {c.render ? c.render(row) : (row[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BarRow({ label, count, max }) {
  const pct = max > 0 ? Math.max(2, Math.round((count / max) * 100)) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
      <div style={{ width: 90, fontSize: 12, color: '#666', flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1, background: '#f2f2f2', borderRadius: 4, height: 16, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, background: '#4f46e5', height: '100%' }} />
      </div>
      <div style={{ width: 46, fontSize: 12, textAlign: 'right', color: '#333' }}>{count}</div>
    </div>
  );
}

export default function AdminPage() {
  const [key, setKey] = useState(() => {
    try { return sessionStorage.getItem(SESSION_KEY) || ''; } catch { return ''; }
  });
  const [keyInput, setKeyInput] = useState('');
  const [authError, setAuthError] = useState('');
  const [checking, setChecking] = useState(false);

  const [stats, setStats] = useState(null);
  const [health, setHealth] = useState(null);
  const [clicks, setClicks] = useState(null);
  const [clickDetail, setClickDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [lastLoaded, setLastLoaded] = useState(null);

  const loadAll = useCallback((activeKey) => {
    setLoading(true);
    setLoadError('');
    Promise.all([
      authedFetch('/stats', activeKey),
      authedFetch('/health', activeKey),
      authedFetch('/analytics/clicks', activeKey),
      authedFetch('/analytics/click-detail', activeKey),
    ])
      .then(([s, h, c, cd]) => {
        setStats(s);
        setHealth(h);
        setClicks(c);
        setClickDetail(cd);
        setLastLoaded(new Date());
      })
      .catch((err) => setLoadError(err.message || 'Failed to load admin data'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (key) loadAll(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleUnlock = (e) => {
    e.preventDefault();
    if (!keyInput.trim()) return;
    setChecking(true);
    setAuthError('');
    authedFetch('/health', keyInput.trim())
      .then(() => {
        setKey(keyInput.trim());
        try { sessionStorage.setItem(SESSION_KEY, keyInput.trim()); } catch { /* ignore */ }
        loadAll(keyInput.trim());
      })
      .catch((err) => setAuthError(err.message || 'Invalid key'))
      .finally(() => setChecking(false));
  };

  const handleLogout = () => {
    setKey('');
    setKeyInput('');
    setStats(null);
    setHealth(null);
    setClicks(null);
    setClickDetail(null);
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  };

  const pageStyle = {
    minHeight: '100vh', background: '#f7f7f8', color: '#1a1a1a',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  };

  if (!key) {
    return (
      <div style={{ ...pageStyle, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <form onSubmit={handleUnlock} style={{
          background: '#fff', border: '1px solid #e5e5e5', borderRadius: 12,
          padding: 32, width: 320, boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
        }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>ConcertAndMatches Admin</h1>
          <p style={{ fontSize: 13, color: '#888', marginBottom: 18 }}>
            Enter the admin key to view stats, sync health, and click analytics.
          </p>
          <input
            type="password"
            autoFocus
            placeholder="Admin key"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            style={{
              width: '100%', padding: '10px 12px', fontSize: 14, borderRadius: 8,
              border: '1px solid #ddd', boxSizing: 'border-box', marginBottom: 12,
            }}
          />
          {authError ? (
            <div style={{ fontSize: 13, color: '#c0392b', marginBottom: 12 }}>{authError}</div>
          ) : null}
          <button
            type="submit"
            disabled={checking}
            style={{
              width: '100%', padding: '10px 12px', fontSize: 14, fontWeight: 600,
              borderRadius: 8, border: 'none', background: '#1a1a1a', color: '#fff',
              cursor: checking ? 'default' : 'pointer', opacity: checking ? 0.6 : 1,
            }}
          >
            {checking ? 'Checking…' : 'Unlock'}
          </button>
        </form>
      </div>
    );
  }

  const maxSourceClicks = clicks?.clicksBySource?.length
    ? Math.max(...clicks.clicksBySource.map((r) => r.count)) : 0;
  const maxDayClicks = clicks?.clicksByDay?.length
    ? Math.max(...clicks.clicksByDay.map((r) => r.count)) : 0;

  return (
    <div style={pageStyle}>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '28px 20px 60px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Admin Dashboard</h1>
            <p style={{ fontSize: 13, color: '#888', margin: '4px 0 0' }}>
              {lastLoaded ? `Last loaded ${lastLoaded.toLocaleTimeString()}` : ''}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => loadAll(key)}
              disabled={loading}
              style={{
                padding: '8px 14px', fontSize: 13, fontWeight: 600, borderRadius: 8,
                border: '1px solid #ddd', background: '#fff', cursor: 'pointer',
              }}
            >
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
            <button
              onClick={handleLogout}
              style={{
                padding: '8px 14px', fontSize: 13, fontWeight: 600, borderRadius: 8,
                border: '1px solid #ddd', background: '#fff', cursor: 'pointer', color: '#c0392b',
              }}
            >
              Log out
            </button>
          </div>
        </div>

        {loadError ? (
          <div style={{
            marginTop: 20, padding: '12px 14px', background: '#fdecea', border: '1px solid #f5c6c3',
            borderRadius: 8, fontSize: 13, color: '#c0392b',
          }}>
            {loadError}
          </div>
        ) : null}

        {stats ? (
          <Section title="Catalog">
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <Card label="Total events" value={stats.totalEvents ?? '—'} />
              <Card label="With price" value={stats.eventsWithPrice ?? '—'} />
              <Card label="Canonical events" value={stats.canonicalEvents ?? '—'} />
              <Card label="Ticket offers" value={stats.ticketOffers ?? '—'} />
            </div>
            {stats.eventsBySource?.length ? (
              <div style={{ marginTop: 16 }}>
                <SimpleTable
                  columns={[{ key: 'source', label: 'Source' }, { key: 'count', label: 'Events' }]}
                  rows={stats.eventsBySource}
                />
              </div>
            ) : null}
            {stats.providers?.length ? (
              <div style={{ marginTop: 16 }}>
                <SimpleTable
                  columns={[
                    { key: 'name', label: 'Provider' },
                    { key: 'active', label: 'Active', render: (r) => (r.active ? 'Yes' : 'No') },
                    { key: 'affiliate_enabled', label: 'Affiliate', render: (r) => (r.affiliate_enabled ? 'Yes' : 'No') },
                  ]}
                  rows={stats.providers}
                />
              </div>
            ) : null}
          </Section>
        ) : null}

        {health?.providers ? (
          <Section title="Sync health" note="Most recent sync run per provider/type.">
            <SimpleTable
              columns={[
                { key: 'provider_name', label: 'Provider' },
                { key: 'sync_type', label: 'Type' },
                { key: 'status', label: 'Status' },
                { key: 'records_received', label: 'Received' },
                { key: 'records_updated', label: 'Updated' },
                {
                  key: 'finished_at', label: 'Finished',
                  render: (r) => (r.finished_at ? new Date(r.finished_at).toLocaleString() : 'in progress'),
                },
                { key: 'error_message', label: 'Error', wrap: true, render: (r) => r.error_message || '—' },
              ]}
              rows={health.providers}
            />
          </Section>
        ) : null}

        {clicks ? (
          <Section
            title="Click analytics"
            note="Engagement metrics only — no revenue/price data exists in click_events, so none is shown here."
          >
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <Card label="Total clicks" value={clicks.totalClicks ?? '—'} />
              <Card
                label="Unique sessions"
                value={clicks.uniqueSessions?.allTime ?? '—'}
                sub={clicks.uniqueSessions ? `${clicks.uniqueSessions.last14Days ?? '—'} in last 14d` : null}
              />
              <Card
                label="Week over week"
                value={clicks.weekOverWeek ? `${clicks.weekOverWeek.changePct ?? '—'}%` : '—'}
                sub={clicks.weekOverWeek ? `${clicks.weekOverWeek.lastWeek} → ${clicks.weekOverWeek.thisWeek}` : null}
              />
            </div>

            {clicks.clicksByDay?.length ? (
              <div style={{ marginTop: 20 }}>
                <h3 style={{ fontSize: 13, fontWeight: 600, color: '#666', marginBottom: 8 }}>Clicks by day (last 14 days)</h3>
                {clicks.clicksByDay.map((r) => (
                  <BarRow key={r.day} label={new Date(r.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} count={r.count} max={maxDayClicks} />
                ))}
              </div>
            ) : null}

            {clicks.clicksBySource?.length ? (
              <div style={{ marginTop: 20 }}>
                <h3 style={{ fontSize: 13, fontWeight: 600, color: '#666', marginBottom: 8 }}>Clicks by source</h3>
                {clicks.clicksBySource.map((r) => (
                  <BarRow key={r.source} label={r.source} count={r.count} max={maxSourceClicks} />
                ))}
              </div>
            ) : null}

            <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', marginTop: 20 }}>
              <div style={{ flex: '1 1 260px' }}>
                <h3 style={{ fontSize: 13, fontWeight: 600, color: '#666', marginBottom: 8 }}>Top events</h3>
                <SimpleTable
                  columns={[
                    { key: 'event_title', label: 'Event', wrap: true },
                    { key: 'city', label: 'City' },
                    { key: 'count', label: 'Clicks' },
                  ]}
                  rows={clicks.topEvents}
                />
              </div>
              <div style={{ flex: '1 1 200px' }}>
                <h3 style={{ fontSize: 13, fontWeight: 600, color: '#666', marginBottom: 8 }}>By device</h3>
                <SimpleTable
                  columns={[{ key: 'device_type', label: 'Device' }, { key: 'count', label: 'Clicks' }]}
                  rows={clicks.clicksByDevice}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', marginTop: 20 }}>
              <div style={{ flex: '1 1 200px' }}>
                <h3 style={{ fontSize: 13, fontWeight: 600, color: '#666', marginBottom: 8 }}>Top cities</h3>
                <SimpleTable
                  columns={[
                    { key: 'city', label: 'City', render: (r) => `${r.city || '—'}, ${r.state || ''}` },
                    { key: 'count', label: 'Clicks' },
                  ]}
                  rows={clicks.topCities}
                />
              </div>
              <div style={{ flex: '1 1 200px' }}>
                <h3 style={{ fontSize: 13, fontWeight: 600, color: '#666', marginBottom: 8 }}>Top states</h3>
                <SimpleTable
                  columns={[{ key: 'state', label: 'State' }, { key: 'count', label: 'Clicks' }]}
                  rows={clicks.topStates}
                />
              </div>
            </div>
          </Section>
        ) : null}

        {clickDetail ? (
          <Section
            title="Click detail"
            note="Bot-vs-real-traffic diagnostic — a session/referrer showing up as '(none)' for nearly everything is consistent with automated traffic, not necessarily real visitors."
          >
            <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 260px' }}>
                <h3 style={{ fontSize: 13, fontWeight: 600, color: '#666', marginBottom: 8 }}>By referrer</h3>
                <SimpleTable
                  columns={[{ key: 'referrer', label: 'Referrer', wrap: true }, { key: 'count', label: 'Clicks' }]}
                  rows={clickDetail.byReferrer}
                />
              </div>
              <div style={{ flex: '1 1 260px' }}>
                <h3 style={{ fontSize: 13, fontWeight: 600, color: '#666', marginBottom: 8 }}>By landing page</h3>
                <SimpleTable
                  columns={[{ key: 'landing_page', label: 'Landing page', wrap: true }, { key: 'count', label: 'Clicks' }]}
                  rows={clickDetail.byLandingPage}
                />
              </div>
            </div>

            <div style={{ marginTop: 20 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, color: '#666', marginBottom: 8 }}>Top sessions</h3>
              <SimpleTable
                columns={[
                  { key: 'session_id', label: 'Session', wrap: true },
                  { key: 'count', label: 'Clicks' },
                  { key: 'distinct_events', label: 'Distinct events' },
                  { key: 'first_click', label: 'First', render: (r) => new Date(r.first_click).toLocaleString() },
                  { key: 'last_click', label: 'Last', render: (r) => new Date(r.last_click).toLocaleString() },
                ]}
                rows={clickDetail.bySession}
              />
            </div>

            <div style={{ marginTop: 20 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, color: '#666', marginBottom: 8 }}>Recent clicks (last 30)</h3>
              <SimpleTable
                columns={[
                  { key: 'created_at', label: 'Time', render: (r) => new Date(r.created_at).toLocaleString() },
                  { key: 'source', label: 'Source' },
                  { key: 'event_title', label: 'Event', wrap: true },
                  { key: 'city', label: 'City' },
                  { key: 'device_type', label: 'Device' },
                  { key: 'referrer', label: 'Referrer', wrap: true },
                ]}
                rows={clickDetail.recentSample}
              />
            </div>
          </Section>
        ) : null}
      </div>
    </div>
  );
}
