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
    const { image, port, planId = 'p-small', name, env, command, args, replicas = 1, alias } = req.body;
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
        error: `insufficient balance. ${plan.name} plan requires at least ₹${(plan.price_per_hour / 100).toFixed(2)} (1 hour reserve) to start`
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
    const host = `${sanitizedName}-${shortId}.${baseDomain}`;
    // Use http for local development (localhost), https for production
    const protocol = baseDomain === 'localhost' ? 'http' : 'https';
    const url = `${protocol}://${host}`;

    // Enforce Tiny plan restriction: exactly 1 replica
    let finalReplicas = replicas;
    if (plan.id === 'p-tiny') {
      finalReplicas = 1;
    }

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
      replicas: finalReplicas
    });

    // 2. Start billing (reserves 1 hour, sets status to 'running')
    if (plan.price_per_hour > 0) {
      try {
        await startPodBilling(appId, user.id, plan.price_per_hour, undefined, finalReplicas);
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
      // Option A: Pre-flight check — is the image publicly accessible?
      // If yes, skip imagePullSecrets entirely regardless of stored credentials.
      // If no (private or check failed), use the user's credentials if available.
      const imageIsPublic = await imageService.isPublicImage(image);

      // Sync registry secret if user has provided credentials
      let hasRegistrySecret = false;
      if (!imageIsPublic && user.docker_username && user.docker_token) {
        await k8sService.syncUserRegistrySecret(namespace, user.docker_username, user.docker_token);
        hasRegistrySecret = true;
      }

      await k8sService.createDeployment({ name: resourceName, namespace, image, containerPort, plan, env, command, args, replicas: finalReplicas, hasRegistrySecret });
      await k8sService.createService({ name: resourceName, namespace, servicePort, containerPort });
      await k8sService.createIngress({ name: resourceName, namespace, host, port: servicePort });
    } catch (k8sErr) {
      logger.error('K8s creation failed, rolling back', k8sErr);
      await killAppCompletely({ id: appId, namespace, type: 'app' }).catch(() => { });
      throw new Error(`Cloud deployment failed: ${k8sErr.message}`);
    }

    // 4. Apply alias if provided
    let aliasWarning = null;
    if (alias && typeof alias === 'string') {
      const cleanAlias = alias.toLowerCase().trim();
      const aliasHost = `${cleanAlias}.${baseDomain}`;
      try {
        await k8sService.updateIngressHosts(resourceName, namespace, [host, aliasHost]);
        await updateAppDetails(appId, { alias: cleanAlias });
      } catch (aliasErr) {
        logger.warn('Alias setup failed at launch (non-fatal)', aliasErr.message);
        aliasWarning = `App deployed successfully, but alias "${cleanAlias}" could not be set (it may be taken). You can set it later from the edit panel.`;
      }
    }

    return res.status(201).json({ id: appId, name, url, status: 'deploying', ...(aliasWarning ? { aliasWarning } : {}) });
  } catch (err) {
    logger.error('createApp error', err);
    res.status(500).json({ error: err.message });
  }
};

export const listApps = async (req, res) => {
  try {
    const apps = await listAppsByUserId(req.user.id, 'app');

    // Sync status with k8s for each app to ensure dashboard accuracy
    const syncedApps = await Promise.all(apps.map(async (app) => {
      const shortId = app.id.split('-')[0];
      const resourceName = `app-${shortId}`;

      // Get real-time status from k8s
      const currentStatus = await k8sService.getAppStatus(resourceName, app.namespace);

      // If DB says stopped but k8s says unknown/missing, keep it as stopped
      if (currentStatus === 'unknown' && app.status === 'stopped') {
        return app;
      }

      return { ...app, status: currentStatus || app.status };
    }));

    res.json(syncedApps);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    let newReplicas = replicas !== undefined ? parseInt(replicas, 10) : (app.replicas || 1);

    // Enforce Tiny plan restriction
    if (app.plan_id === 'p-tiny') {
      newReplicas = 1;
    }

    // Auto-detect port if image changed but port was not explicitly provided
    if (image && image !== app.image && port === undefined) {
      newPort = await imageService.getExposedPort(image);
    }

    const shortId = app.id.split('-')[0];
    const resourceName = `app-${shortId}`;

    const user = req.user;
    let hasRegistrySecret = false;
    if (user.docker_username && user.docker_token) {
      await k8sService.syncUserRegistrySecret(app.namespace, user.docker_username, user.docker_token);
      hasRegistrySecret = true;
    }

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
      hasRegistrySecret,
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

// ── Alias management ──────────────────────────────────────────────────────────

const ALIAS_BLOCKLIST = new Set([
  'www', 'api', 'admin', 'mail', 'dashboard', 'billing', 'app',
  'wrexer', 'support', 'dev', 'staging', 'ns', 'ftp', 'smtp',
  'cdn', 'static', 'assets', 'auth', 'login', 'signup', 'register',
]);

const ALIAS_REGEX = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

export const setAlias = async (req, res) => {
  const app = await getAppById(req.params.id);
  if (!app || app.user_id !== req.user.id) {
    return res.status(404).json({ error: 'app not found' });
  }
  if (app.type !== 'app') {
    return res.status(400).json({ error: 'Aliases are only supported for apps, not databases.' });
  }

  const { slug } = req.body;
  if (!slug || typeof slug !== 'string') {
    return res.status(400).json({ error: 'slug is required' });
  }

  const cleanSlug = slug.toLowerCase().trim();

  if (!ALIAS_REGEX.test(cleanSlug)) {
    return res.status(400).json({ error: 'Invalid slug. Use 3–30 lowercase letters, numbers, and hyphens (must start and end with a letter or number).' });
  }

  if (ALIAS_BLOCKLIST.has(cleanSlug)) {
    return res.status(400).json({ error: `"${cleanSlug}" is reserved and cannot be used as an alias.` });
  }

  const aliasHost = `${cleanSlug}.${baseDomain}`;
  const shortId = app.id.split('-')[0];
  const resourceName = `app-${shortId}`;

  // Block if this app already has a RESERVED alias assigned to it
  const { rows: reservedRows } = await db.query(
    `SELECT ra.slug FROM reserved_aliases ra WHERE ra.assigned_app_id = $1 AND ra.status = 'active'`,
    [app.id]
  );
  if (reservedRows.length > 0) {
    return res.status(409).json({
      error: `This app has the reserved alias "${reservedRows[0].slug}.wrexer.com" assigned. Remove it from the Aliases page first before setting a free alias.`
    });
  }

  try {
    // Patch Ingress first — if it fails we don't touch the DB
    await k8sService.updateIngressHosts(resourceName, app.namespace, [
      app.url.replace(/^https?:\/\//, ''), // original host
      aliasHost,
    ]);
  } catch (k8sErr) {
    logger.error('Failed to patch ingress for alias', k8sErr);
    return res.status(500).json({ error: 'Failed to update routing. Try again.' });
  }

  try {
    await updateAppDetails(app.id, { alias: cleanSlug });
  } catch (dbErr) {
    // UNIQUE violation — slug already taken
    if (dbErr.code === '23505') {
      // Rollback ingress to single host
      await k8sService.updateIngressHosts(resourceName, app.namespace, [
        app.url.replace(/^https?:\/\//, ''),
      ]).catch(() => { });
      return res.status(409).json({ error: `"${cleanSlug}" is already taken. Choose a different alias.` });
    }
    throw dbErr;
  }

  const protocol = baseDomain === 'localhost' ? 'http' : 'https';
  return res.json({
    success: true,
    alias: cleanSlug,
    aliasUrl: `${protocol}://${aliasHost}`,
  });
};

export const removeAlias = async (req, res) => {
  const app = await getAppById(req.params.id);
  if (!app || app.user_id !== req.user.id) {
    return res.status(404).json({ error: 'app not found' });
  }
  if (!app.alias) {
    return res.status(400).json({ error: 'This app has no alias set.' });
  }

  const shortId = app.id.split('-')[0];
  const resourceName = `app-${shortId}`;

  // Restore Ingress to single host
  await k8sService.updateIngressHosts(resourceName, app.namespace, [
    app.url.replace(/^https?:\/\//, ''),
  ]);

  await updateAppDetails(app.id, { alias: null });

  return res.json({ success: true });
};

export const checkAliasAvailability = async (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'slug is required' });

  const cleanSlug = slug.toLowerCase().trim();

  // Re-use the same validation constants
  const BLOCKED = new Set([
    'www', 'api', 'admin', 'mail', 'dashboard', 'billing', 'app',
    'wrexer', 'support', 'dev', 'staging', 'ns', 'ftp', 'smtp',
    'cdn', 'static', 'assets', 'auth', 'login', 'signup', 'register',
  ]);
  const REGEX = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

  if (!REGEX.test(cleanSlug)) {
    return res.json({ available: false, reason: 'Invalid format. Use 3–30 lowercase letters, numbers, and hyphens.' });
  }
  if (BLOCKED.has(cleanSlug)) {
    return res.json({ available: false, reason: `"${cleanSlug}" is a reserved name.` });
  }

  const { rows } = await db.query('SELECT id FROM apps WHERE alias = $1', [cleanSlug]);
  return res.json({ available: rows.length === 0 });
};
