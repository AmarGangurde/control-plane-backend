import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Two separate clients required by @socket.io/redis-adapter (pub + sub)
export const pubClient = new Redis(REDIS_URL);
export const subClient = pubClient.duplicate();

// General-purpose client for rate limiting, etc.
export const redis = new Redis(REDIS_URL);

// Log connection issues without crashing the process
for (const client of [pubClient, subClient, redis]) {
    client.on('error', (err) => {
        console.error('[Redis] Connection error:', err.message);
    });
}
