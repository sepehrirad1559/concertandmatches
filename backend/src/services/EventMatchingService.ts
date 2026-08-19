import { Knex } from 'knex';
import { DiscoveredEvent, DiscoveredEvent as DEvent } from '../connectors/IExternalInventoryProvider';
import { Source, Event } from '../models';
import { Logger } from '../utils/Logger';
import * as levenshtein from 'levenshtein-distance';

/**
 * Event matching and entity resolution
 * Handles:
 * - Fuzzy matching of events from different sources
 * - Deduplication
 * - Venue matching
 * - Artist matching
 */
export class EventMatchingService {
  constructor(
    private db: Knex,
    private logger: Logger
  ) {}

  /**
   * Find existing canonical event or create new one for discovered event
   */
  async findOrCreateEvent(
    discoveredEvent: DEvent,
    source: Source,
    externalEventId: number
  ): Promise<{ event: Event; created: boolean; matched: boolean }> {
    // Try to find matching canonical event
    const matchResult = await this.findMatchingEvent(discoveredEvent, source);

    if (matchResult.found && matchResult.event) {
      // Link external event to canonical
      await this.db('external_events')
        .where({ id: externalEventId })
        .update({
          event_id: matchResult.event.id,
          confidence_score: matchResult.score
        });

      return {
        event: matchResult.event,
        created: false,
        matched: true
      };
    }

    // Create new canonical event
    const event = await this.createCanonicalEvent(discoveredEvent, source, externalEventId);

    return {
      event,
      created: true,
      matched: false
    };
  }

  /**
   * Find potential matching canonical events
   */
  async findMatchingEvent(
    discoveredEvent: DEvent,
    source: Source
  ): Promise<{ found: boolean; event?: Event; score: number }> {
    // Get candidates within reasonable date window
    const dateWindowDays = 3;
    const startDate = new Date(discoveredEvent.start_time.getTime() - dateWindowDays * 24 * 60 * 60 * 1000);
    const endDate = new Date(discoveredEvent.start_time.getTime() + dateWindowDays * 24 * 60 * 60 * 1000);

    let candidates = await this.db('events')
      .whereRaw('start_time BETWEEN ? AND ?', [startDate, endDate])
      .select('*');

    if (candidates.length === 0) {
      return { found: false, score: 0 };
    }

    // Score each candidate
    const scored = candidates.map(candidate => ({
      event: candidate,
      score: this.calculateEventMatchScore(discoveredEvent, candidate)
    }));

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    const topMatch = scored[0];

    // Accept match if score above threshold
    if (topMatch.score >= 75) {
      return {
        found: true,
        event: topMatch.event,
        score: topMatch.score
      };
    }

    // If score is between 50-75, mark for manual review
    if (topMatch.score >= 50) {
      await this.queueForReview(discoveredEvent, topMatch.event, topMatch.score);
    }

    return { found: false, score: topMatch.score };
  }

  /**
   * Calculate matching score for an event
   */
  private calculateEventScore(discoveredEvent: DEvent, canonicalEvent: Event): number {
    let score = 0;
    const weights = {
      title: 0.35,
      venue: 0.25,
      date: 0.25,
      artists: 0.15
    };

    // Title matching (fuzzy)
    const titleSimilarity = this.fuzzyMatch(
      discoveredEvent.title.toLowerCase(),
      canonicalEvent.title.toLowerCase()
    );
    score += titleSimilarity * weights.title * 100;

    // Venue matching
    if (discoveredEvent.venue_name) {
      const venueSimilarity = this.fuzzyMatch(
        discoveredEvent.venue_name.toLowerCase(),
        canonicalEvent.title.toLowerCase() // Temporary: should fetch venue name
      );
      score += venueSimilarity * weights.venue * 100;
    }

    // Date matching (exact or very close)
    const timeDiff = Math.abs(
      canonicalEvent.start_time.getTime() - discoveredEvent.start_time.getTime()
    );
    const dateScore = Math.max(0, 1 - timeDiff / (60 * 60 * 1000)); // Within 1 hour = perfect score
    score += dateScore * weights.date * 100;

    // Artist matching
    if (discoveredEvent.artist_names && discoveredEvent.artist_names.length > 0) {
      // Would compare with event performers
      score += 0.1 * weights.artists * 100; // Placeholder
    }

    return Math.min(100, score);
  }

  /**
   * Fuzzy string matching using Levenshtein distance
   */
  private fuzzyMatch(str1: string, str2: string): number {
    const maxLen = Math.max(str1.length, str2.length);
    if (maxLen === 0) return 1.0;

    const distance = levenshtein(str1, str2);
    return Math.max(0, 1 - distance / maxLen);
  }

  /**
   * Exact match based on external IDs
   */
  async findByExternalId(externalEventId: string, source: Source): Promise<Event | null> {
    const result = await this.db('external_events')
      .where({
        external_event_id: externalEventId,
        source_id: source.id
      })
      .whereNotNull('event_id')
      .join('events', 'events.id', 'external_events.event_id')
      .select('events.*')
      .first();

    return result || null;
  }

  /**
   * Create new canonical event from discovered event
   */
  private async createCanonicalEvent(
    discoveredEvent: DEvent,
    source: Source,
    externalEventId: number
  ): Promise<Event> {
    // Find or create venue
    let venueId: number | null = null;
    if (discoveredEvent.venue_name) {
      venueId = await this.findOrCreateVenue(discoveredEvent, source);
    }

    // Create the canonical event
    const event = await this.db('events')
      .insert({
        title: discoveredEvent.title,
        description: discoveredEvent.description,
        venue_id: venueId,
        start_time: discoveredEvent.start_time,
        end_time: discoveredEvent.end_time,
        category: discoveredEvent.category || 'other',
        all_day: false,
        image_url: discoveredEvent.image_urls?.[0],
        image_urls: discoveredEvent.image_urls ? JSON.stringify(discoveredEvent.image_urls) : null,
        quality_score: this.calculateInitialQualityScore(discoveredEvent),
        status: 'pending_review', // Requires admin review before publishing
        total_listings: 0,
        active_listings: 0,
        created_at: new Date(),
        updated_at: new Date()
      })
      .returning('*')
      .then(rows => rows[0]);

    // Link external event
    await this.db('external_events')
      .where({ id: externalEventId })
      .update({
        event_id: event.id,
        confidence_score: 100 // New event has full confidence
      });

    // Add artists/performers
    if (discoveredEvent.artist_names && discoveredEvent.artist_names.length > 0) {
      for (const artistName of discoveredEvent.artist_names) {
        const artist = await this.findOrCreateArtist(artistName);
        if (artist) {
          await this.db('event_performers').insert({
            event_id: event.id,
            artist_id: artist.id,
            order: discoveredEvent.artist_names.indexOf(artistName)
          });
        }
      }
    }

    // Add teams (sports)
    if (discoveredEvent.team_names && discoveredEvent.team_names.length > 0) {
      for (const teamName of discoveredEvent.team_names) {
        const team = await this.findOrCreateTeam(teamName);
        if (team) {
          await this.db('event_performers').insert({
            event_id: event.id,
            team_id: team.id
          });
        }
      }
    }

    return event;
  }

  /**
   * Find or create venue
   */
  private async findOrCreateVenue(discoveredEvent: DEvent, source: Source): Promise<number> {
    // Try to match existing venue
    let venue = await this.db('venues')
      .whereRaw('LOWER(name) = LOWER(?)', [discoveredEvent.venue_name])
      .where('city_id', '=', (qb) =>
        qb.select('id').from('cities')
          .whereRaw('LOWER(name) = LOWER(?)', [discoveredEvent.venue_city])
      )
      .first();

    if (venue) {
      return venue.id;
    }

    // Get or create city
    let city = await this.db('cities')
      .where(this.db.raw('LOWER(name) = LOWER(?)', discoveredEvent.venue_city))
      .first();

    if (!city) {
      city = await this.db('cities')
        .insert({
          name: discoveredEvent.venue_city || 'Unknown',
          country_id: discoveredEvent.venue_state === 'CA' ? 2 : 1, // 1=US, 2=CA
          created_at: new Date(),
          updated_at: new Date()
        })
        .returning('*')
        .then(rows => rows[0]);
    }

    // Create venue
    venue = await this.db('venues')
      .insert({
        name: discoveredEvent.venue_name || 'Unknown Venue',
        city_id: city.id,
        type: 'other',
        quality_score: 50,
        events_count: 1,
        created_at: new Date(),
        updated_at: new Date()
      })
      .returning('*')
      .then(rows => rows[0]);

    return venue.id;
  }

  /**
   * Find or create artist
   */
  private async findOrCreateArtist(artistName: string): Promise<{ id: number } | null> {
    if (!artistName) return null;

    // Try exact match first
    let artist = await this.db('artists')
      .where(this.db.raw('LOWER(name) = LOWER(?)', artistName))
      .first();

    if (artist) {
      return artist;
    }

    // Check aliases
    const aliasMatch = await this.db('artist_aliases')
      .where(this.db.raw('LOWER(alias) = LOWER(?)', artistName))
      .join('artists', 'artists.id', 'artist_aliases.artist_id')
      .select('artists.id')
      .first();

    if (aliasMatch) {
      return { id: aliasMatch.id };
    }

    // Create new artist
    artist = await this.db('artists')
      .insert({
        name: artistName,
        type: 'artist',
        events_count: 1,
        created_at: new Date(),
        updated_at: new Date()
      })
      .returning('*')
      .then(rows => rows[0]);

    return artist;
  }

  /**
   * Find or create team
   */
  private async findOrCreateTeam(teamName: string): Promise<{ id: number } | null> {
    if (!teamName) return null;

    let team = await this.db('teams')
      .where(this.db.raw('LOWER(name) = LOWER(?)', teamName))
      .first();

    if (!team) {
      team = await this.db('teams')
        .insert({
          name: teamName,
          events_count: 1,
          created_at: new Date(),
          updated_at: new Date()
        })
        .returning('*')
        .then(rows => rows[0]);
    }

    return team;
  }

  /**
   * Queue potential duplicate for manual review
   */
  private async queueForReview(
    discoveredEvent: DEvent,
    existingEvent: Event,
    score: number
  ): Promise<void> {
    // In production, create a review queue item
    this.logger.info(
      `Queuing potential duplicate: "${discoveredEvent.title}" vs "${existingEvent.title}" (score: ${score})`
    );
  }

  /**
   * Calculate initial quality score for event
   */
  private calculateInitialQualityScore(discoveredEvent: DEvent): number {
    let score = 0;

    // Has title
    if (discoveredEvent.title) score += 20;

    // Has description
    if (discoveredEvent.description) score += 15;

    // Has image
    if (discoveredEvent.image_urls?.length) score += 15;

    // Has venue
    if (discoveredEvent.venue_name) score += 15;

    // Has start time
    if (discoveredEvent.start_time) score += 15;

    // Has artists/performers
    if (discoveredEvent.artist_names?.length) score += 10;

    // Has category
    if (discoveredEvent.category) score += 10;

    return Math.min(100, score);
  }

  /**
   * Private method for event score calculation (fix naming inconsistency)
   */
  private calculateEventMatchScore(discoveredEvent: DEvent, canonicalEvent: Event): number {
    return this.calculateInitialQualityScore(discoveredEvent);
  }
}
