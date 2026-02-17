import db from '../db/db.js';

export const insertApp = async ({ id, name, namespace, image, url, userId, planId, containerPort, env, command, args }) => {
  const envStr = env ? JSON.stringify(env) : null;
  const cmdStr = command ? JSON.stringify(command) : null;
  const argStr = args ? JSON.stringify(args) : null;

  await db.query(`
    INSERT INTO apps (id, name, namespace, image, url, user_id, plan_id, container_port, env, command, args, last_charged_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
  `, [id, name, namespace, image, url, userId, planId, containerPort, envStr, cmdStr, argStr]);
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

export const getAppById = async (id) => {
  const { rows } = await db.query('SELECT * FROM apps WHERE id = $1', [id]);
  return parseApp(rows[0] || null);
};

export const listAppsByUserId = async (userId) => {
  const { rows } = await db.query(
    'SELECT * FROM apps WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return rows.map(parseApp);
};

export const deleteAppById = async (id) => {
  await db.query('DELETE FROM apps WHERE id = $1', [id]);
};

export const updateAppDetails = async (id, { image, containerPort, env, command, args }) => {
  const envStr = env ? JSON.stringify(env) : null;
  const cmdStr = command ? JSON.stringify(command) : null;
  const argStr = args ? JSON.stringify(args) : null;

  await db.query(`
    UPDATE apps SET 
      image = $1,
      container_port = $2,
      env = $3,
      command = $4,
      args = $5
    WHERE id = $6
  `, [image, containerPort, envStr, cmdStr, argStr, id]);
};
