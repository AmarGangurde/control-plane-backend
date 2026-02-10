import db from '../db/db.js';

export const getPlans = () => {
    return db.prepare('SELECT * FROM plans').all();
};

export const getPlanById = (id) => {
    return db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
};
