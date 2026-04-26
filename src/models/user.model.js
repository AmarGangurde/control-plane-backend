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

export const getUserByGithubId = async (githubId) => {
    const { rows } = await db.query('SELECT * FROM users WHERE github_id = $1', [githubId]);
    return rows[0] || null;
};

export const updateUserBalance = async (id, amount) => {
    await db.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, id]);
    return getUserById(id);
};

export const updateDockerCredentials = async (id, username, token) => {
    await db.query(
        'UPDATE users SET docker_username = $1, docker_token = $2 WHERE id = $3',
        [username, token, id]
    );
    return getUserById(id);
};

export const updateGithubId = async (id, githubId) => {
    await db.query('UPDATE users SET github_id = $1 WHERE id = $2', [githubId, id]);
    return getUserById(id);
};

export const getUserByAgentToken = async (token) => {
    const { rows } = await db.query('SELECT * FROM users WHERE agent_token = $1', [token]);
    return rows[0] || null;
};
