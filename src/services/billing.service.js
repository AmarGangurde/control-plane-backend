import db from '../db/db.js';
import logger from '../utils/logger.js';
import { killAppCompletely } from './app.service.js';
import { v4 as uuidv4 } from 'uuid';
import cashfreeService from './cashfree.service.js';
import * as emailService from './email.service.js';
import k8sService from './k8s.service.js';


/**
 * Starts billing for a pod.
 * Deducts 1 hour cost as reserve (in Paise).
 * @param {string} podId - The ID of the pod/app.
 * @param {string} userId - The ID of the user.
 * @param {number} hourlyRatePaise - The amount to reserve (deducted from balance).
 * @param {number} [hourlyRateToSet] - Optional rate to store in apps.hourly_rate (defaults to hourlyRatePaise).
 * @param {number} [replicas] - Number of replicas (defaults to 1).
 */
export const startPodBilling = async (podId, userId, hourlyRatePaise, hourlyRateToSet, replicas = 1) => {
    const rateToSet = hourlyRateToSet !== undefined ? hourlyRateToSet : hourlyRatePaise;
    const now = Math.floor(Date.now() / 1000);
    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        // Fetch app to check existing reserve
        const { rows: appRows } = await client.query('SELECT name, type, reserved_amount, last_billed_at FROM apps WHERE id = $1 FOR UPDATE', [podId]);
        const app = appRows[0];
        const existingReserve = Number(app?.reserved_amount || 0);

        // Target: Exactly 1 hour of the new combined rate * replicas
        const targetReserve = hourlyRatePaise * parseInt(replicas, 10);

        const { rows: uRows } = await client.query('SELECT balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const user = uRows[0];

        if (existingReserve < targetReserve) {
            const amountToDeduct = targetReserve - existingReserve;
            if (!user || user.balance < amountToDeduct) {
                throw new Error(`Insufficient balance to start ${app?.type || 'pod'}. Need ₹${(amountToDeduct / 100).toFixed(2)} more for 1 hour reserve.`);
            }

            // Deduct from balance, add to reserved
            await client.query(
                'UPDATE users SET balance = balance - $1, reserved_balance = reserved_balance + $2 WHERE id = $3',
                [amountToDeduct, amountToDeduct, userId]
            );

            // Log reservation
            await client.query(
                'INSERT INTO transactions (id, user_id, amount, type, status, external_id, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [uuidv4(), userId, -amountToDeduct, 'reservation', 'success', app?.name || 'Resource', JSON.stringify({ type: app?.type || 'app' })]
            );
        } else if (existingReserve > targetReserve) {
            const amountToRefund = existingReserve - targetReserve;
            await client.query(
                'UPDATE users SET balance = balance + $1, reserved_balance = reserved_balance - $2 WHERE id = $3',
                [amountToRefund, amountToRefund, userId]
            );
            // Log refund
            await client.query(
                'INSERT INTO transactions (id, user_id, amount, type, status, external_id, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [uuidv4(), userId, amountToRefund, 'refund', 'success', `Adjust: ${app?.name || 'Resource'}`, JSON.stringify({ type: app?.type || 'app' })]
            );
        }

        // IMPORTANT: If last_billed_at is 0, initialize it to NOW to prevent massive debt accumulation
        const startBilledAt = (app.last_billed_at && Number(app.last_billed_at) > 0) ? app.last_billed_at : now;

        // Update app record
        await client.query(`
            UPDATE apps SET 
                hourly_rate = $1,
                status = 'running',
                started_at = $2,
                last_billed_at = $3,
                reserved_amount = $4,
                replicas = $5,
                total_charged = 0
            WHERE id = $6
        `, [rateToSet, now, startBilledAt, targetReserve, replicas, podId]);

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
            effectiveHourlyRate += (app.hourly_rate || 0) * (app.replicas || 1);
        }
        if (app.type === 'database' || app.type === 'service') {
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
        if ((app.type === 'database' || app.type === 'service') && !isDestroying) {
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
    const lockClient = await db.getClient();
    let lockAcquired = false;

    try {
        const { rows: lockRows } = await lockClient.query('SELECT pg_try_advisory_lock(1001) as locked');
        lockAcquired = lockRows[0].locked;

        if (!lockAcquired) {
            return;
        }

        // Select everything that needs billing: 
        // 1. Any 'running' pod (App or Database)
        // 2. Any 'database' that exists (not deleted) for storage billing
        const { rows: apps } = await lockClient.query(`
            SELECT id FROM apps 
            WHERE status = 'running' 
            OR ((type = 'database' OR type = 'service') AND status != 'deleted')
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

                    // 2. Calculate Effective Hourly Rate
                    // Pod rate is only active if 'running', multiplied by replicas
                    const podRate = currentApp.status === 'running' ? (currentApp.hourly_rate || 0) * (currentApp.replicas || 1) : 0;
                    // Storage rate is active for all non-deleted databases
                    const storageRate = (currentApp.type === 'database' || currentApp.type === 'service') ? (currentApp.storage_hourly_rate || 0) : 0;
                    const effectiveHourlyRate = podRate + storageRate;

                    // 3. Handle Free/No-cost resources
                    if (effectiveHourlyRate <= 0) {
                        await client.query('UPDATE apps SET last_billed_at = $1 WHERE id = $2', [now, currentApp.id]);
                        await client.query('COMMIT');
                        continue;
                    }

                    // IMPORTANT: If last_billed_at is 0, initialize it to NOW to prevent massive debt accumulation
                    const lastBilledAt = (currentApp.last_billed_at && Number(currentApp.last_billed_at) > 0) ? Number(currentApp.last_billed_at) : now;

                    const elapsedSinceLastBill = now - lastBilledAt;
                    if (elapsedSinceLastBill <= 0) {
                        await client.query('COMMIT');
                        continue;
                    }

                    const costFloat = (effectiveHourlyRate * elapsedSinceLastBill) / 3600;

                    // 4. Only charge if we have accumulated at least 1 Paise of cost
                    if (costFloat < 1) {
                        await client.query('COMMIT');
                        continue;
                    }

                    const cost = Math.floor(costFloat);

                    // 5. PRECISION FIX: Only advance time for the exact amount we charged
                    const secondsCharged = Math.floor((cost * 3600) / effectiveHourlyRate);
                    const actualLastBilledAt = lastBilledAt + secondsCharged;

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
                                if (currentApp.status === 'running') {
                                    // Running app — kill immediately
                                    logger.info(`Insufficient funds for running app ${currentApp.id}. Killing.`);
                                    shouldKill = true;
                                } else if (currentApp.type === 'database' || currentApp.type === 'service') {
                                    // Stopped database — start/check 3-day grace period
                                    const GRACE_DAYS = 3;
                                    const now3 = new Date();

                                    if (!currentApp.grace_started_at) {
                                        // First time — start the grace clock
                                        const deleteDate = new Date(now3.getTime() + GRACE_DAYS * 86400 * 1000);
                                        await client.query(
                                            'UPDATE apps SET grace_started_at = $1 WHERE id = $2',
                                            [now3, currentApp.id]
                                        );
                                        logger.warn(`DB ${currentApp.id} entered 3-day grace period. Delete after ${deleteDate.toISOString()}`);
                                        emailService.emailDatabaseGraceStarted(currentApp.user_id, currentApp.name, deleteDate).catch(() => { });
                                    } else {
                                        // Grace already started — check if expired
                                        const graceStart = new Date(currentApp.grace_started_at);
                                        const daysPassed = (now3 - graceStart) / 86400000;
                                        if (daysPassed >= GRACE_DAYS) {
                                            // 3 days up — destroy the database
                                            logger.warn(`DB ${currentApp.id} grace period expired after ${daysPassed.toFixed(1)} days. Destroying.`);
                                            await client.query('COMMIT');
                                            client.release();
                                            const { rows: fullAppRows } = await db.query('SELECT * FROM apps WHERE id = $1', [currentApp.id]);
                                            if (fullAppRows[0]) {
                                                await stopPodBilling(currentApp.id, true).catch(() => { });
                                                const shortId = currentApp.id.split('-')[0];
                                                await k8sService.deleteNamespacedDeployment(`db-${shortId}`, currentApp.namespace).catch(() => { });
                                                await k8sService.deleteNamespacedService(`db-${shortId}`, currentApp.namespace).catch(() => { });
                                                await k8sService.deleteNamespacedPVC(`data-db-${shortId}`, currentApp.namespace).catch(() => { });
                                                await db.query("UPDATE apps SET status = 'deleted', grace_started_at = NULL WHERE id = $1", [currentApp.id]);
                                                emailService.emailDatabaseDestroyed(currentApp.user_id, currentApp.name).catch(() => { });
                                            }
                                            continue;
                                        }
                                    }
                                }
                                await client.query('COMMIT');
                                continue;
                            }

                            // Deduct from balance
                            await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [overflow, currentApp.user_id]);
                        }

                        if (reserveDeduction > 0) {
                            currentReserved -= reserveDeduction;
                            await client.query('UPDATE users SET reserved_balance = reserved_balance - $1 WHERE id = $2', [reserveDeduction, currentApp.user_id]);
                        }
                    }

                    // 7. Proactive Re-reservation (Balance the reserve)
                    const targetReserve = Math.ceil(effectiveHourlyRate); // 1 hour buffer

                    if (currentReserved < targetReserve) {
                        const amountNeeded = targetReserve - currentReserved;
                        const { rows: userRows } = await client.query('SELECT balance FROM users WHERE id = $1', [currentApp.user_id]);
                        const user = userRows[0];
                        const amountToTake = Math.min(amountNeeded, user?.balance || 0);

                        if (amountToTake > 0) {
                            await client.query(
                                'UPDATE users SET balance = balance - $1, reserved_balance = reserved_balance + $2 WHERE id = $3',
                                [amountToTake, amountToTake, currentApp.user_id]
                            );
                            currentReserved += amountToTake;
                            logger.info(`Auto-reserved for ${currentApp.type} ${currentApp.id} (+${amountToTake} paise)`);
                        } else if (currentReserved <= 0 && currentApp.status === 'running') {
                            shouldKill = true;
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
                        // Email user — non-fatal
                        emailService.emailAppKilledLowBalance(fullApp.user_id, fullApp.name, fullApp.url).catch(() => { });
                    }
                }
            } catch (err) {
                logger.error(`Error billing app ${app.id}:`, err);
            }
        }
    } catch (err) {
        logger.error('Billing loop error:', err);
    } finally {
        if (lockAcquired) {
            await lockClient.query('SELECT pg_advisory_unlock(1001)');
        }
        lockClient.release();
    }
};

export const resumeGracePeriodDatabases = async (userId) => {
    // Called after a successful topup — restart any stopped DBs in grace period
    const { rows: graceDbs } = await db.query(
        `SELECT * FROM apps WHERE user_id = $1 AND type = 'database' AND grace_started_at IS NOT NULL AND status = 'stopped'`,
        [userId]
    );
    if (graceDbs.length === 0) return;

    const { rows: uRows } = await db.query('SELECT balance FROM users WHERE id = $1', [userId]);
    let userBalance = uRows[0]?.balance || 0;

    for (const app of graceDbs) {
        try {
            // Calculate storage debt since grace started
            const graceStart = new Date(app.grace_started_at);
            const hoursInGrace = (Date.now() - graceStart.getTime()) / 3600000;
            const debtPaise = Math.floor((app.storage_hourly_rate || 0) * hoursInGrace);

            if (debtPaise > 0 && userBalance < debtPaise) {
                logger.warn(`resumeGrace: user ${userId} can't cover debt ${debtPaise} for DB ${app.id} — skipping`);
                continue; // still not enough balance for this DB
            }

            // Charge the accrued debt
            if (debtPaise > 0) {
                await db.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [debtPaise, userId]);
                userBalance -= debtPaise;
                await db.query(
                    `INSERT INTO transactions (id, user_id, amount, type, status, external_id, metadata)
                     VALUES ($1, $2, $3, 'pod_burn_receipt', 'success', $4, $5)`,
                    [uuidv4(), userId, -debtPaise, `Grace-debt: ${app.name}`, JSON.stringify({ type: 'database', graceHours: hoursInGrace.toFixed(1) })]
                );
            }

            // Clear grace, reset last_billed_at
            await db.query(
                `UPDATE apps SET grace_started_at = NULL, last_billed_at = $1, status = 'stopped' WHERE id = $2`,
                [Math.floor(Date.now() / 1000), app.id]
            );

            // Resume pod on k8s
            const { getPlanById } = await import('../models/plan.model.js');
            const plan = await getPlanById(app.plan_id);
            const shortId = app.id.split('-')[0];
            const pvcName = `data-db-${shortId}`;
            await k8sService.createDatabaseDeployment({
                name: `db-${shortId}`,
                namespace: app.namespace,
                plan,
                dbUser: app.db_user,
                dbPassword: app.db_password,
                dbName: app.db_name,
                pvcName
            }).catch(err => logger.warn(`resumeGrace: k8s redeploy failed for DB ${app.id}: ${err.message}`));
            await k8sService.createDatabaseService({ name: `db-${shortId}`, namespace: app.namespace }).catch(() => { });
            await db.query(`UPDATE apps SET status = 'running' WHERE id = $1`, [app.id]);

            logger.info(`resumeGrace: DB ${app.id} resumed. Charged ₹${(debtPaise / 100).toFixed(2)} debt.`);
            emailService.emailDatabaseResumed(userId, app.name, debtPaise / 100).catch(() => { });
        } catch (err) {
            logger.error(`resumeGrace: error resuming DB ${app.id}: ${err.message}`);
        }
    }
};

export const startBillingCron = () => {
    logger.info('Starting per-10-seconds integer billing cycle...');
    setInterval(() => {
        runBillingLoop().catch(err => logger.error('Billing loop error:', err));
    }, 10000);

    // Low-balance runway warning: check once per hour across all tenants
    logger.info('Starting hourly low-balance runway warning loop...');
    setInterval(() => {
        runLowBalanceWarningLoop().catch(err => logger.error('Low-balance warning loop error:', err));
    }, 60 * 60 * 1000);
};

/**
 * Hourly loop that warns each user if their available balance will
 * run out in < 5 days given their current total hourly burn rate
 * (all running apps + all active db storage, across every service).
 *
 * One email per user per calendar day (23-hour dedup via low_balance_warned_at).
 * When runway recovers to >= 5 days, low_balance_warned_at is reset so the
 * warning can fire again next time balance dips.
 */
export const runLowBalanceWarningLoop = async () => {
    const lockClient = await db.getClient();
    let lockAcquired = false;
    try {
        const { rows: lockRows } = await lockClient.query('SELECT pg_try_advisory_lock(1004) as locked');
        lockAcquired = lockRows[0].locked;
        if (!lockAcquired) return;

        // Fetch all users who have at least one billable service
        const { rows: userServices } = await lockClient.query(`
            SELECT
                u.id            AS user_id,
                u.balance       AS available_balance,
                u.low_balance_warned_at,
                a.id            AS app_id,
                a.name          AS app_name,
                a.type          AS app_type,
                a.status        AS app_status,
                a.hourly_rate,
                a.storage_hourly_rate,
                a.replicas
            FROM users u
            JOIN apps a ON a.user_id = u.id
            WHERE
                (a.status = 'running')
                OR ((a.type = 'database' OR a.type = 'service') AND a.status != 'deleted')
            ORDER BY u.id
        `);

        if (userServices.length === 0) return;

        // Group by user
        const byUser = new Map();
        for (const row of userServices) {
            if (!byUser.has(row.user_id)) {
                byUser.set(row.user_id, {
                    user_id: row.user_id,
                    available_balance: Number(row.available_balance || 0),
                    low_balance_warned_at: row.low_balance_warned_at,
                    services: [],
                });
            }
            byUser.get(row.user_id).services.push(row);
        }

        for (const [userId, userData] of byUser) {
            try {
                // Calculate total effective hourly rate across all services
                let totalHourlyRate = 0;
                const serviceNames = [];
                for (const s of userData.services) {
                    const podRate = s.app_status === 'running'
                        ? (Number(s.hourly_rate || 0) * (Number(s.replicas) || 1))
                        : 0;
                    const storageRate = (s.app_type === 'database' || s.app_type === 'service')
                        ? Number(s.storage_hourly_rate || 0)
                        : 0;
                    const effectiveRate = podRate + storageRate;
                    totalHourlyRate += effectiveRate;

                    if (effectiveRate > 0) {
                        const type = s.app_type === 'database' ? 'DB' : 'App';
                        serviceNames.push(`${s.app_name} (${type})`);
                    }
                }

                if (totalHourlyRate <= 0) continue;

                const runwayHours = userData.available_balance / totalHourlyRate;
                const runwayDays = runwayHours / 24;
                const dailyCostRupees = (totalHourlyRate * 24) / 100;

                if (runwayDays < 5) {
                    // Check 23-hour dedup
                    const lastWarned = userData.low_balance_warned_at
                        ? new Date(userData.low_balance_warned_at)
                        : null;
                    const hoursSinceWarned = lastWarned
                        ? (Date.now() - lastWarned.getTime()) / 3600000
                        : Infinity;

                    if (hoursSinceWarned >= 23) {
                        // Send warning
                        emailService.emailLowRunwayWarning(userId, runwayDays, dailyCostRupees, serviceNames)
                            .catch(() => { });
                        // Stamp warned time
                        await db.query(
                            'UPDATE users SET low_balance_warned_at = NOW() WHERE id = $1',
                            [userId]
                        );
                        logger.info(`[runway-warn] Sent low-balance warning to user ${userId} — runway: ${runwayDays.toFixed(1)} days`);
                    }
                } else {
                    // Runway recovered — reset so warning can fire again next time
                    if (userData.low_balance_warned_at) {
                        await db.query(
                            'UPDATE users SET low_balance_warned_at = NULL WHERE id = $1',
                            [userId]
                        );
                    }
                }
            } catch (err) {
                logger.error(`[runway-warn] Error processing user ${userId}:`, err.message);
            }
        }
    } catch (err) {
        logger.error('[runway-warn] Loop error:', err);
    } finally {
        if (lockAcquired) {
            await lockClient.query('SELECT pg_advisory_unlock(1004)');
        }
        lockClient.release();
    }
};


/**
 * Background Payment Verification Loop
 * Checks for pending topup transactions and verifies them with Cashfree.
 * Runs every 1 minute.
 */
export const runPaymentVerificationLoop = async () => {
    const lockClient = await db.getClient();
    let lockAcquired = false;

    try {
        const { rows: lockRows } = await lockClient.query('SELECT pg_try_advisory_lock(1002) as locked');
        lockAcquired = lockRows[0].locked;

        if (!lockAcquired) return;

        // Find pending topup transactions created in the last 30 minutes
        const { rows: pendingTxns } = await lockClient.query(`
            SELECT external_id FROM transactions 
            WHERE status = 'pending' 
            AND type = 'topup'
            AND created_at > NOW() - INTERVAL '30 minutes'
            LIMIT 20
        `);

        for (const txn of pendingTxns) {
            const order_id = txn.external_id;
            try {
                const orderData = await cashfreeService.verifyOrder(order_id);
                if (orderData.order_status === 'PAID') {
                    const client = await db.getClient();
                    try {
                        await client.query('BEGIN');
                        const updateResult = await client.query(
                            "UPDATE transactions SET status = 'success' WHERE external_id = $1 AND status = 'pending'",
                            [order_id]
                        );

                        if (updateResult.rowCount > 0) {
                            const { rows } = await client.query(
                                'SELECT * FROM transactions WHERE external_id = $1',
                                [order_id]
                            );
                            const transaction = rows[0];
                            const bgAmountPaise = Math.abs(transaction.amount);
                            await client.query(
                                'UPDATE users SET balance = balance + $1 WHERE id = $2',
                                [bgAmountPaise, transaction.user_id]
                            );
                            logger.info(`Background payment verification successful for transaction ${order_id}`);
                            emailService.emailTopupConfirmed(transaction.user_id, (bgAmountPaise / 100).toFixed(0)).catch(() => { });
                            resumeGracePeriodDatabases(transaction.user_id).catch(() => { });
                        }
                        await client.query('COMMIT');
                    } catch (err) {
                        await client.query('ROLLBACK');
                        throw err;
                    } finally {
                        client.release();
                    }
                } else if (['FAILED', 'CANCELLED', 'EXPIRED'].includes(orderData.order_status)) {
                    await db.query(
                        "UPDATE transactions SET status = $1 WHERE external_id = $2 AND status = 'pending'",
                        [orderData.order_status.toLowerCase(), order_id]
                    );
                    logger.info(`Background payment verification: Transaction ${order_id} marked as ${orderData.order_status}`);
                }
            } catch (err) {
                logger.error(`Error verifying order ${order_id} in background:`, err.message);
            }
        }
    } catch (err) {
        logger.error('Payment verification loop error:', err);
    } finally {
        if (lockAcquired) {
            await lockClient.query('SELECT pg_advisory_unlock(1002)');
        }
        lockClient.release();
    }
};

export const startPaymentVerificationCron = () => {
    logger.info('Starting per-minute payment verification cycle...');
    setInterval(() => {
        runPaymentVerificationLoop().catch(err => logger.error('Payment verification loop error:', err));
    }, 60000); // Once per minute
};
