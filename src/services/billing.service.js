import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/db.js';
import { updateUserBalance } from '../models/user.model.js';
import { killAppCompletely } from './app.service.js';

export const startBillingCron = () => {
    // Run every 10 minutes to check for apps that need billing
    cron.schedule('*/10 * * * *', () => {
        processCharges();
    });
};

const processCharges = () => {
    try {
        console.log('🔄 Checking app billing cycles (1hr cycle)...');

        // Select apps where last_charged_at was > 1 hour ago
        const apps = db.prepare(`
            SELECT apps.*, plans.price_per_hour
            FROM apps 
            JOIN plans ON apps.plan_id = plans.id
            WHERE datetime('now') >= datetime(apps.last_charged_at, '+1 hour')
        `).all();

        if (!apps.length) return;

        console.log(`🧾 Found ${apps.length} apps due for hourly billing.`);

        const stmtTrans = db.prepare('INSERT INTO transactions (id, user_id, amount, type, status) VALUES (?, ?, ?, ?, \'success\')');
        const stmtUpdateApp = db.prepare('UPDATE apps SET last_charged_at = CURRENT_TIMESTAMP WHERE id = ?');
        const stmtResetBalance = db.prepare('UPDATE users SET balance = 0 WHERE id = ?');

        for (const app of apps) {
            if (!app.user_id) continue;

            // Tiny plan is 0, skipping deduction logic but updating timestamp
            if (app.price_per_hour > 0) {
                // IMPORTANT: Fetch fresh user balance to see if they already hit 0 from a previous app in this loop
                const currentUser = db.prepare('SELECT balance FROM users WHERE id = ?').get(app.user_id);

                if (!currentUser || currentUser.balance <= 0) {
                    console.log(`⚠️ User ${app.user_id} already at 0 balance. Skipping charge for ${app.id} and ensuring shutdown.`);
                    // Ensure apps are killed (in case they weren't yet)
                    const userApps = db.prepare('SELECT * FROM apps WHERE user_id = ?').all(app.user_id);
                    for (const userApp of userApps) {
                        killAppCompletely(userApp).catch(e => console.error(`Error killing app ${userApp.id}:`, e));
                    }
                    // Still update app timer or row will be gone after kill anyway
                    stmtUpdateApp.run(app.id);
                    continue;
                }

                // Charge User
                const updatedUser = updateUserBalance(app.user_id, -app.price_per_hour);

                // Record Transaction
                stmtTrans.run(uuidv4(), app.user_id, -app.price_per_hour, 'hourly_cycle_charge');

                console.log(`💸 Charged user ${app.user_id} ₹${app.price_per_hour} for app ${app.id}. New Balance: ${updatedUser.balance}`);

                // AUTO-DELETION: If balance is zero or negative, kill all user's apps
                if (updatedUser.balance <= 0) {
                    console.log(`⚠️ User ${app.user_id} has reached 0 balance. Resetting and killing all apps.`);

                    if (updatedUser.balance < 0) {
                        stmtResetBalance.run(app.user_id);
                    }

                    const userApps = db.prepare('SELECT * FROM apps WHERE user_id = ?').all(app.user_id);
                    for (const userApp of userApps) {
                        killAppCompletely(userApp).catch(e => console.error(`Error killing app ${userApp.id}:`, e));
                    }
                }
            }

            // Update App Timer
            stmtUpdateApp.run(app.id);
        }
    } catch (err) {
        console.error('Billing Cron Error:', err);
    }
};
