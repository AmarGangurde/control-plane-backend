import logger from './logger.js';

/**
 * Retries an async function with exponential backoff.
 *
 * @param {() => Promise<any>} fn - The async function to retry
 * @param {object} opts
 * @param {number} opts.retries     - Max retry attempts (default: 3)
 * @param {number} opts.delayMs     - Initial delay in ms (default: 300)
 * @param {number} opts.factor      - Backoff multiplier (default: 2)
 * @param {string} opts.label       - Label for log output
 * @param {(err: Error) => boolean} opts.retryIf - Optional predicate — skip retry if false
 */
export const withRetry = async (fn, {
    retries = 3,
    delayMs = 300,
    factor = 2,
    label = 'operation',
    retryIf = () => true,
} = {}) => {
    let attempt = 0;
    let delay = delayMs;

    while (true) {
        try {
            return await fn();
        } catch (err) {
            attempt++;
            // Don't retry 404s, 409s (Conflict/Already Exists), or 400s
            const code = err?.body?.code || err?.response?.statusCode;
            const isClientError = code && code >= 400 && code < 500 && code !== 429;
            if (attempt > retries || isClientError || !retryIf(err)) {
                throw err;
            }
            logger.warn(`${label} failed (attempt ${attempt}/${retries}), retrying in ${delay}ms`, {
                err: err.message,
                code,
            });
            await new Promise(r => setTimeout(r, delay));
            delay *= factor;
        }
    }
};
