import db from '../db/db.js';

export const insertApp = ({ id, name, namespace, image, url, apiKey, userId, planId, containerPort, env, command, args }) => {
  const envStr = env ? JSON.stringify(env) : null;
  const cmdStr = command ? JSON.stringify(command) : null;
  const argStr = args ? JSON.stringify(args) : null;

  db.prepare(`
    INSERT INTO apps (id, name, namespace, image, url, api_key, user_id, plan_id, container_port, env, command, args, last_charged_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(id, name, namespace, image, url, apiKey, userId, planId, containerPort, envStr, cmdStr, argStr);
};

const parseApp = (app) => {
  if (!app) return null;
  try {
    return {
      ...app,
      env: app.env ? JSON.parse(app.env) : null,
      command: app.command ? JSON.parse(app.command) : null,
      args: app.args ? JSON.parse(app.args) : null
    };
  } catch (e) {
    return app;
  }
};

export const getAppById = (id) => {
  const app = db.prepare(`
    SELECT * FROM apps WHERE id = ?
  `).get(id);
  return parseApp(app);
};

export const listAppsByKey = (apiKey) => {
  const apps = db.prepare(`
    SELECT * FROM apps
    WHERE api_key = ?
    ORDER BY created_at DESC
  `).all(apiKey);
  return apps.map(parseApp);
};

export const listAppsByUserId = (userId) => {
  const apps = db.prepare(`
    SELECT * FROM apps
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId);
  return apps.map(parseApp);
};

export const deleteAppById = (id) => {
  db.prepare(`
    DELETE FROM apps WHERE id = ?
  `).run(id);
};

export const updateAppDetails = (id, { image, containerPort, env, command, args }) => {
  const envStr = env ? JSON.stringify(env) : null;
  const cmdStr = command ? JSON.stringify(command) : null;
  const argStr = args ? JSON.stringify(args) : null;

  db.prepare(`
    UPDATE apps SET 
      image = ?,
      container_port = ?,
      env = ?,
      command = ?,
      args = ?
    WHERE id = ?
  `).run(image, containerPort, envStr, cmdStr, argStr, id);
};
