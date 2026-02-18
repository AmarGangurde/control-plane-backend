import pg from 'pg';
import logger from '../utils/logger.js';

const { Pool } = pg;

// --- Connection Pool ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://wrexer:wrexer_secret@localhost:5432/wrexer',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error('Unexpected PG pool error', err.message);
});

// --- Schema Initialization ---
const initDb = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Users
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        google_id TEXT UNIQUE,
        email TEXT UNIQUE,
        balance INTEGER DEFAULT 0,
        reserved_balance INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // API Keys (hashed storage)
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        name TEXT DEFAULT 'default',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Plans
    await client.query(`
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        name TEXT,
        cpu TEXT,
        cpu_request TEXT,
        memory TEXT,
        memory_request TEXT,
        price_per_hour INTEGER
      )
    `);

    // Transactions
    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id),
        amount INTEGER,
        type TEXT,
        status TEXT DEFAULT 'success',
        external_id TEXT,
        metadata TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Apps
    await client.query(`
      CREATE TABLE IF NOT EXISTS apps (
        id TEXT PRIMARY KEY,
        name TEXT,
        user_id TEXT REFERENCES users(id),
        plan_id TEXT REFERENCES plans(id),
        namespace TEXT NOT NULL,
        image TEXT NOT NULL,
        url TEXT NOT NULL,
        container_port INTEGER,
        env TEXT,
        command TEXT,
        args TEXT,
        hourly_rate INTEGER DEFAULT 0,
        status TEXT DEFAULT 'stopped',
        started_at BIGINT DEFAULT 0,
        last_billed_at BIGINT DEFAULT 0,
        reserved_amount INTEGER DEFAULT 0,
        total_charged INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_charged_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Seed plans (upsert)
    const upsertPlan = `
      INSERT INTO plans (id, name, cpu, cpu_request, memory, memory_request, price_per_hour)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        cpu = EXCLUDED.cpu,
        cpu_request = EXCLUDED.cpu_request,
        memory = EXCLUDED.memory,
        memory_request = EXCLUDED.memory_request,
        price_per_hour = EXCLUDED.price_per_hour
    `;
    await client.query(upsertPlan, ['p-tiny', 'Tiny (Free)', '25m', '3m', '64Mi', '10Mi', 0]);
    await client.query(upsertPlan, ['p-small', 'Small', '100m', '10m', '128Mi', '20Mi', 14]);
    await client.query(upsertPlan, ['p-basic', 'Basic', '250m', '25m', '256Mi', '38Mi', 25]);
    await client.query(upsertPlan, ['p-medium', 'Medium', '500m', '50m', '512Mi', '77Mi', 35]);
    await client.query(upsertPlan, ['p-large', 'Large', '1000m', '100m', '1024Mi', '154Mi', 69]);
    await client.query(upsertPlan, ['p-xlarge', 'XLarge', '2000m', '200m', '2048Mi', '307Mi', 139]);

    // Sync existing apps to new pricing
    await client.query(`
      UPDATE apps
      SET hourly_rate = plans.price_per_hour
      FROM plans
      WHERE apps.plan_id = plans.id
      AND apps.hourly_rate != plans.price_per_hour
    `);

    await client.query('COMMIT');
    logger.info('✅ PostgreSQL schema initialized and plans seeded.');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('❌ Failed to initialize database schema:', err.message);
    throw err;
  } finally {
    client.release();
  }
};

// --- Helper: wraps pool.query for convenience ---
const db = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  pool,
  initDb,
};

export default db;
