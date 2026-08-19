import knex, { Knex } from 'knex';
import path from 'path';

const config: Knex.Config = {
  client: 'pg',
  connection: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER || 'eventflow',
    password: process.env.DB_PASSWORD || 'eventflow',
    database: process.env.DB_NAME || 'eventflow'
  },
  migrations: {
    directory: path.join(__dirname, '../..', 'migrations'),
    extension: 'ts'
  },
  seeds: {
    directory: path.join(__dirname, '../..', 'seeds'),
    extension: 'ts'
  },
  pool: {
    min: 2,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  },
  // Enable returning * on all insert/update
  insertReturning: true,
};

export const db = knex(config);

// Ensure migrations are run
export async function initializeDatabase() {
  try {
    await db.migrate.latest();
    console.log('Database migrations completed');
  } catch (err) {
    console.error('Migration failed:', err);
    throw err;
  }
}

// Health check
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await db.raw('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export default db;
