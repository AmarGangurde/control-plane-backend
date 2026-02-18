import db from '../db/db.js';

export const getPlans = async () => {
    const { rows } = await db.query("SELECT * FROM plans ORDER BY price_per_hour ASC");
    // Mark Kata plans as coming soon — flip this flag when Kata nodes are live
    return rows.map(plan => ({
        ...plan,
        coming_soon: plan.runtime === 'kata'
    }));
};

export const getPlanById = async (id) => {
    const { rows } = await db.query('SELECT * FROM plans WHERE id = $1', [id]);
    return rows[0] || null;
};
