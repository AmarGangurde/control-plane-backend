import db from '../db/db.js';
import { v4 as uuidv4 } from 'uuid';

export const createUser = (googleId, email) => {
    const id = uuidv4();
    const stmt = db.prepare('INSERT INTO users (id, google_id, email) VALUES (?, ?, ?)');
    stmt.run(id, googleId, email);
    return getUserByEmail(email);
};

export const getUserByEmail = (email) => {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
};

export const getUserById = (id) => {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
};

export const updateUserBalance = (id, amount) => {
    // atomic update
    const stmt = db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?');
    stmt.run(amount, id);
    return getUserById(id);
};
