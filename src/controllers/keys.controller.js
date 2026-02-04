import {
  createApiKey,
  listApiKeys,
  deleteApiKey
} from '../models/apiKey.model.js';

export const createKey = (req, res) => {
  const { name } = req.body;
  const key = createApiKey(name || 'default');

  res.status(201).json({
    key,          // shown ONLY once
    name
  });
};

export const listKeys = (_req, res) => {
  const keys = listApiKeys().map(k => ({
    ...k,
    key: k.key.slice(0, 8) + '********' // mask
  }));

  res.json(keys);
};

export const revokeKey = (req, res) => {
  deleteApiKey(req.params.key);
  res.json({ revoked: true });
};

export const listFullKeys = (_req, res) => {
  const keys = listApiKeys();
  res.json(keys);
};
