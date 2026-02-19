import db from '../db/db.js';

export const insertApp = async (data) => {
  const {
    id, name, namespace, image, url, userId, planId,
    containerPort, env, command, args,
    type = 'app', storage = null,
    db_host = null, db_port = null, db_user = null, db_password = null, db_name = null
  } = data;

  const envStr = env ? JSON.stringify(env) : null;
  const cmdStr = command ? JSON.stringify(command) : null;
  const argStr = args ? JSON.stringify(args) : null;

  await db.query(`
    INSERT INTO apps (
      id, name, namespace, image, url, user_id, plan_id, 
      container_port, env, command, args, type, storage,
      db_host, db_port, db_user, db_password, db_name,
      last_charged_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW())
  `, [
    id, name, namespace, image, url, userId, planId,
    containerPort, envStr, cmdStr, argStr, type, storage,
    db_host, db_port, db_user, db_password, db_name
  ]);
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

export const listAppsByUserId = async (userId, type = 'app') => {
  const { rows } = await db.query(
    "SELECT * FROM apps WHERE user_id = $1 AND type = $2 AND status != 'deleted' ORDER BY created_at DESC",
    [userId, type]
  );
  return rows.map(parseApp);
};

export const deleteAppById = async (id) => {
  await db.query('DELETE FROM apps WHERE id = $1', [id]);
};

export const updateAppDetails = async (id, data) => {
  const {
    image, containerPort, env, command, args,
    db_host, db_port, db_user, db_password, db_name, status
  } = data;

  const envStr = env ? JSON.stringify(env) : null;
  const cmdStr = command ? JSON.stringify(command) : null;
  const argStr = args ? JSON.stringify(args) : null;

  const updates = [];
  const params = [id];

  if (image !== undefined) { updates.push(`image = $${params.push(image)}`); }
  if (containerPort !== undefined) { updates.push(`container_port = $${params.push(containerPort)}`); }
  if (env !== undefined) { updates.push(`env = $${params.push(envStr)}`); }
  if (command !== undefined) { updates.push(`command = $${params.push(cmdStr)}`); }
  if (args !== undefined) { updates.push(`args = $${params.push(argStr)}`); }
  if (db_host !== undefined) { updates.push(`db_host = $${params.push(db_host)}`); }
  if (db_port !== undefined) { updates.push(`db_port = $${params.push(db_port)}`); }
  if (db_user !== undefined) { updates.push(`db_user = $${params.push(db_user)}`); }
  if (db_password !== undefined) { updates.push(`db_password = $${params.push(db_password)}`); }
  if (db_name !== undefined) { updates.push(`db_name = $${params.push(db_name)}`); }
  if (status !== undefined) { updates.push(`status = $${params.push(status)}`); }

  if (updates.length > 0) {
    await db.query(`UPDATE apps SET ${updates.join(', ')} WHERE id = $1`, params);
  }
};
