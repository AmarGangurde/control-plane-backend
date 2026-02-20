import db from '../db/db.js';
import logger from '../utils/logger.js';
import { killAppCompletely } from './app.service.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Starts billing for a pod.
 * Deducts 1 hour cost as reserve (in Paise).
 * @param {string} podId - The ID of the pod/app.
 * @param {string} userId - The ID of the user.
 * @param {number} hourlyRatePaise - The amount to reserve (deducted from balance).
 * @param {number} [hourlyRateToSet] - Optional rate to store in apps.hourly_rate (defaults to hourlyRatePaise).
 */
export const startPodBilling = async (podId, userId, hourlyRatePaise, hourlyRateToSet) => {
    const rateToSet = hourlyRateToSet !== undefined ? hourlyRateToSet : hourlyRatePaise;
    const now = Math.floor(Date.now() / 1000);
    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        // Fetch app to check existing reserve
        const { rows: appRows } = await client.query('SELECT name, type, reserved_amount FROM apps WHERE id = $1 FOR UPDATE', [podId]);
        const app = appRows[0];
        const existingReserve = Number(app?.reserved_amount || 0);

        // We only need to deduct the difference to hit the 1 hour target
        const amountToDeduct = Math.max(0, hourlyRatePaise - existingReserve);
        const newTotalReserve = Math.max(hourlyRatePaise, existingReserve);

        const { rows } = await client.query('SELECT balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const user = rows[0];

        if (amountToDeduct > 0) {
            if (!user || user.balance < amountToDeduct) {
                // Return exactly what we need for clear error messaging
                throw new Error(`Insufficient balance to start ${app?.type || 'pod'}. Need ₹${(amountToDeduct / 100).toFixed(2)} more for 1 hour reserve.`);
            }

            // Deduct from balance, add to reserved
            await client.query(
                'UPDATE users SET balance = balance - $1, reserved_balance = reserved_balance + $2 WHERE id = $3',
                [amountToDeduct, amountToDeduct, userId]
            );

            // Log initial reservation in history
            await client.query(
                'INSERT INTO transactions (id, user_id, amount, type, status, external_id, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [uuidv4(), userId, -amountToDeduct, 'reservation', 'success', app?.name || 'Resource', JSON.stringify({ type: app?.type || 'app' })]
            );
        }

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
        `, [rateToSet, now, now, newTotalReserve, podId]);

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
};

/**
 * Stops billing for a pod and settles the final fractional charge.
 * Retains storage reserve for databases unless isDestroying is true.
 */
export const stopPodBilling = async (podId, isDestroying = false) => {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const { rows } = await client.query(
            'SELECT * FROM apps WHERE id = $1 FOR UPDATE',
            [podId]
        );
        const app = rows[0];
        if (!app) {
            await client.query('COMMIT');
            return;
        }

        const now = Math.floor(Date.now() / 1000);

        // 1. Calculate and charge fractional cost since last_billed_at
        const elapsedSeconds = now - app.last_billed_at;
        let effectiveHourlyRate = 0;
        if (app.status === 'running') {
            effectiveHourlyRate += (app.hourly_rate || 0);
        }
        if (app.type === 'database') {
            effectiveHourlyRate += (app.storage_hourly_rate || 0);
        }

        let currentReserved = Number(app.reserved_amount || 0);
        let currentTotalCharged = Number(app.total_charged || 0);
        let actualLastBilledAt = app.last_billed_at;

        if (effectiveHourlyRate > 0 && elapsedSeconds > 0) {
            const costFloat = (effectiveHourlyRate * elapsedSeconds) / 3600;
            const cost = Math.floor(costFloat);

            if (cost > 0) {
                const secondsCharged = Math.floor((cost * 3600) / effectiveHourlyRate);
                actualLastBilledAt = Number(app.last_billed_at) + secondsCharged;

                const reserveDeduction = Math.min(cost, currentReserved);
                const overflow = cost - reserveDeduction;

                if (overflow > 0) {
                    await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [overflow, app.user_id]);
                }
                if (reserveDeduction > 0) {
                    currentReserved -= reserveDeduction;
                    await client.query('UPDATE users SET reserved_balance = reserved_balance - $1 WHERE id = $2', [reserveDeduction, app.user_id]);
                }

                currentTotalCharged += cost;
            } else {
                actualLastBilledAt = now;
            }
        }

        // 2. Determine target reserve
        let targetReserve = 0;
        if (app.type === 'database' && !isDestroying) {
            targetReserve = Number(app.storage_hourly_rate || 0);
        }

        // 3. Adjust reserves to meet target
        if (currentReserved > targetReserve) {
            const refundAmount = currentReserved - targetReserve;
            await client.query(
                'UPDATE users SET balance = balance + $1, reserved_balance = reserved_balance - $2 WHERE id = $3',
                [refundAmount, refundAmount, app.user_id]
            );

            // Log refund in history
            await client.query(
                'INSERT INTO transactions (id, user_id, amount, type, status, external_id, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [uuidv4(), app.user_id, refundAmount, 'refund', 'success', `Refund: ${app.name}`, JSON.stringify({ type: app.type })]
            );
            currentReserved = targetReserve;
        } else if (currentReserved < targetReserve) {
            // Take what we can to meet target (for storage)
            const amountNeeded = targetReserve - currentReserved;
            const { rows: uRows } = await client.query('SELECT balance FROM users WHERE id = $1', [app.user_id]);
            const userBal = uRows[0]?.balance || 0;
            const amountToTake = Math.min(amountNeeded, userBal);

            if (amountToTake > 0) {
                await client.query(
                    'UPDATE users SET balance = balance - $1, reserved_balance = reserved_balance + $2 WHERE id = $3',
                    [amountToTake, amountToTake, app.user_id]
                );
                currentReserved += amountToTake;
                logger.info(`Storage target reserve taken during stop for DB ${app.id} (+${amountToTake})`);
            }
        }

        // 4. Log the FINAL USAGE SUMMARY for compute
        if ((app.status === 'running' || isDestroying) && currentTotalCharged > 0) {
            const durationSeconds = now - app.started_at;
            const metadata = JSON.stringify({ duration: durationSeconds, type: app.type });

            await client.query(
                'INSERT INTO transactions (id, user_id, amount, type, status, external_id, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [uuidv4(), app.user_id, -currentTotalCharged, 'pod_burn_receipt', 'success', app.name, metadata]
            );
            currentTotalCharged = 0; // Reset after logging receipt
        }

        // 5. Update app billing state
        const newStatus = isDestroying ? 'deleted' : 'stopped';

        await client.query(
            "UPDATE apps SET status = $1, reserved_amount = $2, total_charged = $3, last_billed_at = $4 WHERE id = $5",
            [newStatus, currentReserved, currentTotalCharged, actualLastBilledAt, podId]
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
    // Select everything that needs billing: 
    // 1. Any 'running' pod (App or Database)
    // 2. Any 'database' that exists (not deleted) for storage billing
    const { rows: apps } = await db.query(`
        SELECT id FROM apps 
        WHERE status = 'running' 
        OR (type = 'database' AND status != 'deleted')
    `);

    for (const app of apps) {
        try {
            let shouldKill = false;
            const client = await db.getClient();

            try {
                await client.query('BEGIN');

                // 1. RE-FETCH inside transaction to avoid race conditions
                const { rows } = await client.query(
                    "SELECT * FROM apps WHERE id = $1 FOR UPDATE",
                    [app.id]
                );
                const currentApp = rows[0];

                // Skip if deleted or if it somehow doesn't match the billing criteria anymore
                if (!currentApp || currentApp.status === 'deleted') {
                    await client.query('COMMIT');
                    continue;
                }

                const elapsedSeconds = now - currentApp.last_billed_at;
                if (elapsedSeconds <= 0) {
                    await client.query('COMMIT');
                    continue;
                }

                // 2. Calculate Effective Hourly Rate
                // Pod rate is only active if 'running'
                const podRate = currentApp.status === 'running' ? (currentApp.hourly_rate || 0) : 0;
                // Storage rate is active for all non-deleted databases
                const storageRate = currentApp.type === 'database' ? (currentApp.storage_hourly_rate || 0) : 0;

                const effectiveHourlyRate = podRate + storageRate;

                // 3. Handle Free/No-cost resources
                if (effectiveHourlyRate <= 0) {
                    await client.query('UPDATE apps SET last_billed_at = $1 WHERE id = $2', [now, currentApp.id]);
                    await client.query('COMMIT');
                    continue;
                }

                const costFloat = (effectiveHourlyRate * elapsedSeconds) / 3600;

                // 4. Only charge if we have accumulated at least 1 Paise of cost
                if (costFloat < 1) {
                    await client.query('COMMIT');
                    continue;
                }

                const cost = Math.floor(costFloat);

                // 5. PRECISION FIX: Only advance time for the exact amount we charged
                const secondsCharged = Math.floor((cost * 3600) / effectiveHourlyRate);
                const actualLastBilledAt = Number(currentApp.last_billed_at) + secondsCharged;

                let currentReserved = currentApp.reserved_amount;

                // 6. Deduct the cost from the reserve and/or main balance
                if (cost > 0) {
                    const reserveDeduction = Math.min(cost, currentApp.reserved_amount);
                    const overflow = cost - reserveDeduction;

                    let userBalance = 0;
                    if (overflow > 0) {
                        const { rows: uRows } = await client.query('SELECT balance FROM users WHERE id = $1', [currentApp.user_id]);
                        if (uRows.length > 0) userBalance = uRows[0].balance;

                        if (userBalance < overflow) {
                            // INSUFFICIENT FUNDS for the *past* interval
                            // We cannot pay for the time already used.
                            // Action: Do NOT update 'last_billed_at'. Let debt accumulate.

                            if (currentApp.status === 'running') {
                                logger.info(`Insufficient funds for running app ${currentApp.id}. Killing.`);
                                shouldKill = true;
                                // We must execute kill logic here or set flag? 
                                // If we continue, we skip the `if (shouldKill)` at end of loop?
                                // Yes because of `continue`.
                                // But `shouldKill` is processed outside `try/finally`? 
                                // No, `shouldKill` is processed AFTER `finally`, but INSIDE the `for` loop.
                                // If we `continue`, we skip to next loop iteration immediately.
                                // So we MUST kill here or ensure we reach the end.
                                // BUT we don't want to update DB.

                                // We'll just rely on the next loop iteration finding it 'stopped'? 
                                // No, we need to stop it now.
                                // Calling killAppCompletely needs to happen outside transaction ideally.
                            } else {
                                logger.warn(`Storage Grace Period (Debt): User ${currentApp.user_id} DB ${currentApp.id} skipped billing (Gap: ${elapsedSeconds}s).`);
                            }

                            // Commit empty transaction to release lock
                            await client.query('COMMIT');

                            // If we need to kill, do it now (async but fire-and-forget or awaited)
                            if (shouldKill) {
                                // We need to import killAppCompletely or it's available in scope?
                                // It is likely available in scope (used at line 313).
                                // We need the full app object. `currentApp` is from `FOR UPDATE` query. `app` is from outer loop.
                                // `app` might be stale? `currentApp` is better.
                                // But `killAppCompletely` expects a certain structure. 
                                // Let's use `app` from outer loop which is just {id}.
                                // `killAppCompletely` fetches the app internally?
                                // Line 310: `const { rows } = await db.query(...)`
                                // Yes. So we can just call the logic.

                                // Actually, let's just copy the logic or call helper safely.
                                // To avoid code duplication, I'll just set a simpler flag or logic?
                                // No, `continue` forces me to handle it here.

                                try {
                                    // Release client before killing to avoid deadlock potential if kill uses DB?
                                    // Client is released in finally. But we are inside try.
                                    // We can just rely on the fact that we released lock with COMMIT.
                                    const { rows: fullAppRows } = await db.query('SELECT * FROM apps WHERE id = $1', [currentApp.id]);
                                    if (fullAppRows[0]) await killAppCompletely(fullAppRows[0]);
                                } catch (kErr) {
                                    logger.error('Error killing app during billing:', kErr);
                                }
                            }
                            continue; // Skip the rest of the loop (including reservation and update)
                        }

                        // Deduct from balance
                        await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [overflow, currentApp.user_id]);
                    }

                    if (reserveDeduction > 0) {
                        currentReserved -= reserveDeduction;
                        await client.query('UPDATE users SET reserved_balance = reserved_balance - $1 WHERE id = $2', [reserveDeduction, currentApp.user_id]);
                    }
                }

                // 7. Proactive Re-reservation
                if (true) { // Unified Logic (Runs for all apps: Running or Stopped DBs)
                    // Standard Logic for Running Pods (App or DB)
                    // Keep ~1 hour of runway for compute
                    const reserveTarget = Math.ceil(effectiveHourlyRate); // 1 hour buffer

                    // Simplified: total target is just the 1 hour buffer
                    const totalTarget = reserveTarget;

                    if (currentReserved < totalTarget) {
                        const amountNeeded = totalTarget - currentReserved;

                        const { rows: userRows } = await client.query(
                            'SELECT balance FROM users WHERE id = $1',
                            [currentApp.user_id]
                        );
                        const user = userRows[0];

                        // Take what we can, up to the target
                        const amountToTake = Math.min(amountNeeded, user.balance);

                        if (amountToTake > 0) {
                            await client.query(
                                'UPDATE users SET balance = balance - $1, reserved_balance = reserved_balance + $2 WHERE id = $3',
                                [amountToTake, amountToTake, currentApp.user_id]
                            );
                            currentReserved += amountToTake;
                            logger.info(`Auto-reserved for ${currentApp.type} ${currentApp.id} (+${amountToTake} paise) [Target: ${totalTarget}]`);
                        } else if (currentReserved <= 0) {
                            // No reserve left
                            if (currentApp.status === 'running') {
                                // Compute resource: Kill it to stop the burn
                                shouldKill = true;
                            } else {
                                // Storage resource (Stopped DB)
                                // Log Grace Period Warning
                                logger.warn(`Storage Grace Period: User ${currentApp.user_id} DB ${currentApp.id} has 0 reserve. PVC at risk.`);
                            }
                        }
                    }
                }
                // 8. Update app billing state
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
