/**
 * agent.controller.js
 *
 * All handlers for routes called by WrexForge pods via the wrexer CLI.
 * Auth: Bearer <agent_token> (resolved by agentAuthMiddleware in agent.routes.js)
 */

import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import k8sService from '../services/k8s.service.js';
import { baseDomain } from '../config/env.js';
import logger from '../utils/logger.js';
import {
  insertApp,
  getAppById,
  listAppsByUserId,
} from '../models/app.model.js';
import { getPlanById } from '../models/plan.model.js';
import { killAppCompletely } from '../services/app.service.js';
import { startPodBilling, stopPodBilling } from '../services/billing.service.js';
import imageService from '../services/image.service.js';
import db from '../db/db.js';

const genPass = () => crypto.randomBytes(16).toString('hex');
const genUser = () => 'u_' + crypto.randomBytes(4).toString('hex');
const genDb   = () => 'db_' + crypto.randomBytes(4).toString('hex');

// ── GET /api/agent/context ───────────────────────────────────────────────────
export const agentGetContext = async (req, res) => {
  try {
    const user = req.user;

    // Plans (app + db, no kata)
    const { rows: plans } = await db.query(
      `SELECT id, name, cpu, memory, price_per_hour, storage, runtime
       FROM plans WHERE runtime != 'kata' ORDER BY price_per_hour ASC`
    );

    // Apps
    const apps = await listAppsByUserId(user.id, 'app');
    const databases = await listAppsByUserId(user.id, 'database');

    res.json({
      balance: user.balance,
      balance_display: `₹${(user.balance / 100).toFixed(2)}`,
      namespace: `user-${user.id}`,
      docker_username: user.docker_username || null,
      plans: plans.map(p => ({
        id: p.id,
        name: p.name,
        cpu: p.cpu,
        memory: p.memory,
        price_per_hour: p.price_per_hour,
        price_display: p.price_per_hour === 0 ? 'Free' : `₹${(p.price_per_hour / 100).toFixed(2)}/hr`,
        storage: p.storage || null,
      })),
      apps: apps.filter(a => a.status !== 'deleted').map(a => ({
        id: a.id,
        name: a.name,
        status: a.status,
        url: a.url,
        plan_id: a.plan_id,
        created_at: a.created_at,
      })),
      databases: databases.filter(d => d.status !== 'deleted').map(d => ({
        id: d.id,
        name: d.name,
        status: d.status,
        host: d.db_host || null,
        port: d.db_port || 5432,
        db_name: d.db_name,
        db_user: d.db_user,
        plan_id: d.plan_id,
        created_at: d.created_at,
      })),
    });
  } catch (err) {
    logger.error('agentGetContext error', err);
    res.status(500).json({ error: err.message });
  }
};

// ── POST /api/agent/estimate ─────────────────────────────────────────────────
export const agentEstimate = async (req, res) => {
  try {
    const { app_plan, db_plan } = req.body;
    if (!app_plan) return res.status(400).json({ error: 'app_plan is required' });

    const plan = await getPlanById(app_plan.startsWith('p-') ? app_plan : `p-${app_plan}`);
    if (!plan) return res.status(400).json({ error: `Unknown app plan: ${app_plan}` });

    let dbPlan = null;
    let dbStorageRate = 0;
    if (db_plan) {
      dbPlan = await getPlanById(db_plan.startsWith('db-') ? db_plan : `db-${db_plan}`);
      if (!dbPlan) return res.status(400).json({ error: `Unknown db plan: ${db_plan}` });
      const storageGB = parseInt(dbPlan.storage?.replace('Gi', '') || '0');
      dbStorageRate = storageGB * 3; // 3 paise per GB/hr
    }

    const appRate = plan.price_per_hour;
    const dbRate  = dbPlan ? dbPlan.price_per_hour + dbStorageRate : 0;
    const total   = appRate + dbRate;
    const balance = req.user.balance;
    const hoursRemaining = total > 0 ? Math.floor(balance / total) : Infinity;

    res.json({
      app_plan: { id: plan.id, name: plan.name, hourly: appRate, display: `₹${(appRate/100).toFixed(2)}/hr` },
      db_plan: dbPlan ? { id: dbPlan.id, name: dbPlan.name, hourly: dbRate, display: `₹${(dbRate/100).toFixed(2)}/hr` } : null,
      total_hourly: total,
      total_monthly: Math.round(total * 720),
      total_display: `₹${(total/100).toFixed(2)}/hr (~₹${((total*720)/100).toFixed(0)}/mo)`,
      balance: balance,
      balance_display: `₹${(balance/100).toFixed(2)}`,
      balance_ok: balance >= total,
      hours_remaining: hoursRemaining === Infinity ? 'unlimited (free plan)' : `~${hoursRemaining} hours`,
    });
  } catch (err) {
    logger.error('agentEstimate error', err);
    res.status(500).json({ error: err.message });
  }
};

// ── GET /api/agent/apps ──────────────────────────────────────────────────────
export const agentListApps = async (req, res) => {
  try {
    const apps = await listAppsByUserId(req.user.id, 'app');
    res.json({
      apps: apps.filter(a => a.status !== 'deleted').map(a => ({
        id: a.id,
        name: a.name,
        status: a.status,
        url: a.url,
        plan_id: a.plan_id,
        created_at: a.created_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── GET /api/agent/databases ─────────────────────────────────────────────────
export const agentListDatabases = async (req, res) => {
  try {
    const dbs = await listAppsByUserId(req.user.id, 'database');
    res.json({
      databases: dbs.filter(d => d.status !== 'deleted').map(d => ({
        id: d.id,
        name: d.name,
        status: d.status,
        host: d.db_host,
        port: d.db_port || 5432,
        db_name: d.db_name,
        db_user: d.db_user,
        plan_id: d.plan_id,
        created_at: d.created_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── GET /api/agent/databases/:id/creds ───────────────────────────────────────
export const agentDatabaseCreds = async (req, res) => {
  try {
    const app = await getAppById(req.params.id);
    if (!app || app.user_id !== req.user.id || app.type !== 'database') {
      return res.status(404).json({ error: 'Database not found' });
    }
    if (app.status === 'deleted') return res.status(404).json({ error: 'Database deleted' });

    res.json({
      id: app.id,
      name: app.name,
      host: app.db_host,
      port: app.db_port || 5432,
      db_name: app.db_name,
      db_user: app.db_user,
      db_password: app.db_password,
      database_url: `postgres://${app.db_user}:${app.db_password}@${app.db_host}:${app.db_port || 5432}/${app.db_name}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── POST /api/agent/database ─────────────────────────────────────────────────
export const agentCreateDatabase = async (req, res) => {
  try {
    const user = req.user;
    const { name, planId = 'db-small' } = req.body;

    if (!name) return res.status(400).json({ error: 'name is required' });

    const plan = await getPlanById(planId);
    if (!plan || !plan.storage) return res.status(400).json({ error: `Invalid db plan: ${planId}` });

    if (plan.price_per_hour > 0 && user.balance < plan.price_per_hour) {
      return res.status(402).json({
        error: `Insufficient balance. ${plan.name} requires ₹${(plan.price_per_hour/100).toFixed(2)} to start.`,
      });
    }

    const appId     = uuidv4();
    const shortId   = appId.split('-')[0];
    const namespace = `user-${user.id}`;
    const resName   = `db-${shortId}`;
    const pvcName   = `data-db-${shortId}`;
    const dbUser    = genUser();
    const dbPass    = genPass();
    const dbName    = genDb();

    const storageGB   = parseInt(plan.storage.replace('Gi', '')) || 0;
    const storageRate = storageGB * 3;
    const combined    = plan.price_per_hour + storageRate;

    await insertApp({
      id: appId, name, namespace,
      image: 'postgres:16-alpine',
      url: `postgres://${dbUser}:${dbPass}@${resName}.${namespace}.svc.cluster.local:5432/${dbName}`,
      userId: user.id, planId: plan.id,
      type: 'database', storage: plan.storage,
      storage_hourly_rate: storageRate,
      db_user: dbUser, db_password: dbPass, db_name: dbName,
      status: 'provisioning',
    });

    if (combined > 0) {
      try {
        await startPodBilling(appId, user.id, combined, plan.price_per_hour);
      } catch (e) {
        await db.query("UPDATE apps SET status='deleted' WHERE id=$1", [appId]);
        return res.status(402).json({ error: e.message });
      }
    }

    try {
      await k8sService.createPVC({ namespace, name: pvcName, size: plan.storage });
      await k8sService.createDatabaseDeployment({
        name: resName, namespace, plan,
        dbUser, dbPassword: dbPass, dbName, pvcName,
      });
      await k8sService.createDatabaseService({ name: resName, namespace });

      const host = `${resName}.${namespace}.svc.cluster.local`;
      await db.query(
        "UPDATE apps SET db_host=$1, db_port=$2, status='running' WHERE id=$3",
        [host, 5432, appId]
      );

      return res.status(201).json({
        id: appId, name, status: 'provisioning',
        host, port: 5432, db_name: dbName, db_user: dbUser,
        database_url: `postgres://${dbUser}:${dbPass}@${host}:5432/${dbName}`,
      });
    } catch (k8sErr) {
      logger.error('agentCreateDatabase K8s error', k8sErr);
      await db.query("UPDATE apps SET status='error' WHERE id=$1", [appId]);
      return res.status(500).json({ error: `DB provisioning failed: ${k8sErr.message}` });
    }
  } catch (err) {
    logger.error('agentCreateDatabase error', err);
    res.status(500).json({ error: err.message });
  }
};

// ── POST /api/agent/apps/:id/stop ───────────────────────────────────────────
export const agentStopApp = async (req, res) => {
  try {
    const app = await getAppById(req.params.id);
    if (!app || app.user_id !== req.user.id) return res.status(404).json({ error: 'App not found' });
    if (app.status === 'stopped') return res.status(400).json({ error: 'App already stopped' });

    const shortId  = app.id.split('-')[0];
    const resName  = `app-${shortId}`;

    await k8sService.deleteNamespacedDeployment(resName, app.namespace).catch(() => {});
    await k8sService.deleteNamespacedService(resName, app.namespace).catch(() => {});
    await stopPodBilling(app.id);
    await db.query("UPDATE apps SET status='stopped' WHERE id=$1", [app.id]);

    res.json({ status: 'stopped', id: app.id, name: app.name });
  } catch (err) {
    logger.error('agentStopApp error', err);
    res.status(500).json({ error: err.message });
  }
};

// ── DELETE /api/agent/apps/:id ───────────────────────────────────────────────
export const agentDeleteApp = async (req, res) => {
  try {
    const app = await getAppById(req.params.id);
    if (!app || app.user_id !== req.user.id) return res.status(404).json({ error: 'App not found' });

    await killAppCompletely(app);
    res.json({ deleted: true, id: app.id, name: app.name });
  } catch (err) {
    logger.error('agentDeleteApp error', err);
    res.status(500).json({ error: err.message });
  }
};

// ── POST /api/agent/databases/:id/stop ──────────────────────────────────────
export const agentStopDatabase = async (req, res) => {
  try {
    const app = await getAppById(req.params.id);
    if (!app || app.user_id !== req.user.id || app.type !== 'database') {
      return res.status(404).json({ error: 'Database not found' });
    }
    if (app.status === 'stopped') return res.status(400).json({ error: 'Database already stopped' });

    const shortId = app.id.split('-')[0];
    const resName = `db-${shortId}`;

    await k8sService.deleteNamespacedDeployment(resName, app.namespace).catch(() => {});
    await k8sService.deleteNamespacedService(resName, app.namespace).catch(() => {});
    await stopPodBilling(app.id);
    await db.query("UPDATE apps SET status='stopped' WHERE id=$1", [app.id]);

    res.json({ status: 'stopped', id: app.id, name: app.name });
  } catch (err) {
    logger.error('agentStopDatabase error', err);
    res.status(500).json({ error: err.message });
  }
};

// ── DELETE /api/agent/databases/:id ─────────────────────────────────────────
export const agentDeleteDatabase = async (req, res) => {
  try {
    const app = await getAppById(req.params.id);
    if (!app || app.user_id !== req.user.id || app.type !== 'database') {
      return res.status(404).json({ error: 'Database not found' });
    }

    await stopPodBilling(app.id, true);

    const shortId = app.id.split('-')[0];
    const resName = `db-${shortId}`;
    const pvcName = `data-db-${shortId}`;

    await k8sService.deleteNamespacedDeployment(resName, app.namespace).catch(() => {});
    await k8sService.deleteNamespacedService(resName, app.namespace).catch(() => {});
    await k8sService.deleteNamespacedPVC(pvcName, app.namespace).catch(() => {});
    await db.query("UPDATE apps SET status='deleted' WHERE id=$1", [app.id]);

    res.json({ deleted: true, id: app.id, name: app.name });
  } catch (err) {
    logger.error('agentDeleteDatabase error', err);
    res.status(500).json({ error: err.message });
  }
};

// ── GET /api/agent/apps/:id/logs ─────────────────────────────────────────────
export const agentGetAppLogs = async (req, res) => {
  try {
    const app = await getAppById(req.params.id);
    if (!app || app.user_id !== req.user.id) {
      return res.status(404).json({ error: 'App or database not found' });
    }
    if (app.status === 'deleted') {
      return res.status(404).json({ error: 'Resource deleted' });
    }

    const shortId = app.id.split('-')[0];
    const isDb = app.type === 'database';
    const resName = isDb ? `db-${shortId}` : `app-${shortId}`;
    const containerName = isDb ? 'postgres' : 'app';

    const logs = await k8sService.getLogs(resName, app.namespace, containerName);
    res.json({ logs });
  } catch (err) {
    logger.error('agentGetAppLogs error', err);
    res.status(500).json({ error: err.message });
  }
};

