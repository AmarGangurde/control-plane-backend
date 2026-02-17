import db from '../db/db.js';

export const getPlans = async () => {
    const { rows } = await db.query('SELECT * FROM plans');
    return rows;
};

export const getPlanById = async (id) => {
    const { rows } = await db.query('SELECT * FROM plans WHERE id = $1', [id]);
    return rows[0] || null;
};
