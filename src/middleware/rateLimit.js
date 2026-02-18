const WINDOW_MS = 60 * 1000; // 1 minute
const LIMIT = 120; // requests per minute per IP

// ip -> { count, windowStart }
const buckets = new Map();

export const rateLimiter = (req, res, next) => {
  const key = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket) {
    buckets.set(key, { count: 1, windowStart: now });
    return next();
  }

  if (now - bucket.windowStart > WINDOW_MS) {
    bucket.count = 1;
    bucket.windowStart = now;
    return next();
  }

  if (bucket.count >= LIMIT) {
    return res.status(429).json({
      error: 'rate limit exceeded',
      limit: LIMIT,
      window: '1 minute'
    });
  }

  bucket.count++;
  next();
};

// Memory protection: clean up stale IP buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of buckets.entries()) {
    if (now - bucket.windowStart > WINDOW_MS * 2) {
      buckets.delete(ip);
    }
  }
}, 300000);
