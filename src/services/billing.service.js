import db from '../db/db.js';
import logger from '../utils/logger.js';
import { killAppCompletely } from './app.service.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Starts billing for a pod.
 * Deducts 1 hour cost as reserve (in Paise).
 */
export const startPodBilling = (podId, userId, hourlyRatePaise) => {
    const now = Math.floor(Date.now() / 1000);

    const tx = db.transaction(() => {
        const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
        if (!user || user.balance < hourlyRatePaise) {
            throw new Error('Insufficient balance to start pod. Minimum 1 hour credit required.');
        }

        // Deduct from balance, add to reserved
        db.prepare('UPDATE users SET balance = balance - ?, reserved_balance = reserved_balance + ? WHERE id = ?')
            .run(hourlyRatePaise, hourlyRatePaise, userId);

        // Log initial reservation in history
        db.prepare('INSERT INTO transactions (id, user_id, amount, type, status) VALUES (?, ?, ?, ?, ?)')
            .run(uuidv4(), userId, -hourlyRatePaise, 'reservation', 'success');

        // Update app record
        db.prepare(`
            UPDATE apps SET 
                hourly_rate = ?,
                status = 'running',
                started_at = ?,
                last_billed_at = ?,
                reserved_amount = ?,
                total_charged = 0
            WHERE id = ?
        `).run(hourlyRatePaise, now, now, hourlyRatePaise, podId);
    });

    tx();
};

/**
 * Stops billing for a pod.
 * Refunds remaining reserved amount (in Paise).
 */
export const stopPodBilling = (podId) => {
    const tx = db.transaction(() => {
        const app = db.prepare('SELECT user_id, reserved_amount, total_charged, name, started_at FROM apps WHERE id = ?').get(podId);
        if (!app) return;

        // Refund reserved amount to balance (if any)
        if (app.reserved_amount > 0) {
            db.prepare('UPDATE users SET balance = balance + ?, reserved_balance = reserved_balance - ? WHERE id = ?')
                .run(app.reserved_amount, app.reserved_amount, app.user_id);

            // Log refund in history
            db.prepare('INSERT INTO transactions (id, user_id, amount, type, status, external_id) VALUES (?, ?, ?, ?, ?, ?)')
                .run(uuidv4(), app.user_id, app.reserved_amount, 'refund', 'success', `Refund: ${app.name}`);
        }

        // Log the FINAL USAGE SUMMARY (The total cost of the pod's life)
        // This is a receipt for transparency; the frontend will display it as a non-deductible report.
        if (app.total_charged > 0) {
            const now = Math.floor(Date.now() / 1000);
            const durationSeconds = now - app.started_at;
            const metadata = JSON.stringify({ duration: durationSeconds });

            db.prepare('INSERT INTO transactions (id, user_id, amount, type, status, external_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run(uuidv4(), app.user_id, -app.total_charged, 'pod_burn_receipt', 'success', app.name, metadata);
        }

        // Reset app billing fields
        db.prepare("UPDATE apps SET status = 'stopped', reserved_amount = 0 WHERE id = ?")
            .run(podId);
    });

    tx();
};

/**
 * Global billing loop.
 * Runs every 60 seconds.
 */
export const runBillingLoop = async () => {
    const now = Math.floor(Date.now() / 1000);
    // Fetch minimal info for the loop; we re-fetch inside the transaction for accuracy
    const apps = db.prepare("SELECT id FROM apps WHERE status = 'running'").all();

    for (const app of apps) {
        try {
            const tx = db.transaction(() => {
                // 1. RE-FETCH inside transaction to avoid race conditions with stopPodBilling
                const currentApp = db.prepare('SELECT * FROM apps WHERE id = ? AND status = \'running\'').get(app.id);
                if (!currentApp) return;

                const elapsedSeconds = now - currentApp.last_billed_at;
                if (elapsedSeconds <= 0) return;

                // 2. Handle Free Apps (0 rate)
                if (currentApp.hourly_rate <= 0) {
                    db.prepare('UPDATE apps SET last_billed_at = ? WHERE id = ?').run(now, currentApp.id);
                    return;
                }

                const costFloat = (currentApp.hourly_rate * elapsedSeconds) / 3600;

                // 3. Only charge if we have accumulated at least 1 Paise of cost
                if (costFloat < 1) return;

                const cost = Math.floor(costFloat);

                // 4. PRECISION FIX: Calculate exactly how many seconds we are charging for.
                // This ensures we don't 'throw away' the remaining fractional paise.
                // Example: If costFloat was 1.9, we charge 1 paise and only 'consume' 1 paise's worth of seconds.
                const secondsCharged = Math.floor((cost * 3600) / currentApp.hourly_rate);
                const actualLastBilledAt = currentApp.last_billed_at + secondsCharged;

                let currentReserved = currentApp.reserved_amount;

                // 5. Deduct the cost from the reserve
                if (cost > 0) {
                    currentReserved -= cost;
                    // Deduct from user's global reserved pool
                    db.prepare('UPDATE users SET reserved_balance = MAX(0, reserved_balance - ?) WHERE id = ?')
                        .run(cost, currentApp.user_id);
                }

                // 6. Proactive Re-reservation (Top up reserve if below 10 mins threshold)
                const tenMinsCost = Math.ceil(currentApp.hourly_rate / 6);
                if (currentReserved < tenMinsCost) {
                    const topupAmount = Math.max(tenMinsCost, currentApp.hourly_rate); // Top up to at least 1 hour or 10 mins
                    const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(currentApp.user_id);

                    if (user && user.balance >= topupAmount) {
                        db.prepare('UPDATE users SET balance = balance - ?, reserved_balance = reserved_balance + ? WHERE id = ?')
                            .run(topupAmount, topupAmount, currentApp.user_id);
                        currentReserved += topupAmount;
                        logger.info(`Auto-reserved for app ${currentApp.id} (+${topupAmount} paise)`);
                    } else if (currentReserved <= 0) {
                        // If reserve is literally empty and no wallet balance, kill pod
                        throw new Error('OUT_OF_BALANCE');
                    }
                }

                // 7. Update app billing state
                db.prepare(`
                    UPDATE apps SET 
                        reserved_amount = ?,
                        total_charged = total_charged + ?,
                        last_billed_at = ?
                    WHERE id = ?
                `).run(currentReserved, cost, actualLastBilledAt, currentApp.id);
            });

            try {
                tx();
            } catch (err) {
                if (err.message === 'OUT_OF_BALANCE') {
                    logger.warn(`App ${app.id} stopped due to insufficient balance`);
                    // Fetch full app record again for the kill service
                    const fullApp = db.prepare('SELECT * FROM apps WHERE id = ?').get(app.id);
                    await killAppCompletely(fullApp);
                } else {
                    throw err;
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
