import { listAllApiKeys } from '../models/apiKey.model.js';

// Admin-only: list all API keys (only prefixes, never full keys)
export const listApiKeys = async (req, res) => {
  try {
    const keys = await listAllApiKeys();
    res.json(keys);
  } catch (err) {
    console.error('listApiKeys error', err);
    res.status(500).json({ error: 'failed to list api keys' });
  }
};
