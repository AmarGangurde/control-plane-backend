import { getApiKey } from '../models/apiKey.model.js';
import { getUserByEmail } from '../models/user.model.js';

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

  // The 'name' of the key is the email address in our current flow
  const user = getUserByEmail(keyRecord.name);

  if (!user) {
    // Edge case if user table was cleared but keys remain, or legacy keys
    return res.status(401).json({ error: 'user not found' });
  }

  req.apiKey = apiKey;
  req.user = user;
  next();
};
