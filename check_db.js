
import db from './src/db/db.js';

const checkDb = async () => {
    try {
        const plans = await db.query('SELECT * FROM plans');
        console.log('--- PLANS ---');
        console.log(JSON.stringify(plans.rows, null, 2));

        const apps = await db.query('SELECT id, name, plan_id, hourly_rate, total_charged, reserved_amount FROM apps');
        console.log('--- APPS ---');
        console.log(JSON.stringify(apps.rows, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
};

checkDb();
