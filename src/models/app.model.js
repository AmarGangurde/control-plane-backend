import db from '../db/db.js';

export const insertApp = ({ id, name, namespace, image, url, apiKey, userId, planId }) => {
  db.prepare(`
    INSERT INTO apps (id, name, namespace, image, url, api_key, user_id, plan_id, last_charged_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(id, name, namespace, image, url, apiKey, userId, planId);
};

export const getAppById = (id) => {
  return db.prepare(`
    SELECT * FROM apps WHERE id = ?
  `).get(id);
};

export const listAppsByKey = (apiKey) => {
  return db.prepare(`
    SELECT * FROM apps
    WHERE api_key = ?
    ORDER BY created_at DESC
  `).all(apiKey);
};

export const listAppsByUserId = (userId) => {
  return db.prepare(`
    SELECT * FROM apps
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId);
};

export const deleteAppById = (id) => {
  db.prepare(`
    DELETE FROM apps WHERE id = ?
  `).run(id);
};
