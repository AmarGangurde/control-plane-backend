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
const initDb = async (retries = 5) => {
  while (retries > 0) {
    try {
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
        docker_username TEXT,
        docker_token TEXT,
        github_id TEXT UNIQUE,
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

        // Transactions
        await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        amount INTEGER NOT NULL,
        type TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        external_id TEXT,
        metadata TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

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
        replicas INTEGER DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_charged_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

        // Contact Messages
        await client.query(`
          CREATE TABLE IF NOT EXISTS contact_messages (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL,
            subject TEXT,
            message TEXT NOT NULL,
            status TEXT DEFAULT 'new',
            ip_address TEXT,
            user_agent TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            resolved_at TIMESTAMPTZ
          )
        `);

        // Support Tickets
        await client.query(`
          CREATE TABLE IF NOT EXISTS tickets (
            id TEXT PRIMARY KEY,
            user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
            subject TEXT NOT NULL,
            status TEXT DEFAULT 'open',
            priority TEXT DEFAULT 'normal',
            assigned_admin TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            closed_at TIMESTAMPTZ
          )
        `);

        // Ticket Messages
        await client.query(`
          CREATE TABLE IF NOT EXISTS ticket_messages (
            id TEXT PRIMARY KEY,
            ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE,
            sender_type TEXT NOT NULL,
            sender_id TEXT,
            message TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
          )
        `);

        // Indexes
        await client.query(`CREATE INDEX IF NOT EXISTS idx_contacts_created ON contact_messages(created_at DESC)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id)`);

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
        ALTER TABLE apps ADD COLUMN IF NOT EXISTS replicas INTEGER DEFAULT 1;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS docker_username TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS docker_token TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS github_id TEXT UNIQUE;
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
        await client.query(upsertPlan, ['p-tiny', 'Tiny (Free)', '100m', '15m', '128Mi', '64Mi', 0, null]);
        await client.query(upsertPlan, ['p-small', 'Small', '250m', '35m', '256Mi', '128Mi', 20, null]);
        await client.query(upsertPlan, ['p-basic', 'Basic', '500m', '70m', '512Mi', '256Mi', 39, null]);
        await client.query(upsertPlan, ['p-medium', 'Medium', '1000m', '140m', '1024Mi', '512Mi', 76, null]);
        await client.query(upsertPlan, ['p-large', 'Large', '2000m', '285m', '2048Mi', '1024Mi', 145, null]);
        await client.query(upsertPlan, ['p-xlarge', 'XLarge', '4000m', '570m', '4096Mi', '2048Mi', 275, null]);

        // Managed Database Plans (Pod price = App Plan * 1.6, Storage = 2 paise/GB)

        await client.query(upsertPlan, ['db-small', 'DB Small', '500m', '150m', '1024Mi', '768Mi', 47, '5Gi']);
        await client.query(upsertPlan, ['db-medium', 'DB Medium', '1000m', '300m', '2048Mi', '1536Mi', 80, '10Gi']);
        await client.query(upsertPlan, ['db-large', 'DB Large', '2000m', '600m', '4096Mi', '3072Mi', 150, '20Gi']);

        // Add runtime column if missing 
        await client.query(`
      DO $$ BEGIN
        ALTER TABLE plans ADD COLUMN IF NOT EXISTS runtime TEXT DEFAULT 'runc';
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);

        // Kata Container plans (Coming Soon)
        await client.query(upsertPlan, ['p-kata-small', 'Kata Small', '250m', '80m', '256Mi', '160Mi', 34, null]);
        await client.query(upsertPlan, ['p-kata-medium', 'Kata Medium', '1000m', '300m', '1024Mi', '640Mi', 104, null]);
        await client.query(upsertPlan, ['p-kata-large', 'Kata Large', '2000m', '600m', '2048Mi', '1280Mi', 208, null]);
        await client.query(`UPDATE plans SET runtime = 'kata' WHERE id IN ('p-kata-small', 'p-kata-medium', 'p-kata-large')`);

        // No migration needed for existing apps as per user request

        await client.query('COMMIT');
        logger.info('✅ PostgreSQL schema initialized and plans seeded.');
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error('❌ Failed to initialize database schema:', err.message);
        throw err;
      } finally {
        client.release();
      }
      return; // Success
    } catch (err) {
      retries--;
      logger.error(`Database initialization attempt failed. Retries left: ${retries}`, err.message);
      if (retries === 0) throw err;
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
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
