import db from '../db/db.js';
import { v4 as uuidv4 } from 'uuid';

export const createUser = async (googleId, email) => {
    const id = uuidv4();
    await db.query(
        'INSERT INTO users (id, google_id, email) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING',
        [id, googleId, email]
    );
    return getUserByEmail(email);
};

export const getUserByEmail = async (email) => {
    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0] || null;
};

export const getUserById = async (id) => {
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] || null;
};

export const updateUserBalance = async (id, amount) => {
    await db.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, id]);
    return getUserById(id);
};
