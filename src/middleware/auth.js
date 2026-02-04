import { getApiKey } from '../models/apiKey.model.js';

export const requireApiKey = (req, res, next) => {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing api key' });
  }

  const apiKey = header.replace('Bearer ', '').trim();
  const keyRecord = getApiKey(apiKey);

  if (!keyRecord) {
    return res.status(401).json({ error: 'invalid api key' });
  }

  req.apiKey = apiKey;
  next();
};
