import { randomUUID } from 'crypto';
import { requestContext } from '../utils/logger.js';

/**
 * Assigns a unique request ID to every incoming HTTP request.
 * - Reads X-Request-ID header if present (allows clients / upstreams to correlate)
 * - Otherwise generates a new UUID
 * - Injects the ID into AsyncLocalStorage so logger.js picks it up automatically
 * - Reflects the ID back as X-Request-ID response header
 */
export const requestId = (req, res, next) => {
    const id = req.headers['x-request-id'] || randomUUID();
    res.setHeader('X-Request-ID', id);
    // Run the rest of the request lifecycle inside the async context
    requestContext.run({ requestId: id }, next);
};
