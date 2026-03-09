import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redis } from '../lib/redis.js';

// Global rate limiter — 120 requests/minute per IP, shared across all pods via Redis
export const rateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({
    sendCommand: (...args) => redis.call(...args),
    prefix: 'rl:global:',
  }),
  handler: (_req, res) => {
    res.status(429).json({
      error: 'Rate limit exceeded',
      limit: 120,
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
