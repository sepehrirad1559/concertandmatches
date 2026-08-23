import { ProviderInterface } from './ProviderInterface.js';
import { pool } from '../index.js';
import { syncOfficialSites } from '../services/officialSites.js';

// Wraps official-site structured-data scraping (services/officialSites.js)
// behind the common Provider contract. Unlike Ticketmaster/SeatGeek, this
// provider has no fixed API endpoint — its "sources" are whatever rows are
// active in the official_sources table (added via the admin API), so
// sync() reads that table itself rather than taking a hardcoded target.
export class OfficialSiteProvider extends ProviderInterface {
  constructor() {
    super('official');
  }

  async sync() {
    const { rows } = await pool.query(
      'SELECT id, url, label, category FROM official_sources WHERE active = true ORDER BY id'
    );
    if (rows.length === 0) {
      return { success: true, sitesProcessed: 0, totalEventsFound: 0, totalEventsStored: 0, sitesWithErrors: 0, results: [], message: 'No active official sources configured yet — add one via POST /admin/official-sources' };
    }
    return syncOfficialSites(rows);
  }

  // No backfillPrices() override — official-site pages don't have a
  // separate price-lookup endpoint to backfill from; correctly falls back
  // to ProviderInterface's "not implemented" response.
}

export default OfficialSiteProvider;
