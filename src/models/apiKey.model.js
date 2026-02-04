import db from '../db/db.js';
import crypto from 'crypto';

export const createApiKey = (name = 'default') => {
  const key = `sk_live_${crypto.randomBytes(24).toString('hex')}`;

  db.prepare(`
    INSERT INTO api_keys (key, name)
    VALUES (?, ?)
  `).run(key, name);

  return key;
};

export const listApiKeys = () => {
  return db.prepare(`
    SELECT key, name, created_at
    FROM api_keys
    ORDER BY created_at DESC
  `).all();
};

export const deleteApiKey = (key) => {
  db.prepare(`
    DELETE FROM api_keys WHERE key = ?
  `).run(key);
};

export const getApiKey = (key) => {
  return db.prepare(`
    SELECT * FROM api_keys WHERE key = ?
  `).get(key);
};

export const getApiKeyByName = (name) => {
  return db.prepare(`
    SELECT * FROM api_keys WHERE name = ?
  `).get(name);
};
