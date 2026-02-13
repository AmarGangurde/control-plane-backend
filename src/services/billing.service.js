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
        const app = db.prepare('SELECT user_id, reserved_amount, total_charged, name FROM apps WHERE id = ?').get(podId);
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
        // We use a negative amount to show it as an "Expense" in the list, but it DOES NOT affect balance (balance was already deducted incrementally)
        if (app.total_charged > 0) {
            db.prepare('INSERT INTO transactions (id, user_id, amount, type, status, external_id) VALUES (?, ?, ?, ?, ?, ?)')
                .run(uuidv4(), app.user_id, -app.total_charged, 'usage_report', 'success', `Total Cost: ${app.name}`);
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
    const apps = db.prepare("SELECT * FROM apps WHERE status = 'running'").all();

    for (const app of apps) {
        try {
            const elapsedSeconds = now - app.last_billed_at;
            if (elapsedSeconds <= 0) continue;

            // Cost = (elapsed / 3600) * hourlyRate
            // To prevent "0 cost" loops for cheap plans (e.g. 50 paise/hr):
            // We use a high-precision accumulator or simply allow float substraction in memory but store int in DB?
            // BETTER: We track 'last_billed_at' precisely. 
            // If the calculated cost is < 1 paise, WE DO NOTHING THIS TICK. We wait for more time to elapse.

            const costFloat = (app.hourly_rate * elapsedSeconds) / 3600;

            // Only charge if we have accumulated at least 1 Paise of cost
            if (costFloat < 1) continue;

            const cost = Math.floor(costFloat);

            const tx = db.transaction(() => {
                let currentReserved = app.reserved_amount;

                // 1. Charge the cost from the reserve
                if (cost > 0) {
                    currentReserved -= cost;
                    // Deduct from user's global reserved pool
                    db.prepare('UPDATE users SET reserved_balance = reserved_balance - ? WHERE id = ?')
                        .run(cost, app.user_id);
                }

                // 2. Proactive Re-reservation (Top up reserve if below 10 mins threshold)
                const tenMinsCost = Math.ceil(app.hourly_rate / 6);
                if (currentReserved < tenMinsCost) {
                    const topupAmount = tenMinsCost; // Top up another 10 mins
                    const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(app.user_id);

                    if (user && user.balance >= topupAmount) {
                        db.prepare('UPDATE users SET balance = balance - ?, reserved_balance = reserved_balance + ? WHERE id = ?')
                            .run(topupAmount, topupAmount, app.user_id);
                        currentReserved += topupAmount;

                        logger.info(`Auto-reserved 10m for app ${app.id} (+${topupAmount} paise)`);
                        // We DON'T log 'reservation_topup' in transactions to avoid clutter.
                        // The user sees their balance decrease and reserved pool increase in UI.
                    } else {
                        // If reserve is literally empty and no wallet balance, kill pod
                        if (currentReserved <= 0) {
                            throw new Error('OUT_OF_BALANCE');
                        }
                    }
                }

                // 3. Update app status
                db.prepare(`
                    UPDATE apps SET 
                        reserved_amount = ?,
                        total_charged = total_charged + ?,
                        last_billed_at = ?
                    WHERE id = ?
                `).run(currentReserved, cost, now, app.id);
            });

            try {
                tx();
            } catch (err) {
                if (err.message === 'OUT_OF_BALANCE') {
                    logger.warn(`App ${app.id} stopped due to insufficient balance`);
                    await killAppCompletely(app);
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
