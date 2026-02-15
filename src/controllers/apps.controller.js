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
import { updateUserBalance } from '../models/user.model.js';
import { killAppCompletely } from '../services/app.service.js';
import imageService from '../services/image.service.js';
import { startPodBilling } from '../services/billing.service.js';
import db from '../db/db.js'; // Added to ensure free plan logic is safe

export const createApp = async (req, res) => {
  try {
    const { image, port, planId = 'p-small', name, env, command, args } = req.body;
    const apiKey = req.apiKey;
    const user = req.user;

    if (!name) {
      return res.status(400).json({ error: 'App name is required' });
    }

    // Sanitize name for k8s (lowercase, alphanumeric and hyphens only)
    const sanitizedName = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

    // Checking plan
    const plan = getPlanById(planId);
    if (!plan) {
      return res.status(400).json({ error: 'invalid plan' });
    }

    // Tiny plan restriction: 1 per account
    if (plan.id === 'p-tiny') {
      const existingApps = listAppsByUserId(user.id);
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
    const planName = plan.id.replace('p-', '');
    // Namespace: name-plan-random
    const namespace = `${sanitizedName}-${planName}-${appId.split('-')[0]}`;
    const host = `${namespace}.${baseDomain}`;
    const url = `https://${host}`;

    // 1. Insert stopped app record first
    insertApp({
      id: appId,
      name,
      namespace,
      image,
      url,
      apiKey,
      userId: user.id,
      planId: plan.id,
      containerPort,
      env,
      command,
      args
    });

    // 2. Start billing (reserves 1 hour, sets status to 'running')
    if (plan.price_per_hour > 0) {
      try {
        startPodBilling(appId, user.id, plan.price_per_hour);
      } catch (err) {
        // Cleanup if billing fails
        deleteAppById(appId);
        return res.status(402).json({ error: err.message });
      }
    } else {
      // For free plan, just mark it as running in DB
      db.prepare("UPDATE apps SET status = 'running', started_at = ?, last_billed_at = ? WHERE id = ?")
        .run(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), appId);
    }

    // 3. Create K8s infrastructure
    try {
      await k8sService.createNamespace(namespace);
      await k8sService.createQuota(namespace);
      await k8sService.createDeployment({ namespace, image, containerPort, plan, env, command, args });
      await k8sService.createService({ namespace, servicePort, containerPort });
      await k8sService.createIngress({ namespace, host, port: servicePort });
    } catch (k8sErr) {
      logger.error('K8s creation failed, rolling back billing', k8sErr);
      await killAppCompletely({ id: appId, namespace });
      throw new Error(`Cloud deployment failed: ${k8sErr.message}`);
    }

    res.status(201).json({
      id: appId,
      name,
      url,
      status: 'deploying'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const listApps = async (req, res) => {
  // If we have a user, list by user id. Fallback to key if necessary, 
  // but we enforce req.user in middleware now.
  const apps = listAppsByUserId(req.user.id);
  res.json(apps);
};

export const getApp = async (req, res) => {
  try {
    const app = getAppById(req.params.id);

    if (!app || app.api_key !== req.apiKey) {
      return res.status(404).json({ error: 'app not found' });
    }

    const status = await k8sService.getAppStatus(app.namespace);
    const metrics = await k8sService.getPodMetrics(app.namespace);
    res.json({ ...app, status, metrics });
  } catch (err) {
    logger.error('Error fetching app details', err?.message || err);
    res.status(500).json({ error: 'Failed to fetch app details' });
  }
};

export const getAppLogs = async (req, res) => {
  try {
    const app = getAppById(req.params.id);

    if (!app || app.api_key !== req.apiKey) {
      return res.status(404).json({ error: 'app not found' });
    }

    const logs = await k8sService.getLogs(app.namespace);
    res.json({ logs });
  } catch (err) {
    logger.error('Error fetching app logs', err?.message || err);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
};

export const updateApp = async (req, res) => {
  try {
    const app = getAppById(req.params.id);

    if (!app || app.api_key !== req.apiKey) {
      return res.status(404).json({ error: 'app not found' });
    }

    if (app.status !== 'running') {
      return res.status(400).json({ error: 'App must be running to update. Start the app first.' });
    }

    const { image, port, env, command, args } = req.body;

    // At least one field must be provided
    if (!image && !port && (env === undefined) && (command === undefined) && (args === undefined)) {
      return res.status(400).json({ error: 'At least one field (image, port, env, command, args) must be provided' });
    }

    const plan = getPlanById(app.plan_id);

    const newImage = image || app.image;
    let newPort = port || app.container_port;
    const newEnv = env !== undefined ? env : (app.env || null);
    const newCommand = command !== undefined ? command : (app.command || null);
    const newArgs = args !== undefined ? args : (app.args || null);

    // If image changed and no port specified, auto-detect new port
    if (image && image !== app.image && !port) {
      newPort = await imageService.getExposedPort(image);
    }

    // Rolling update in K8s (zero-downtime: maxSurge=1, maxUnavailable=0)
    await k8sService.updateDeployment({
      namespace: app.namespace,
      image: newImage,
      containerPort: newPort,
      plan,
      env: newEnv,
      command: newCommand,
      args: newArgs
    });

    // Persist changes to DB
    updateAppDetails(app.id, {
      image: newImage,
      containerPort: newPort,
      env: newEnv,
      command: newCommand,
      args: newArgs
    });

    res.json({
      id: app.id,
      name: app.name,
      url: app.url,
      status: 'updating',
      message: 'Rolling update initiated. Zero-downtime deployment in progress.'
    });
  } catch (err) {
    logger.error('Error updating app', err?.message || err);
    res.status(500).json({ error: err.message });
  }
};

export const deleteApp = async (req, res) => {
  const app = getAppById(req.params.id);

  if (!app || app.api_key !== req.apiKey) {
    return res.status(404).json({ error: 'app not found' });
  }

  await killAppCompletely(app);

  res.json({ deleted: true });
};

