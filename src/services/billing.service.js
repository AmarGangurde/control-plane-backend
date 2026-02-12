import db from '../db/db.js';
import logger from '../utils/logger.js';
import { killAppCompletely } from './app.service.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Starts billing for a pod.
 * Deducts 1 hour cost as reserve.
 */
export const startPodBilling = (podId, userId, hourlyRate) => {
    const now = Math.floor(Date.now() / 1000);

    const tx = db.transaction(() => {
        const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
        if (!user || user.balance < hourlyRate) {
            throw new Error('Insufficient balance to start pod');
        }

        // Deduct from balance, add to reserved
        db.prepare('UPDATE users SET balance = balance - ?, reserved_balance = reserved_balance + ? WHERE id = ?')
            .run(hourlyRate, hourlyRate, userId);

        // Log transaction
        db.prepare('INSERT INTO transactions (id, user_id, amount, type, status) VALUES (?, ?, ?, ?, ?)')
            .run(uuidv4(), userId, -hourlyRate, 'reservation', 'success');

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
        `).run(hourlyRate, now, now, hourlyRate, podId);
    });

    tx();
};

/**
 * Stops billing for a pod.
 * Refunds remaining reserved amount.
 */
export const stopPodBilling = (podId) => {
    const tx = db.transaction(() => {
        const app = db.prepare('SELECT user_id, reserved_amount FROM apps WHERE id = ?').get(podId);
        if (!app || app.reserved_amount <= 0) return;

        // Refund reserved amount to balance
        db.prepare('UPDATE users SET balance = balance + ?, reserved_balance = reserved_balance - ? WHERE id = ?')
            .run(app.reserved_amount, app.reserved_amount, app.user_id);

        // Log transaction
        db.prepare('INSERT INTO transactions (id, user_id, amount, type, status) VALUES (?, ?, ?, ?, ?)')
            .run(uuidv4(), app.user_id, app.reserved_amount, 'refund', 'success');

        // Reset app billing fields
        db.prepare("UPDATE apps SET status = 'stopped', reserved_amount = 0 WHERE id = ?")
            .run(podId);
    });

    tx();
};

/**
 * Global billing loop.
 * Runs every 60 seconds, but charges per-second precision.
 */
export const runBillingLoop = async () => {
    const now = Math.floor(Date.now() / 1000);
    const apps = db.prepare("SELECT * FROM apps WHERE status = 'running'").all();

    for (const app of apps) {
        try {
            const elapsedSeconds = now - app.last_billed_at;

            if (elapsedSeconds <= 0) continue;

            const costPerSecond = app.hourly_rate / 3600;
            const cost = elapsedSeconds * costPerSecond;

            const tx = db.transaction(() => {
                let currentReserved = app.reserved_amount;

                if (cost > currentReserved) {
                    const additionalNeeded = cost - currentReserved;
                    const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(app.user_id);

                    if (user && user.balance >= additionalNeeded) {
                        // Deduct more from wallet to cover the cost
                        db.prepare('UPDATE users SET balance = balance - ?, reserved_balance = reserved_balance + ? WHERE id = ?')
                            .run(additionalNeeded, additionalNeeded, app.user_id);
                        currentReserved += additionalNeeded;

                        // Log additional reservation
                        db.prepare('INSERT INTO transactions (id, user_id, amount, type, status) VALUES (?, ?, ?, ?, ?)')
                            .run(uuidv4(), app.user_id, -additionalNeeded, 'reservation_topup', 'success');
                    } else {
                        // Kill the app if out of money
                        throw new Error('OUT_OF_BALANCE');
                    }
                }

                // Apply per-second cost
                const newReserved = currentReserved - cost;
                db.prepare('UPDATE users SET reserved_balance = reserved_balance - ? WHERE id = ?')
                    .run(cost, app.user_id);

                db.prepare(`
                    UPDATE apps SET 
                        reserved_amount = ?,
                        total_charged = total_charged + ?,
                        last_billed_at = ?
                    WHERE id = ?
                `).run(newReserved, cost, now, app.id);
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
    logger.info('Starting per-second billing observer (60s cycle)...');
    setInterval(() => {
        runBillingLoop().catch(err => logger.error('Billing loop error:', err));
    }, 60000);
};
