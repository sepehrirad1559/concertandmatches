import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Countries
  await knex.schema.createTable('countries', (table) => {
    table.increments('id').primary();
    table.string('code', 2).unique().notNullable();
    table.string('name').notNullable();
    table.timestamps(true, true);
  });

  // States/Provinces
  await knex.schema.createTable('states_provinces', (table) => {
    table.increments('id').primary();
    table.integer('country_id').references('id').inTable('countries').notNullable();
    table.string('code', 2).notNullable();
    table.string('name').notNullable();
    table.unique(['country_id', 'code']);
    table.timestamps(true, true);
  });

  // Cities
  await knex.schema.createTable('cities', (table) => {
    table.increments('id').primary();
    table.integer('state_province_id').references('id').inTable('states_provinces').nullable();
    table.integer('country_id').references('id').inTable('countries').notNullable();
    table.string('name').notNullable();
    table.decimal('latitude', 10, 7).nullable();
    table.decimal('longitude', 10, 7).nullable();
    table.index('country_id');
    table.index('state_province_id');
    table.timestamps(true, true);
  });

  // Source Configuration
  await knex.schema.createTable('sources', (table) => {
    table.increments('id').primary();
    table.string('name').notNullable();
    table.enum('type', ['api', 'feed', 'crawler', 'affiliate']).notNullable();
    table.boolean('enabled').defaultTo(true);
    table.string('country').notNullable(); // US, CA, or US,CA
    table.string('coverage').nullable(); // JSON field describing coverage
    table.integer('update_frequency_minutes').defaultTo(30);
    table.string('auth_method').nullable(); // api_key, oauth, basic, none
    table.text('auth_config').nullable(); // JSON encrypted credentials
    table.integer('rate_limit_requests').defaultTo(100);
    table.integer('rate_limit_window_seconds').defaultTo(60);
    table.enum('revenue_model', ['affiliate', 'lead_gen', 'transaction', 'none']).defaultTo('affiliate');
    table.string('affiliate_network').nullable();
    table.string('affiliate_program').nullable();
    table.string('affiliate_id').nullable();
    table.integer('freshness_threshold_minutes').defaultTo(30);
    table.text('disclosure_text').nullable(); // Attribution text
    table.text('terms_summary').nullable();
    table.enum('compliance_status', ['approved', 'pending_review', 'restricted', 'disabled']).defaultTo('pending_review');
    table.timestamp('last_successful_crawl').nullable();
    table.timestamp('last_failed_crawl').nullable();
    table.string('last_error').nullable();
    table.bigInteger('total_events_discovered').defaultTo(0);
    table.bigInteger('total_listings_discovered').defaultTo(0);
    table.integer('admin_notes').nullable();
    table.timestamps(true, true);
    table.index('enabled');
    table.index('country');
  });

  // Source Compliance Details
  await knex.schema.createTable('source_compliance', (table) => {
    table.increments('id').primary();
    table.integer('source_id').references('id').inTable('sources').notNullable();
    table.string('api_agreement_id').nullable();
    table.string('affiliate_agreement_id').nullable();
    table.timestamp('terms_review_date').nullable();
    table.string('terms_reviewer').nullable();
    table.text('permitted_data_fields').nullable(); // JSON array
    table.text('prohibited_data_fields').nullable(); // JSON array
    table.enum('permitted_use', ['display', 'search', 'analytics', 'affiliate']).defaultTo('display');
    table.integer('permitted_cache_duration_hours').defaultTo(24);
    table.boolean('commercial_use_permitted').defaultTo(true);
    table.text('attribution_requirements').nullable();
    table.text('geographic_restrictions').nullable(); // JSON
    table.integer('data_retention_days').defaultTo(365);
    table.boolean('requires_explicit_attribution').defaultTo(true);
    table.timestamps(true, true);
    table.unique('source_id');
  });

  // Venues (Canonical)
  await knex.schema.createTable('venues', (table) => {
    table.increments('id').primary();
    table.string('name').notNullable();
    table.integer('city_id').references('id').inTable('cities').nullable();
    table.decimal('latitude', 10, 7).nullable();
    table.decimal('longitude', 10, 7).nullable();
    table.string('address').nullable();
    table.string('postal_code').nullable();
    table.string('phone').nullable();
    table.string('website').nullable();
    table.integer('capacity').nullable();
    table.enum('type', ['arena', 'theater', 'club', 'festival_grounds', 'stadium', 'university', 'other']).defaultTo('other');
    table.text('description').nullable();
    table.string('image_url').nullable();
    table.integer('quality_score').defaultTo(0); // 0-100
    table.integer('events_count').defaultTo(0);
    table.timestamps(true, true);
    table.index('city_id');
    table.fulltext('name'); // MySQL fulltext, will be replaced with proper search
  });

  // External Venues (per source)
  await knex.schema.createTable('external_venues', (table) => {
    table.increments('id').primary();
    table.integer('source_id').references('id').inTable('sources').notNullable();
    table.string('external_venue_id').notNullable();
    table.integer('venue_id').references('id').inTable('venues').nullable(); // Matched canonical venue
    table.string('name').notNullable();
    table.string('city').nullable();
    table.string('state_province').nullable();
    table.string('country').nullable();
    table.decimal('latitude', 10, 7).nullable();
    table.decimal('longitude', 10, 7).nullable();
    table.string('address').nullable();
    table.string('postal_code').nullable();
    table.text('raw_data').nullable(); // Original JSON from source
    table.timestamps(true, true);
    table.unique(['source_id', 'external_venue_id']);
    table.index(['venue_id', 'source_id']);
  });

  // Venue Aliases
  await knex.schema.createTable('venue_aliases', (table) => {
    table.increments('id').primary();
    table.integer('venue_id').references('id').inTable('venues').notNullable();
    table.string('alias').notNullable();
    table.timestamps(true, true);
    table.unique(['venue_id', 'alias']);
    table.index('alias');
  });

  // Artists (Canonical)
  await knex.schema.createTable('artists', (table) => {
    table.increments('id').primary();
    table.string('name').notNullable().unique();
    table.enum('type', ['artist', 'band', 'comedian', 'show', 'other']).defaultTo('other');
    table.text('description').nullable();
    table.string('image_url').nullable();
    table.string('website').nullable();
    table.integer('events_count').defaultTo(0);
    table.timestamps(true, true);
    table.index('type');
  });

  // Artist Aliases
  await knex.schema.createTable('artist_aliases', (table) => {
    table.increments('id').primary();
    table.integer('artist_id').references('id').inTable('artists').notNullable();
    table.string('alias').notNullable();
    table.timestamps(true, true);
    table.unique(['artist_id', 'alias']);
    table.index('alias');
  });

  // Teams (Sports)
  await knex.schema.createTable('teams', (table) => {
    table.increments('id').primary();
    table.string('name').notNullable().unique();
    table.string('league').nullable();
    table.string('logo_url').nullable();
    table.text('description').nullable();
    table.integer('events_count').defaultTo(0);
    table.timestamps(true, true);
  });

  // Events (Canonical)
  await knex.schema.createTable('events', (table) => {
    table.increments('id').primary();
    table.string('title').notNullable();
    table.text('description').nullable();
    table.integer('venue_id').references('id').inTable('venues').nullable();
    table.dateTime('start_time').notNullable();
    table.dateTime('end_time').nullable();
    table.enum('category', ['concert', 'sports', 'theater', 'comedy', 'festival', 'family', 'other']).defaultTo('other');
    table.boolean('all_day').defaultTo(false);
    table.text('image_url').nullable();
    table.text('image_urls').nullable(); // JSON array
    table.integer('quality_score').defaultTo(0); // 0-100
    table.enum('status', ['active', 'pending_review', 'inactive', 'cancelled']).defaultTo('pending_review');
    table.integer('total_listings').defaultTo(0);
    table.integer('lowest_price').nullable(); // In cents, USD
    table.string('lowest_price_currency').defaultTo('USD');
    table.integer('highest_price').nullable();
    table.integer('active_listings').defaultTo(0);
    table.timestamp('last_inventory_update').nullable();
    table.timestamps(true, true);
    table.index('start_time');
    table.index('status');
    table.index('venue_id');
    table.index('category');
  });

  // Event Performers (artists/teams in an event)
  await knex.schema.createTable('event_performers', (table) => {
    table.increments('id').primary();
    table.integer('event_id').references('id').inTable('events').notNullable();
    table.integer('artist_id').references('id').inTable('artists').nullable();
    table.integer('team_id').references('id').inTable('teams').nullable();
    table.integer('order').defaultTo(0);
    table.timestamps(true, true);
    table.unique(['event_id', 'artist_id']);
    table.unique(['event_id', 'team_id']);
  });

  // External Events (per source)
  await knex.schema.createTable('external_events', (table) => {
    table.increments('id').primary();
    table.integer('source_id').references('id').inTable('sources').notNullable();
    table.string('external_event_id').notNullable();
    table.integer('event_id').references('id').inTable('events').nullable(); // Matched canonical event
    table.string('title').notNullable();
    table.string('external_venue_id').nullable();
    table.dateTime('start_time').notNullable();
    table.dateTime('end_time').nullable();
    table.string('category').nullable();
    table.text('raw_data').nullable(); // Original JSON from source
    table.integer('confidence_score').defaultTo(0); // 0-100, matching confidence
    table.timestamps(true, true);
    table.unique(['source_id', 'external_event_id']);
    table.index(['event_id', 'source_id']);
  });

  // Event Matches (deduplication)
  await knex.schema.createTable('event_matches', (table) => {
    table.increments('id').primary();
    table.integer('event_id').references('id').inTable('events').notNullable();
    table.integer('external_event_id').references('id').inTable('external_events').notNullable();
    table.integer('match_score').defaultTo(0); // 0-100
    table.enum('match_type', ['exact', 'fuzzy', 'manual']).defaultTo('fuzzy');
    table.enum('status', ['confirmed', 'pending_review', 'rejected']).defaultTo('pending_review');
    table.integer('reviewed_by').nullable();
    table.timestamp('reviewed_at').nullable();
    table.timestamps(true, true);
    table.unique(['event_id', 'external_event_id']);
  });

  // Venue Sections
  await knex.schema.createTable('venue_sections', (table) => {
    table.increments('id').primary();
    table.integer('venue_id').references('id').inTable('venues').notNullable();
    table.string('section_name').notNullable();
    table.string('section_code').nullable();
    table.enum('location', ['lower_bowl', 'upper_bowl', 'club', 'terrace', 'standing', 'other']).defaultTo('other');
    table.timestamps(true, true);
    table.unique(['venue_id', 'section_name']);
  });

  // Tickets (canonical seat/ticket types)
  await knex.schema.createTable('tickets', (table) => {
    table.increments('id').primary();
    table.integer('venue_id').references('id').inTable('venues').notNullable();
    table.integer('section_id').references('id').inTable('venue_sections').notNullable();
    table.string('row').nullable();
    table.string('seat').nullable();
    table.enum('ticket_type', ['general_admission', 'reserved_seat', 'vip', 'accessible', 'other']).defaultTo('reserved_seat');
    table.timestamps(true, true);
    table.unique(['venue_id', 'section_id', 'row', 'seat']);
    table.index(['venue_id', 'section_id']);
  });

  // Listings (Ticket listings - can be from marketplace or external)
  await knex.schema.createTable('listings', (table) => {
    table.increments('id').primary();
    table.integer('event_id').references('id').inTable('events').notNullable();
    table.integer('external_listing_id').references('id').inTable('external_listings').nullable();
    table.integer('seller_id').nullable(); // For marketplace seller listings
    table.enum('listing_type', ['marketplace', 'aggregated']).defaultTo('aggregated');
    table.string('section').nullable();
    table.string('row').nullable();
    table.string('seat').nullable();
    table.integer('quantity').defaultTo(1);
    table.integer('price_cents').notNullable(); // Store in cents for precision
    table.string('currency').defaultTo('USD');
    table.enum('ticket_type', ['general_admission', 'reserved_seat', 'vip', 'accessible', 'other']).defaultTo('reserved_seat');
    table.enum('delivery_method', ['electronic', 'physical', 'will_call']).defaultTo('electronic');
    table.enum('availability', ['available', 'unavailable', 'pending', 'sold_out']).defaultTo('available');
    table.text('restrictions').nullable(); // JSON
    table.integer('source_id').references('id').inTable('sources').nullable();
    table.timestamp('last_seen_at').notNullable();
    table.timestamp('last_price_update').nullable();
    table.timestamp('last_availability_update').nullable();
    table.integer('impressions').defaultTo(0);
    table.integer('clicks').defaultTo(0);
    table.enum('revenue_model', ['affiliate', 'lead_gen', 'transaction', 'commission']).defaultTo('affiliate');
    table.timestamps(true, true);
    table.index('event_id');
    table.index('source_id');
    table.index('availability');
    table.index('last_seen_at');
  });

  // External Listings (original source listing data)
  await knex.schema.createTable('external_listings', (table) => {
    table.increments('id').primary();
    table.integer('source_id').references('id').inTable('sources').notNullable();
    table.string('external_listing_id').notNullable();
    table.string('external_event_id').notNullable();
    table.string('section').nullable();
    table.string('row').nullable();
    table.string('seat').nullable();
    table.integer('quantity').defaultTo(1);
    table.integer('price_cents').notNullable();
    table.string('currency').defaultTo('USD');
    table.string('ticket_type').nullable();
    table.string('delivery_method').nullable();
    table.enum('availability', ['available', 'unavailable', 'pending']).defaultTo('available');
    table.text('restrictions').nullable(); // JSON
    table.text('raw_data').nullable(); // Original JSON
    table.timestamp('retrieved_at').notNullable();
    table.timestamp('last_seen_at').notNullable();
    table.string('source_url').nullable();
    table.timestamps(true, true);
    table.unique(['source_id', 'external_listing_id']);
    table.index(['source_id', 'external_event_id']);
  });

  // Inventory Snapshots (historical pricing/availability)
  await knex.schema.createTable('inventory_snapshots', (table) => {
    table.increments('id').primary();
    table.integer('external_listing_id').references('id').inTable('external_listings').notNullable();
    table.integer('source_id').references('id').inTable('sources').notNullable();
    table.integer('price_cents').notNullable();
    table.string('currency').defaultTo('USD');
    table.integer('quantity_available').defaultTo(1);
    table.string('availability').nullable();
    table.string('section').nullable();
    table.string('row').nullable();
    table.timestamp('snapshot_at').notNullable();
    table.timestamps(true, true);
    table.index(['external_listing_id', 'snapshot_at']);
    table.index(['source_id', 'snapshot_at']);
  });

  // Crawler Logs
  await knex.schema.createTable('crawler_logs', (table) => {
    table.increments('id').primary();
    table.integer('source_id').references('id').inTable('sources').notNullable();
    table.enum('job_type', ['event_discovery', 'event_update', 'inventory_sync', 'price_update', 'venue_sync', 'artist_sync']).notNullable();
    table.enum('status', ['started', 'success', 'failed', 'partial']).notNullable();
    table.integer('events_discovered').defaultTo(0);
    table.integer('events_updated').defaultTo(0);
    table.integer('listings_discovered').defaultTo(0);
    table.integer('listings_updated').defaultTo(0);
    table.integer('listings_removed').defaultTo(0);
    table.integer('errors_count').defaultTo(0);
    table.text('error_message').nullable();
    table.enum('error_type', ['http_error', 'parse_error', 'rate_limit', 'auth_error', 'timeout', 'other']).nullable();
    table.integer('duration_ms').defaultTo(0);
    table.integer('http_status').nullable();
    table.timestamps(true, true);
    table.index('source_id');
    table.index('job_type');
    table.index('status');
  });

  // Raw Source Data (store original responses)
  await knex.schema.createTable('raw_source_data', (table) => {
    table.increments('id').primary();
    table.integer('source_id').references('id').inTable('sources').notNullable();
    table.string('external_id').nullable();
    table.enum('data_type', ['event', 'listing', 'venue']).notNullable();
    table.text('payload').notNullable(); // JSON
    table.string('content_hash').notNullable();
    table.string('parser_version').nullable();
    table.timestamp('retrieved_at').notNullable();
    table.timestamps(true, true);
    table.index('source_id');
    table.index('content_hash');
  });

  // Affiliate Tracking
  await knex.schema.createTable('affiliate_events', (table) => {
    table.increments('id').primary();
    table.integer('listing_id').references('id').inTable('listings').notNullable();
    table.integer('source_id').references('id').inTable('sources').notNullable();
    table.string('click_id').nullable();
    table.string('conversion_id').nullable();
    table.string('session_id').nullable();
    table.enum('event_type', ['impression', 'click', 'checkout', 'purchase', 'abandon']).notNullable();
    table.decimal('commission', 10, 2).nullable();
    table.enum('conversion_status', ['pending', 'confirmed', 'rejected']).defaultTo('pending');
    table.text('raw_data').nullable(); // JSON from affiliate
    table.timestamps(true, true);
    table.index('listing_id');
    table.index('source_id');
    table.index('event_type');
  });

  // Orders (when buyer completes transaction)
  await knex.schema.createTable('orders', (table) => {
    table.increments('id').primary();
    table.uuid('external_order_id').nullable(); // Order ID from external provider
    table.integer('listing_id').references('id').inTable('listings').notNullable();
    table.integer('event_id').references('id').inTable('events').notNullable();
    table.integer('source_id').references('id').inTable('sources').notNullable();
    table.enum('transaction_mode', ['redirect', 'api_reserved', 'marketplace']).notNullable();
    table.integer('quantity').defaultTo(1);
    table.integer('price_cents').notNullable();
    table.string('currency').defaultTo('USD');
    table.enum('status', ['initiated', 'reserved', 'confirmed', 'delivered', 'failed', 'cancelled']).defaultTo('initiated');
    table.string('buyer_email').nullable();
    table.timestamp('completed_at').nullable();
    table.string('external_confirmation').nullable(); // Confirmation code from provider
    table.text('raw_response').nullable(); // Original response from external provider
    table.timestamps(true, true);
    table.index('listing_id');
    table.index('event_id');
    table.index('source_id');
    table.index('status');
  });

  // Audit Log (for compliance)
  await knex.schema.createTable('audit_logs', (table) => {
    table.increments('id').primary();
    table.integer('admin_id').nullable();
    table.enum('action', ['source_enabled', 'source_disabled', 'source_config_changed', 'entity_merged', 'entity_split', 'compliance_reviewed']).notNullable();
    table.string('resource_type').notNullable(); // source, event, venue, artist
    table.integer('resource_id').nullable();
    table.text('details').nullable(); // JSON with changes
    table.text('reason').nullable();
    table.timestamps(true, true);
    table.index('action');
    table.index('admin_id');
  });

  // Search Index Config
  await knex.schema.createTable('search_index_config', (table) => {
    table.increments('id').primary();
    table.enum('index_type', ['event', 'venue', 'artist']).notNullable().unique();
    table.integer('total_documents').defaultTo(0);
    table.timestamp('last_indexed_at').nullable();
    table.enum('status', ['healthy', 'rebuilding', 'degraded']).defaultTo('healthy');
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  // Drop in reverse order
  await knex.schema.dropTableIfExists('search_index_config');
  await knex.schema.dropTableIfExists('audit_logs');
  await knex.schema.dropTableIfExists('orders');
  await knex.schema.dropTableIfExists('affiliate_events');
  await knex.schema.dropTableIfExists('raw_source_data');
  await knex.schema.dropTableIfExists('crawler_logs');
  await knex.schema.dropTableIfExists('inventory_snapshots');
  await knex.schema.dropTableIfExists('external_listings');
  await knex.schema.dropTableIfExists('listings');
  await knex.schema.dropTableIfExists('tickets');
  await knex.schema.dropTableIfExists('venue_sections');
  await knex.schema.dropTableIfExists('event_matches');
  await knex.schema.dropTableIfExists('external_events');
  await knex.schema.dropTableIfExists('event_performers');
  await knex.schema.dropTableIfExists('events');
  await knex.schema.dropTableIfExists('teams');
  await knex.schema.dropTableIfExists('artist_aliases');
  await knex.schema.dropTableIfExists('artists');
  await knex.schema.dropTableIfExists('venue_aliases');
  await knex.schema.dropTableIfExists('external_venues');
  await knex.schema.dropTableIfExists('venues');
  await knex.schema.dropTableIfExists('source_compliance');
  await knex.schema.dropTableIfExists('sources');
  await knex.schema.dropTableIfExists('cities');
  await knex.schema.dropTableIfExists('states_provinces');
  await knex.schema.dropTableIfExists('countries');
}
