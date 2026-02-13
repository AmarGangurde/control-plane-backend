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
 * Calculates final cost for partial time, deducts from reserve, and refunds remainder.
 */
export const stopPodBilling = (podId) => {
    const now = Math.floor(Date.now() / 1000);

    const tx = db.transaction(() => {
        // Fetch necessary fields including billing info
        const app = db.prepare('SELECT user_id, reserved_amount, last_billed_at, hourly_rate FROM apps WHERE id = ?').get(podId);

        // If app not found or nothing reserved, just ensure status is stopped
        if (!app || app.reserved_amount <= 0) {
            db.prepare("UPDATE apps SET status = 'stopped', reserved_amount = 0 WHERE id = ?").run(podId);
            return;
        }

        // Calculate final partial cost (from last_billed_at to now)
        let finalCost = 0;
        if (app.last_billed_at && app.hourly_rate) {
            const elapsedSeconds = now - app.last_billed_at;
            if (elapsedSeconds > 0) {
                // (hourly_rate * elapsed) / 3600
                // Use ceil to ensure we capture fractional usage on exit. 
                // This prevents "free" 15-second runs.
                finalCost = Math.ceil((app.hourly_rate * elapsedSeconds) / 3600);
            }
        }

        // Ensure we don't charge more than what's reserved (though in theory, users owe it, 
        // with prepaid model we usually cap at reserve. But here we have balance.
        // Let's assume strict deduction from reserve + refund remainder.)
        // If finalCost > reserved_amount (rare), refund is negative => user pays diff from balance.
        const refundAmount = app.reserved_amount - finalCost;

        // Update user balance:
        // reserved_balance -= app.reserved_amount (clear the hold)
        // balance += refundAmount (add back unused)
        db.prepare('UPDATE users SET balance = balance + ?, reserved_balance = reserved_balance - ? WHERE id = ?')
            .run(refundAmount, app.reserved_amount, app.user_id);

        // Log transaction (refund)
        // If refundAmount is negative, it logs as negative (charge).
        db.prepare('INSERT INTO transactions (id, user_id, amount, type, status) VALUES (?, ?, ?, ?, ?)')
            .run(uuidv4(), app.user_id, refundAmount, 'refund', 'success');

        // Reset app billing fields and add final charge to total
        db.prepare("UPDATE apps SET status = 'stopped', reserved_amount = 0, total_charged = total_charged + ? WHERE id = ?")
            .run(finalCost, podId);
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

            // Hourly rate is in Paise. 
            // Cost = (elapsed / 3600) * hourlyRate
            // To keep integer: (hourlyRate * elapsed) / 3600
            const cost = Math.floor((app.hourly_rate * elapsedSeconds) / 3600);

            const tx = db.transaction(() => {
                let currentReserved = app.reserved_amount;
                let dataChanged = false;
                let newLastBilledAt = app.last_billed_at;

                // 1. Charge the cost from the reserve
                if (cost > 0) {
                    currentReserved -= cost;
                    // Deduct from user's global reserved pool
                    db.prepare('UPDATE users SET reserved_balance = reserved_balance - ? WHERE id = ?')
                        .run(cost, app.user_id);

                    // Since we successfully charged, we advance the billing clock
                    newLastBilledAt = now;
                    dataChanged = true;
                }

                // 2. Proactive Re-reservation (Top up reserve if below 10 mins threshold)
                // hourly_rate / 6 => cost for 10 mins
                const tenMinsCost = Math.ceil(app.hourly_rate / 6);
                if (currentReserved < tenMinsCost) {
                    const topupAmount = tenMinsCost; // Top up another 10 mins
                    const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(app.user_id);

                    if (user && user.balance >= topupAmount) {
                        db.prepare('UPDATE users SET balance = balance - ?, reserved_balance = reserved_balance + ? WHERE id = ?')
                            .run(topupAmount, topupAmount, app.user_id);
                        currentReserved += topupAmount;

                        logger.info(`Auto-reserved 10m for app ${app.id} (+${topupAmount} paise)`);
                        dataChanged = true;
                    } else {
                        // If reserve is literally empty and no wallet balance, kill pod
                        if (currentReserved <= 0) {
                            throw new Error('OUT_OF_BALANCE');
                        }
                    }
                }

                // 3. Update app status IF anything changed
                // Note: We only update last_billed_at if we actually charged 'cost' > 0.
                // If cost was 0, we keep the old last_billed_at so usage accumulates for the next loop.
                if (dataChanged) {
                    db.prepare(`
                        UPDATE apps SET 
                            reserved_amount = ?,
                            total_charged = total_charged + ?,
                            last_billed_at = ?
                        WHERE id = ?
                    `).run(currentReserved, cost, newLastBilledAt, app.id);
                }
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
    logger.info('Starting per-minute integer billing cycle...');
    setInterval(() => {
        runBillingLoop().catch(err => logger.error('Billing loop error:', err));
    }, 60000);
};
