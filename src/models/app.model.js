import db from '../db/db.js';

export const insertApp = ({ id, namespace, image, url, apiKey }) => {
  db.prepare(`
    INSERT INTO apps (id, namespace, image, url, api_key)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, namespace, image, url, apiKey);
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

export const deleteAppById = (id) => {
  db.prepare(`
    DELETE FROM apps WHERE id = ?
  `).run(id);
};
