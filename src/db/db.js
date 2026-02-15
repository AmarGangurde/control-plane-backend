import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Resolve data directory relative to this file to avoid depending on process.cwd()
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

const dbPath = path.join(dataDir, 'apps.db');
const db = new Database(dbPath);

// api keys (legacy, keeping for simple auth scenarios if needed, or link to user)
db.prepare(`
  CREATE TABLE IF NOT EXISTS api_keys (
    key TEXT PRIMARY KEY,
    name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

// users
db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_id TEXT UNIQUE,
    email TEXT UNIQUE,
    balance INTEGER DEFAULT 0,
    reserved_balance INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

try {
  db.prepare('ALTER TABLE users ADD COLUMN reserved_balance INTEGER DEFAULT 0').run();
} catch (e) { }

// plans
db.prepare(`
  CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    name TEXT,
    cpu TEXT,
    cpu_request TEXT,
    memory TEXT,
    memory_request TEXT,
    price_per_hour INTEGER
  )
`).run();

// Migration: Ensure new columns exist
try {
  db.prepare('ALTER TABLE plans ADD COLUMN cpu_request TEXT').run();
} catch (e) { }
try {
  db.prepare('ALTER TABLE plans ADD COLUMN memory_request TEXT').run();
} catch (e) { }
// Migration: rename cpu_limit to cpu if needed (fresh installs use 'cpu' now)
try {
  db.prepare('ALTER TABLE plans ADD COLUMN cpu TEXT').run();
} catch (e) { }

// Insert/Update default plans
// Limit: What the user is "sold". Request: What the k8s scheduler sees (oversubscription).
const insertPlan = db.prepare('INSERT OR REPLACE INTO plans (id, name, cpu, cpu_request, memory, memory_request, price_per_hour) VALUES (?, ?, ?, ?, ?, ?, ?)');
insertPlan.run('p-tiny', 'Tiny (Free)', '25m', '5m', '64Mi', '32Mi', 0);
insertPlan.run('p-small', 'Small', '100m', '10m', '128Mi', '64Mi', 50); // 0.50 INR
insertPlan.run('p-medium', 'Medium', '500m', '50m', '512Mi', '128Mi', 200); // 2.00 INR
insertPlan.run('p-large', 'Large', '1000m', '100m', '1024Mi', '256Mi', 400); // 4.00 INR


// transactions
db.prepare(`
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    amount INTEGER,
    type TEXT,
    status TEXT DEFAULT 'success',
    external_id TEXT,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`).run();

// Migration: Add columns to transactions if they don't exist
try {
  db.prepare('ALTER TABLE transactions ADD COLUMN status TEXT DEFAULT "success"').run();
} catch (e) { }
try {
  db.prepare('ALTER TABLE transactions ADD COLUMN external_id TEXT').run();
} catch (e) { }
try {
  db.prepare('ALTER TABLE transactions ADD COLUMN metadata TEXT').run();
} catch (e) { }

// apps
db.prepare(`
  CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY,
    name TEXT,
    user_id TEXT,
    plan_id TEXT,
    namespace TEXT NOT NULL,
    image TEXT NOT NULL,
    url TEXT NOT NULL,
    container_port INTEGER,
    env TEXT, -- JSON string
    command TEXT, -- JSON string
    args TEXT, -- JSON string
    api_key TEXT,
    hourly_rate INTEGER DEFAULT 0,
    status TEXT DEFAULT 'stopped',
    started_at INTEGER DEFAULT 0,
    last_billed_at INTEGER DEFAULT 0,
    reserved_amount INTEGER DEFAULT 0,
    total_charged INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_charged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (plan_id) REFERENCES plans(id)
  )
`).run();

try {
  db.prepare('ALTER TABLE apps ADD COLUMN hourly_rate REAL DEFAULT 0').run();
} catch (e) { }
try {
  db.prepare('ALTER TABLE apps ADD COLUMN status TEXT DEFAULT "stopped"').run();
} catch (e) { }
try {
  db.prepare('ALTER TABLE apps ADD COLUMN started_at INTEGER DEFAULT 0').run();
} catch (e) { }
try {
  db.prepare('ALTER TABLE apps ADD COLUMN last_billed_at INTEGER DEFAULT 0').run();
} catch (e) { }
try {
  db.prepare('ALTER TABLE apps ADD COLUMN reserved_amount REAL DEFAULT 0').run();
} catch (e) { }
try {
  db.prepare('ALTER TABLE apps ADD COLUMN total_charged REAL DEFAULT 0').run();
} catch (e) { }

// Migration: Ensure new columns exist
try {
  db.prepare('ALTER TABLE apps ADD COLUMN env TEXT').run();
} catch (e) { }
try {
  db.prepare('ALTER TABLE apps ADD COLUMN command TEXT').run();
} catch (e) { }
try {
  db.prepare('ALTER TABLE apps ADD COLUMN args TEXT').run();
} catch (e) { }

// Migration: Ensure container_port exists
try {
  db.prepare('ALTER TABLE apps ADD COLUMN container_port INTEGER').run();
} catch (e) { }

// Migration: Ensure last_charged_at and name exists for existing apps
try {
  db.prepare('ALTER TABLE apps ADD COLUMN last_charged_at DATETIME DEFAULT CURRENT_TIMESTAMP').run();
} catch (e) { }

try {
  db.prepare('ALTER TABLE apps ADD COLUMN name TEXT').run();
} catch (e) { }

export default db;
