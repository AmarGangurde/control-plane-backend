const WINDOW_MS = 60 * 1000; // 1 minute

const LIMITS = {
  admin: 1000,
  user: 100
};

// key -> { count, windowStart }
const buckets = new Map();

export const rateLimit = (type = 'user') => {
  const limit = LIMITS[type];

  return (req, res, next) => {
    const key =
      type === 'admin'
        ? req.headers.authorization || 'admin'
        : req.apiKey;

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

    if (bucket.count >= limit) {
      return res.status(429).json({
        error: 'rate limit exceeded',
        limit,
        window: '1 minute'
      });
    }

    bucket.count++;
    next();
  };
};
