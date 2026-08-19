import { Queue, Worker } from 'bullmq';
import { db } from '../database/config';
import { Logger } from '../utils/Logger';
import { IngestionService } from '../services/IngestionService';
import { EventMatchingService } from '../services/EventMatchingService';
import { PricingService } from '../services/PricingService';
import { TicketmasterConnector } from '../connectors/TicketmasterConnector';
import dotenv from 'dotenv';

dotenv.config();

const logger = new Logger('Job-Worker');

// ============ JOB QUEUES ============

const jobQueues = {
  eventDiscovery: new Queue('event_discovery', {
    connection: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379')
    }
  }),
  eventUpdate: new Queue('event_update', {
    connection: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379')
    }
  }),
  inventorySync: new Queue('inventory_sync', {
    connection: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379')
    }
  }),
  priceUpdate: new Queue('price_update', {
    connection: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379')
    }
  }),
  anomalyDetection: new Queue('anomaly_detection', {
    connection: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379')
    }
  })
};

// ============ SERVICES ============

const eventMatcher = new EventMatchingService(db, logger);
const pricingService = new PricingService(db, logger);
const ingestionService = new IngestionService(db, eventMatcher, pricingService, logger);

// ============ CONNECTOR REGISTRY ============

function getConnector(sourceId: number, source: any) {
  // In production, this would dynamically load connectors based on source configuration
  // For now, we'll demonstrate with Ticketmaster
  
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) {
    throw new Error('TICKETMASTER_API_KEY not configured');
  }

  return new TicketmasterConnector(sourceId, apiKey);
}

// ============ WORKERS ============

/**
 * Event Discovery Worker
 * Discovers new events from sources
 */
const eventDiscoveryWorker = new Worker('event_discovery', async (job) => {
  const { source_id } = job.data;
  logger.info(`Starting event discovery for source ${source_id}`);

  const source = await db('sources').where({ id: source_id }).first();
  if (!source) {
    throw new Error(`Source ${source_id} not found`);
  }

  if (!source.enabled) {
    logger.info(`Source ${source_id} is disabled, skipping`);
    return { skipped: true };
  }

  try {
    const connector = getConnector(source_id, source);
    const result = await ingestionService.discoverEvents(source, connector);

    logger.info(`Event discovery completed: ${JSON.stringify(result)}`);
    return result;
  } catch (err: any) {
    logger.error(`Event discovery failed: ${err.message}`);
    throw err;
  }
}, {
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379')
  },
  concurrency: 2 // Don't run too many simultaneously
});

/**
 * Inventory Sync Worker
 * Synchronizes ticket listings and pricing
 */
const inventorySyncWorker = new Worker('inventory_sync', async (job) => {
  const { source_id } = job.data;
  logger.info(`Starting inventory sync for source ${source_id}`);

  const source = await db('sources').where({ id: source_id }).first();
  if (!source) {
    throw new Error(`Source ${source_id} not found`);
  }

  if (!source.enabled) {
    logger.info(`Source ${source_id} is disabled, skipping`);
    return { skipped: true };
  }

  try {
    const connector = getConnector(source_id, source);
    const result = await ingestionService.syncInventory(source, connector);

    logger.info(`Inventory sync completed: ${JSON.stringify(result)}`);
    return result;
  } catch (err: any) {
    logger.error(`Inventory sync failed: ${err.message}`);
    throw err;
  }
}, {
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379')
  },
  concurrency: 5 // Allow more concurrent inventory syncs
});

/**
 * Anomaly Detection Worker
 * Detects parser failures and data quality issues
 */
const anomalyDetectionWorker = new Worker('anomaly_detection', async (job) => {
  const { source_id } = job.data;
  logger.info(`Running anomaly detection for source ${source_id}`);

  const source = await db('sources').where({ id: source_id }).first();
  if (!source) {
    throw new Error(`Source ${source_id} not found`);
  }

  const issues = await ingestionService.detectAnomalies(source);

  if (issues.length > 0) {
    logger.warn(`Anomalies detected for source ${source.name}: ${issues.join('; ')}`);
    // In production, trigger alert/notification here
  }

  return { source_id, issues };
}, {
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379')
  },
  concurrency: 1
});

// ============ EVENT LISTENERS ============

eventDiscoveryWorker.on('completed', (job) => {
  logger.info(`✓ Event discovery job ${job.id} completed`);
});

eventDiscoveryWorker.on('failed', (job, err) => {
  logger.error(`✗ Event discovery job ${job?.id} failed: ${err.message}`);
});

inventorySyncWorker.on('completed', (job) => {
  logger.info(`✓ Inventory sync job ${job.id} completed`);
});

inventorySyncWorker.on('failed', (job, err) => {
  logger.error(`✗ Inventory sync job ${job?.id} failed: ${err.message}`);
});

// ============ SCHEDULED JOBS ============

async function scheduleJobs() {
  logger.info('Scheduling crawler jobs...');

  const sources = await db('sources').where({ enabled: true }).select('*');

  for (const source of sources) {
    // Schedule event discovery
    const discoveryFrequency = source.update_frequency_minutes || 30;
    await jobQueues.eventDiscovery.add(
      `discover-${source.id}`,
      { source_id: source.id },
      {
        repeat: {
          every: discoveryFrequency * 60 * 1000 // Convert to milliseconds
        },
        backoff: {
          type: 'exponential',
          delay: 2000
        },
        attempts: 3,
        removeOnComplete: true,
        removeOnFail: false
      }
    );

    // Schedule inventory sync (more frequent)
    const inventoryFrequency = Math.max(5, discoveryFrequency / 4); // 4x more frequent, min 5 min
    await jobQueues.inventorySync.add(
      `sync-${source.id}`,
      { source_id: source.id },
      {
        repeat: {
          every: inventoryFrequency * 60 * 1000
        },
        backoff: {
          type: 'exponential',
          delay: 2000
        },
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: false,
        priority: 10 // Higher priority
      }
    );

    // Schedule anomaly detection (less frequent)
    await jobQueues.anomalyDetection.add(
      `anomaly-${source.id}`,
      { source_id: source.id },
      {
        repeat: {
          every: 6 * 60 * 60 * 1000 // Every 6 hours
        },
        backoff: {
          type: 'exponential',
          delay: 2000
        },
        attempts: 2,
        removeOnComplete: true
      }
    );

    logger.info(`Scheduled jobs for source: ${source.name}`);
  }
}

// ============ STARTUP ============

async function start() {
  try {
    logger.info('Starting job worker...');
    await scheduleJobs();
    logger.info('Job worker started and jobs scheduled');

    // Keep process alive
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received, closing workers...');
      await eventDiscoveryWorker.close();
      await inventorySyncWorker.close();
      await anomalyDetectionWorker.close();
      process.exit(0);
    });
  } catch (err: any) {
    logger.error(`Failed to start job worker: ${err.message}`);
    process.exit(1);
  }
}

start();

export { jobQueues };
