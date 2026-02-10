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
    balance REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

// plans
db.prepare(`
  CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    name TEXT,
    cpu TEXT,
    memory TEXT,
    price_per_hour REAL
  )
`).run();

// Migration: Change price_per_hour to REAL if it's currently INTEGER
try {
  // SQLite doesn't support changing column type directly easily with ALTER, 
  // but better-sqlite3 treats REAL/INTEGER reasonably. 
  // We'll just ensure our new inserts use the REAL values.
} catch (e) { }

// Insert/Update default plans
const insertPlan = db.prepare('INSERT OR REPLACE INTO plans (id, name, cpu, memory, price_per_hour) VALUES (?, ?, ?, ?, ?)');
insertPlan.run('p-tiny', 'Tiny (Free)', '50m', '64Mi', 0);
insertPlan.run('p-small', 'Small', '100m', '128Mi', 0.25);
insertPlan.run('p-medium', 'Medium', '500m', '512Mi', 0.5);
insertPlan.run('p-large', 'Large', '1000m', '1024Mi', 1.0);


// transactions
db.prepare(`
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    amount INTEGER,
    type TEXT,
    status TEXT DEFAULT 'success',
    external_id TEXT,
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
    api_key TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_charged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (plan_id) REFERENCES plans(id)
  )
`).run();

// Migration: Ensure last_charged_at and name exists for existing apps
try {
  db.prepare('ALTER TABLE apps ADD COLUMN last_charged_at DATETIME DEFAULT CURRENT_TIMESTAMP').run();
} catch (e) { }

try {
  db.prepare('ALTER TABLE apps ADD COLUMN name TEXT').run();
} catch (e) { }

export default db;
