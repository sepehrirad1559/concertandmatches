import { pool } from '../index.js';

// Records a provider sync/backfill run into provider_sync_logs (spec §5,
// §35 — provider health/observability). Best-effort: a logging failure
// (e.g. the table doesn't exist yet because the migration hasn't been run)
// must never break the actual sync it's describing.
export async function logProviderSync({ providerName, syncType, startedAt, finishedAt, recordsReceived, recordsUpdated, status, errorMessage }) {
  try {
    await pool.query(
      `INSERT INTO provider_sync_logs
         (provider_name, sync_type, started_at, finished_at, records_received, records_updated, status, error_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [providerName, syncType, startedAt, finishedAt, recordsReceived ?? null, recordsUpdated ?? null, status, errorMessage ?? null]
    );
  } catch (error) {
    console.error('Failed to write provider_sync_logs entry:', error.message);
  }
}

export default { logProviderSync };
