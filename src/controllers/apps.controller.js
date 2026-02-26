import { v4 as uuidv4 } from 'uuid';
import k8sService from '../services/k8s.service.js';
import { baseDomain } from '../config/env.js';
import logger from '../utils/logger.js';
import {
  insertApp,
  getAppById,
  listAppsByUserId,
  deleteAppById,
  updateAppDetails
} from '../models/app.model.js';
import { getPlanById } from '../models/plan.model.js';
import { killAppCompletely } from '../services/app.service.js';
import imageService from '../services/image.service.js';
import { startPodBilling } from '../services/billing.service.js';
import db from '../db/db.js';
import { withRetry } from '../utils/retry.js';

export const createApp = async (req, res) => {
  try {
    const { image, port, planId = 'p-small', name, env, command, args, replicas = 1 } = req.body;
    const user = req.user;

    if (!name) {
      return res.status(400).json({ error: 'App name is required' });
    }

    // Sanitize name for k8s (lowercase, alphanumeric and hyphens only)
    const sanitizedName = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

    // Checking plan
    const plan = await getPlanById(planId);
    if (!plan) {
      return res.status(400).json({ error: 'invalid plan' });
    }

    // Guard: Block Kata plans until feature is enabled
    if (plan.runtime === 'kata') {
      return res.status(400).json({ error: 'Kata Container plans are coming soon and cannot be selected yet.' });
    }

    // Tiny plan restriction: 1 per account
    if (plan.id === 'p-tiny') {
      const existingApps = await listAppsByUserId(user.id);
      const tinyApp = existingApps.find(a => a.plan_id === 'p-tiny');
      if (tinyApp) {
        return res.status(403).json({ error: 'Tiny plan limit reached. You can only have 1 active Tiny pod.' });
      }
    }

    // Billing check (delegated to startPodBilling later, but good for early exit)
    if (plan.price_per_hour > 0 && user.balance < plan.price_per_hour) {
      return res.status(402).json({
        error: `insufficient balance. ${plan.name} plan requires at least ₹${plan.price_per_hour} (1 hour reserve) to start`
      });
    }

    if (!image) {
      return res.status(400).json({
        error: 'image is required'
      });
    }

    // Auto-detect port from image if not provided
    let containerPort = port;
    if (!containerPort) {
      containerPort = await imageService.getExposedPort(image);
    }
    const servicePort = 80;

    const appId = uuidv4();
    const shortId = appId.split('-')[0];
    const namespace = `user-${user.id}`;
    const host = `app-${shortId}.${baseDomain}`;
    const url = `https://${host}`;

    const resourceName = `app-${shortId}`;

    // 1. Insert stopped app record first
    await insertApp({
      id: appId,
      name,
      namespace,
      image,
      url,
      userId: user.id,
      planId: plan.id,
      containerPort,
      env,
      command,
      args,
      replicas
    });

    // 2. Start billing (reserves 1 hour, sets status to 'running')
    if (plan.price_per_hour > 0) {
      try {
        await startPodBilling(appId, user.id, plan.price_per_hour, undefined, replicas);
      } catch (err) {
        await deleteAppById(appId);
        return res.status(402).json({ error: err.message });
      }
    } else {
      // For free plan, just mark it as running in DB
      const now = Math.floor(Date.now() / 1000);
      await db.query(
        "UPDATE apps SET status = 'running', started_at = $1, last_billed_at = $2 WHERE id = $3",
        [now, now, appId]
      );
    }

    // 3. Create K8s infrastructure
    try {
      await k8sService.createNamespace(namespace);
      await k8sService.createQuota(namespace);
      await k8sService.createDeployment({ name: resourceName, namespace, image, containerPort, plan, env, command, args, replicas });
      await k8sService.createService({ name: resourceName, namespace, servicePort, containerPort });
      await k8sService.createIngress({ name: resourceName, namespace, host, port: servicePort });
    } catch (k8sErr) {
      logger.error('K8s creation failed, rolling back', k8sErr);
      await killAppCompletely({ id: appId, namespace, type: 'app' }).catch(() => { });
      throw new Error(`Cloud deployment failed: ${k8sErr.message}`);
    }

    return res.status(201).json({ id: appId, name, url, status: 'deploying' });
  } catch (err) {
    logger.error('createApp error', err);
    res.status(500).json({ error: err.message });
  }
};

export const listApps = async (req, res) => {
  const apps = await listAppsByUserId(req.user.id);
  res.json(apps);
};

export const getApp = async (req, res) => {
  try {
    const app = await getAppById(req.params.id);

    if (!app || app.user_id !== req.user.id) {
      return res.status(404).json({ error: 'app not found' });
    }

    const shortId = app.id.split('-')[0];
    const resourceName = app.type === 'database' ? `db-${shortId}` : `app-${shortId}`;

    const status = await k8sService.getAppStatus(resourceName, app.namespace);
    const metrics = await k8sService.getPodMetrics(app.namespace, resourceName);
    res.json({ ...app, status, metrics });
  } catch (err) {
    logger.error('Error fetching app details', err?.message || err);
    res.status(500).json({ error: 'Failed to fetch app details' });
  }
};

export const getAppLogs = async (req, res) => {
  try {
    const app = await getAppById(req.params.id);

    if (!app || app.user_id !== req.user.id) {
      return res.status(404).json({ error: 'app not found' });
    }

    const shortId = app.id.split('-')[0];
    const resourceName = app.type === 'database' ? `db-${shortId}` : `app-${shortId}`;
    const logs = await k8sService.getLogs(resourceName, app.namespace);
    res.json({ logs });
  } catch (err) {
    logger.error('Error fetching app logs', err?.message || err);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
};

export const updateApp = async (req, res) => {
  try {
    const app = await getAppById(req.params.id);

    if (!app || app.user_id !== req.user.id) {
      return res.status(404).json({ error: 'app not found' });
    }

    if (app.status !== 'running') {
      return res.status(400).json({ error: 'App must be running to update. Start the app first.' });
    }

    const { image, port, env, command, args, replicas } = req.body;

    if (!image && !port && env === undefined && command === undefined && args === undefined && replicas === undefined) {
      return res.status(400).json({ error: 'At least one field must be provided' });
    }

    const plan = await getPlanById(app.plan_id);

    // Resolve each field: use provided value or fall back to stored value
    const newImage = image !== undefined ? image : app.image;
    let newPort = port !== undefined ? parseInt(port, 10) : app.container_port;
    const newEnv = env !== undefined ? env : (app.env || null);
    const newCommand = command !== undefined ? command : (app.command || null);
    const newArgs = args !== undefined ? args : (app.args || null);
    const newReplicas = replicas !== undefined ? parseInt(replicas, 10) : (app.replicas || 1);

    // Auto-detect port if image changed but port was not explicitly provided
    if (image && image !== app.image && port === undefined) {
      newPort = await imageService.getExposedPort(image);
    }

    const shortId = app.id.split('-')[0];
    const resourceName = `app-${shortId}`;

    await k8sService.updateDeployment({
      name: resourceName,
      namespace: app.namespace,
      image: newImage,
      containerPort: newPort,
      plan,
      env: newEnv,
      command: newCommand,
      args: newArgs,
      replicas: newReplicas,
    });

    await updateAppDetails(app.id, {
      image: newImage,
      containerPort: newPort,
      env: newEnv,
      command: newCommand,
      args: newArgs,
      replicas: newReplicas,
    });

    return res.json({
      id: app.id,
      name: app.name,
      url: app.url,
      status: 'updating',
      message: 'Rolling update initiated. Zero-downtime deployment in progress.',
    });
  } catch (err) {
    logger.error('Error updating app', err?.message || err);
    res.status(500).json({ error: err.message });
  }
};

export const deleteApp = async (req, res) => {
  const app = await getAppById(req.params.id);

  if (!app || app.user_id !== req.user.id) {
    return res.status(404).json({ error: 'app not found' });
  }

  await killAppCompletely(app);

  res.json({ deleted: true });
};
