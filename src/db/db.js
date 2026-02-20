import pg from 'pg';
import logger from '../utils/logger.js';

if (!process.env.DATABASE_URL) {
  console.warn('WARNING: DATABASE_URL not set, using default local connection string');
}

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
        price_per_hour INTEGER,
        storage TEXT,
        runtime TEXT DEFAULT 'runc'
      )
    `);

    // ... (rest of Transactions remains same) ...

    // Apps (Unified for Apps and Databases)
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
        storage_hourly_rate INTEGER DEFAULT 0,
        status TEXT DEFAULT 'stopped',
        started_at BIGINT DEFAULT 0,
        last_billed_at BIGINT DEFAULT 0,
        reserved_amount INTEGER DEFAULT 0,
        total_charged INTEGER DEFAULT 0,
        type VARCHAR(20) DEFAULT 'app',
        storage TEXT,
        db_host TEXT,
        db_port INTEGER,
        db_user TEXT,
        db_password TEXT,
        db_name TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_charged_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Add missing columns to existing tables (for safe migrations)
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE plans ADD COLUMN IF NOT EXISTS storage TEXT;
        ALTER TABLE apps ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'app';
        ALTER TABLE apps ADD COLUMN IF NOT EXISTS storage TEXT;
        ALTER TABLE apps ADD COLUMN IF NOT EXISTS db_host TEXT;
        ALTER TABLE apps ADD COLUMN IF NOT EXISTS db_port INTEGER;
        ALTER TABLE apps ADD COLUMN IF NOT EXISTS db_user TEXT;
        ALTER TABLE apps ADD COLUMN IF NOT EXISTS db_password TEXT;
        ALTER TABLE apps ADD COLUMN IF NOT EXISTS db_name TEXT;
        ALTER TABLE apps ADD COLUMN IF NOT EXISTS storage_hourly_rate INTEGER DEFAULT 0;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);

    // Seed plans (upsert)
    const upsertPlan = `
      INSERT INTO plans (id, name, cpu, cpu_request, memory, memory_request, price_per_hour, storage)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        cpu = EXCLUDED.cpu,
        cpu_request = EXCLUDED.cpu_request,
        memory = EXCLUDED.memory,
        memory_request = EXCLUDED.memory_request,
        price_per_hour = EXCLUDED.price_per_hour,
        storage = EXCLUDED.storage
    `;
    await client.query(upsertPlan, ['p-tiny', 'Tiny (Free)', '25m', '3m', '64Mi', '10Mi', 0, null]);
    await client.query(upsertPlan, ['p-small', 'Small', '100m', '10m', '128Mi', '20Mi', 14, null]);
    await client.query(upsertPlan, ['p-basic', 'Basic', '250m', '25m', '256Mi', '38Mi', 25, null]);
    await client.query(upsertPlan, ['p-medium', 'Medium', '500m', '50m', '512Mi', '77Mi', 35, null]);
    await client.query(upsertPlan, ['p-large', 'Large', '1000m', '100m', '1024Mi', '154Mi', 69, null]);
    await client.query(upsertPlan, ['p-xlarge', 'XLarge', '2000m', '200m', '2048Mi', '307Mi', 139, null]);

    // Managed Database Plans (Pod price = App Plan * 1.6, Storage = 2 paise/GB)

    await client.query(upsertPlan, ['db-small', 'DB Small', '250m', '50m', '512Mi', '128Mi', 40, '5Gi']);
    await client.query(upsertPlan, ['db-medium', 'DB Medium', '500m', '100m', '512Mi', '256Mi', 56, '10Gi']);
    await client.query(upsertPlan, ['db-large', 'DB Large', '700m', '200m', '1024Mi', '512Mi', 75, '20Gi']);

    // Add runtime column if missing 
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE plans ADD COLUMN IF NOT EXISTS runtime TEXT DEFAULT 'runc';
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);

    // Kata Container plans (Coming Soon)
    await client.query(upsertPlan, ['p-kata-small', 'Kata Small', '100m', '20m', '128Mi', '32Mi', 28, null]);
    await client.query(upsertPlan, ['p-kata-medium', 'Kata Medium', '500m', '100m', '512Mi', '128Mi', 69, null]);
    await client.query(upsertPlan, ['p-kata-large', 'Kata Large', '1000m', '200m', '1024Mi', '256Mi', 139, null]);
    await client.query(`UPDATE plans SET runtime = 'kata' WHERE id IN ('p-kata-small', 'p-kata-medium', 'p-kata-large')`);

    // Sync existing apps to new pricing
    await client.query(`
      UPDATE apps
      SET hourly_rate = plans.price_per_hour,
          storage_hourly_rate = CASE 
            WHEN apps.type = 'database' THEN CAST(REPLACE(plans.storage, 'Gi', '') AS INTEGER) * 2 
            ELSE 0 
          END
      FROM plans
      WHERE apps.plan_id = plans.id
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
