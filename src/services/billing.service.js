import db from '../db/db.js';
import logger from '../utils/logger.js';
import { killAppCompletely } from './app.service.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Starts billing for a pod.
 * Deducts 1 hour cost as reserve (in Paise).
 */
export const startPodBilling = async (podId, userId, hourlyRatePaise) => {
    const now = Math.floor(Date.now() / 1000);
    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        const { rows } = await client.query('SELECT balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const user = rows[0];
        if (!user || user.balance < hourlyRatePaise) {
            throw new Error('Insufficient balance to start pod. Minimum 1 hour credit required.');
        }

        // Deduct from balance, add to reserved
        await client.query(
            'UPDATE users SET balance = balance - $1, reserved_balance = reserved_balance + $2 WHERE id = $3',
            [hourlyRatePaise, hourlyRatePaise, userId]
        );

        // Log initial reservation in history
        await client.query(
            'INSERT INTO transactions (id, user_id, amount, type, status) VALUES ($1, $2, $3, $4, $5)',
            [uuidv4(), userId, -hourlyRatePaise, 'reservation', 'success']
        );

        // Update app record
        await client.query(`
            UPDATE apps SET 
                hourly_rate = $1,
                status = 'running',
                started_at = $2,
                last_billed_at = $3,
                reserved_amount = $4,
                total_charged = 0
            WHERE id = $5
        `, [hourlyRatePaise, now, now, hourlyRatePaise, podId]);

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
};

/**
 * Stops billing for a pod.
 * Refunds remaining reserved amount (in Paise).
 */
export const stopPodBilling = async (podId) => {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const { rows } = await client.query(
            'SELECT user_id, reserved_amount, total_charged, name, started_at FROM apps WHERE id = $1',
            [podId]
        );
        const app = rows[0];
        if (!app) {
            await client.query('COMMIT');
            return;
        }

        // Refund reserved amount to balance (if any)
        if (app.reserved_amount > 0) {
            await client.query(
                'UPDATE users SET balance = balance + $1, reserved_balance = reserved_balance - $2 WHERE id = $3',
                [app.reserved_amount, app.reserved_amount, app.user_id]
            );

            // Log refund in history
            await client.query(
                'INSERT INTO transactions (id, user_id, amount, type, status, external_id) VALUES ($1, $2, $3, $4, $5, $6)',
                [uuidv4(), app.user_id, app.reserved_amount, 'refund', 'success', `Refund: ${app.name}`]
            );
        }

        // Log the FINAL USAGE SUMMARY
        if (app.total_charged > 0) {
            const now = Math.floor(Date.now() / 1000);
            const durationSeconds = now - app.started_at;
            const metadata = JSON.stringify({ duration: durationSeconds });

            await client.query(
                'INSERT INTO transactions (id, user_id, amount, type, status, external_id, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [uuidv4(), app.user_id, -app.total_charged, 'pod_burn_receipt', 'success', app.name, metadata]
            );
        }

        // Reset app billing fields
        await client.query(
            "UPDATE apps SET status = 'stopped', reserved_amount = 0 WHERE id = $1",
            [podId]
        );

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        logger.error('stopPodBilling error:', err.message);
    } finally {
        client.release();
    }
};

/**
 * Global billing loop.
 * Runs every 10 seconds.
 */
export const runBillingLoop = async () => {
    const now = Math.floor(Date.now() / 1000);
    const { rows: apps } = await db.query("SELECT id FROM apps WHERE status = 'running' FOR UPDATE SKIP LOCKED");

    for (const app of apps) {
        try {
            let shouldKill = false;
            const client = await db.getClient();

            try {
                await client.query('BEGIN');

                // 1. RE-FETCH inside transaction to avoid race conditions
                const { rows } = await client.query(
                    "SELECT * FROM apps WHERE id = $1 AND status = 'running' FOR UPDATE",
                    [app.id]
                );
                const currentApp = rows[0];
                if (!currentApp) {
                    await client.query('COMMIT');
                    continue;
                }

                const elapsedSeconds = now - currentApp.last_billed_at;
                if (elapsedSeconds <= 0) {
                    await client.query('COMMIT');
                    continue;
                }

                // 2. Handle Free Apps (0 rate)
                if (currentApp.hourly_rate <= 0) {
                    await client.query('UPDATE apps SET last_billed_at = $1 WHERE id = $2', [now, currentApp.id]);
                    await client.query('COMMIT');
                    continue;
                }

                const costFloat = (currentApp.hourly_rate * elapsedSeconds) / 3600;

                // 3. Only charge if we have accumulated at least 1 Paise of cost
                if (costFloat < 1) {
                    await client.query('COMMIT');
                    continue;
                }

                const cost = Math.floor(costFloat);

                // 4. PRECISION FIX
                const secondsCharged = Math.floor((cost * 3600) / currentApp.hourly_rate);
                const actualLastBilledAt = Number(currentApp.last_billed_at) + secondsCharged;

                let currentReserved = currentApp.reserved_amount;

                // 5. Deduct the cost from the reserve
                if (cost > 0) {
                    const reserveDeduction = Math.min(cost, currentApp.reserved_amount);
                    const overflow = cost - reserveDeduction;
                    currentReserved = Math.max(0, currentApp.reserved_amount - cost);

                    if (reserveDeduction > 0) {
                        await client.query(
                            'UPDATE users SET reserved_balance = GREATEST(0, reserved_balance - $1) WHERE id = $2',
                            [reserveDeduction, currentApp.user_id]
                        );
                    }

                    if (overflow > 0) {
                        await client.query(
                            'UPDATE users SET balance = GREATEST(0, balance - $1) WHERE id = $2',
                            [overflow, currentApp.user_id]
                        );
                    }
                }

                // 6. Proactive Re-reservation
                const tenMinsCost = Math.ceil(currentApp.hourly_rate / 6);
                if (currentReserved < tenMinsCost) {
                    const topupAmount = Math.max(tenMinsCost, currentApp.hourly_rate);
                    const { rows: userRows } = await client.query(
                        'SELECT balance FROM users WHERE id = $1',
                        [currentApp.user_id]
                    );
                    const user = userRows[0];

                    if (user && user.balance >= topupAmount) {
                        await client.query(
                            'UPDATE users SET balance = balance - $1, reserved_balance = reserved_balance + $2 WHERE id = $3',
                            [topupAmount, topupAmount, currentApp.user_id]
                        );
                        currentReserved += topupAmount;
                        logger.info(`Auto-reserved for app ${currentApp.id} (+${topupAmount} paise)`);
                    } else if (currentReserved <= 0) {
                        shouldKill = true;
                    }
                }

                // 7. Update app billing state
                await client.query(`
                    UPDATE apps SET 
                        reserved_amount = $1,
                        total_charged = total_charged + $2,
                        last_billed_at = $3
                    WHERE id = $4
                `, [currentReserved, cost, actualLastBilledAt, currentApp.id]);

                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }

            if (shouldKill) {
                logger.warn(`App ${app.id} stopped due to insufficient balance`);
                const { rows } = await db.query('SELECT * FROM apps WHERE id = $1', [app.id]);
                const fullApp = rows[0];
                if (fullApp) {
                    await killAppCompletely(fullApp);
                }
            }
        } catch (err) {
            logger.error(`Error billing app ${app.id}:`, err);
        }
    }
};

export const startBillingCron = () => {
    logger.info('Starting per-10-seconds integer billing cycle...');
    setInterval(() => {
        runBillingLoop().catch(err => logger.error('Billing loop error:', err));
    }, 10000);
};
