import jwt from 'jsonwebtoken';
import { getUserById } from '../models/user.model.js';
import { verifyApiKey } from '../models/apiKey.model.js';

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET environment variable is not set!');
  process.exit(1);
}

/**
 * Signs a JWT for a user.
 */
export const signJwt = (userId, email) => {
  return jwt.sign({ sub: userId, email }, JWT_SECRET, { expiresIn: '7d' });
};

/**
 * Middleware: Authenticates via JWT cookie (browser sessions)
 * OR via Bearer API key (programmatic access).
 * 
 * Priority: Cookie > Bearer token
 */
export const requireAuth = async (req, res, next) => {
  try {
    // 1. Try JWT from HttpOnly cookie
    const token = req.cookies?.session;
    if (token) {
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        const user = await getUserById(payload.sub);
        if (user) {
          req.user = user;
          req.authMethod = 'jwt';
          return next();
        }
      } catch (jwtErr) {
        // Token expired or invalid — fall through to API key check
      }
    }

    // 2. Try API key from Authorization header
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
      const rawKey = header.replace('Bearer ', '').trim();
      const keyRecord = await verifyApiKey(rawKey);
      if (keyRecord) {
        const user = await getUserById(keyRecord.user_id);
        if (user) {
          req.user = user;
          req.authMethod = 'apikey';
          return next();
        }
      }
    }

    return res.status(401).json({ error: 'Authentication required. Provide a valid session cookie or API key.' });
  } catch (err) {
    console.error('Auth middleware error:', err.message);
    return res.status(500).json({ error: 'Internal authentication error' });
  }
};
