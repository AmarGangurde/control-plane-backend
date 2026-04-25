import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redis } from '../lib/redis.js';

// Global rate limiter — 300 requests/minute per AUTHENTICATED USER, shared across all pods via Redis.
// Keying by user ID (not IP) prevents multi-tenant cross-contamination where multiple
// tenants behind the same NAT/proxy would otherwise share a single quota bucket.
// Falls back to IP for unauthenticated requests (login, public endpoints).
export const rateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // req.user is populated by the auth middleware for authenticated routes
    return req.user?.id ? `user:${req.user.id}` : req.ip;
  },
  store: new RedisStore({
    sendCommand: (...args) => redis.call(...args),
    prefix: 'rl:global:',
  }),
  handler: (_req, res) => {
    res.status(429).json({
      error: 'Rate limit exceeded',
      limit: 300,
      window: '1 minute',
    });
  },
});

// Strict limiter for /api/contact — 3 submissions per IP per 10 minutes
export const contactRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({
    sendCommand: (...args) => redis.call(...args),
    prefix: 'rl:contact:',
  }),
  handler: (_req, res) => {
    res.status(429).json({
      error: 'Too many contact submissions. Please wait 10 minutes before trying again.',
      limit: 3,
      window: '10 minutes',
    });
  },
});
