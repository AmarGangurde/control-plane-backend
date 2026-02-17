import db from '../db/db.js';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

/**
 * Hashes an API key using SHA-256 for secure storage.
 * The raw key is NEVER stored in the database.
 */
export const hashApiKey = (rawKey) => {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
};

/**
 * Creates a new API key for a user.
 * - Deletes any existing key for that user (1 key per user policy).
 * - Returns the RAW key (shown once to the user). Only the hash is stored.
 */
export const createApiKeyForUser = async (userId, name = 'default') => {
  const rawKey = `sk_live_${crypto.randomBytes(24).toString('hex')}`;
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = rawKey.substring(0, 12); // "sk_live_XXXX" — safe to store for display
  const id = uuidv4();

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // Remove any existing key for this user (1 active key policy)
    await client.query('DELETE FROM api_keys WHERE user_id = $1', [userId]);
    // Insert new key
    await client.query(
      'INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name) VALUES ($1, $2, $3, $4, $5)',
      [id, userId, keyHash, keyPrefix, name]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { rawKey, keyPrefix };
};

/**
 * Verifies a raw API key and returns the associated user_id if valid.
 */
export const verifyApiKey = async (rawKey) => {
  const keyHash = hashApiKey(rawKey);
  const { rows } = await db.query(
    'SELECT user_id FROM api_keys WHERE key_hash = $1',
    [keyHash]
  );
  return rows[0] || null;
};

/**
 * Gets key info for a user (prefix only, never full key).
 */
export const getApiKeyInfoForUser = async (userId) => {
  const { rows } = await db.query(
    'SELECT id, key_prefix, name, created_at FROM api_keys WHERE user_id = $1',
    [userId]
  );
  return rows[0] || null;
};

/**
 * Deletes a user's API key.
 */
export const deleteApiKeyForUser = async (userId) => {
  await db.query('DELETE FROM api_keys WHERE user_id = $1', [userId]);
};

// --- Legacy support for admin key routes (list all) ---
export const listAllApiKeys = async () => {
  const { rows } = await db.query(
    'SELECT ak.id, ak.key_prefix, ak.name, ak.created_at, u.email FROM api_keys ak JOIN users u ON ak.user_id = u.id ORDER BY ak.created_at DESC'
  );
  return rows;
};
