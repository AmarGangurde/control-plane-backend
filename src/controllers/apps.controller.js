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
import { startPodBilling, stopPodBilling } from '../services/billing.service.js';
import db from '../db/db.js';
import { withRetry } from '../utils/retry.js';
import * as emailService from '../services/email.service.js';

export const createApp = async (req, res) => {
  try {
    let { image, port, planId = 'p-small', name, env, command, args, replicas = 1, alias } = req.body;
    const type = req.body.type || 'app';
    const user = req.user;

    if (!name) {
      return res.status(400).json({ error: 'App name is required' });
    }

    // ── Service overrides (type='service') ────────────────────────────────────
    // When launching a managed first-party service (e.g. OpenClaw Workspace)
    // all resource choices are fixed by Wrexer — the user only provides secrets
    // via the wizard, which arrive in req.body.serviceEnv.
    let pvcMount = null;
    if (type === 'service') {
      image    = 'ghcr.io/amargangurde/openclaw:latest';
      port     = 18789;
      planId   = 'db-small'; // same plan tier as databases — has 5Gi storage built-in
      replicas = 1;
      alias    = undefined; // aliases not supported for services

      // User-supplied secrets come through serviceEnv from the wizard
      const serviceEnv = req.body.serviceEnv || {};
      const apiBase = process.env.FRONTEND_URL
        ? `${process.env.FRONTEND_URL}/api`
        : `https://${process.env.BASE_DOMAIN || 'wrexer.com'}/api`;

      env = [
        { name: 'WREXER_API_URL',     value: apiBase },
        { name: 'WREXER_AGENT_TOKEN', value: user.agent_token || '' },
        { name: 'WREXER_NAMESPACE',   value: `user-${user.id}` },
        ...Object.entries(serviceEnv).map(([k, v]) => ({ name: k, value: String(v) })),
      ];

      if (user.docker_username && user.docker_token) {
        env.push({ name: 'DOCKER_USERNAME', value: user.docker_username });
        env.push({ name: 'DOCKER_PASSWORD', value: user.docker_token });
      }

      command = null;
      args    = null;
      pvcMount = null; // set after shortId is known below
    }
    // ─────────────────────────────────────────────────────────────────────────

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
    let loopbackBind = req.body.loopbackBind === true; // explicit user override
    if (!containerPort) {
      const detected = await imageService.getExposedPort(image, user.docker_username, user.docker_token);
      // getExposedPort now returns { port, loopbackBind } — handle both shapes for safety
      if (detected && typeof detected === 'object') {
        containerPort = detected.port;
        // Auto-detected loopback takes precedence only if user didn't explicitly set the flag
        if (!req.body.loopbackBind) loopbackBind = detected.loopbackBind || false;
      } else {
        containerPort = detected || 80;
      }
    }

    // Service pods always use the nginx sidecar (OpenClaw binds to 127.0.0.1 internally)
    if (type === 'service') loopbackBind = true;

    const servicePort = 80;

    // ── Service: prevent duplicate workspace ─────────────────────────────────
    if (type === 'service') {
      const existingServices = await listAppsByUserId(user.id, 'service');
      if (existingServices.length > 0) {
        return res.status(409).json({ error: 'You already have an OpenClaw Workspace. Only one is allowed per account.' });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

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

    // ── Service: set PVC mount now that shortId is known ──────────────────────
    if (type === 'service') {
      pvcMount = { claimName: `ws-pvc-${shortId}`, mountPath: '/workspace' };
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Service: storage rate + combined billing (mirrors databases) ─────────
    let storageHourlyRate = 0;
    let combinedPodRate = plan.price_per_hour;
    if (type === 'service') {
      const storageGB = parseInt(plan.storage?.replace('Gi', '') || '0');
      storageHourlyRate = storageGB * 3; // 3 paise per GB/hr (same as databases)
      combinedPodRate = plan.price_per_hour + storageHourlyRate;
      pvcMount = { claimName: `ws-pvc-${shortId}`, mountPath: '/workspace' };
    }
    // ─────────────────────────────────────────────────────────────────────────

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
      replicas: finalReplicas,
      loopbackBind,
      type,
      storage: type === 'service' ? plan.storage : null,
      storage_hourly_rate: storageHourlyRate,
    });

    // 2. Start billing — services use combined rate (pod + storage) like databases
    const billingRate = type === 'service' ? combinedPodRate : plan.price_per_hour;
    if (billingRate > 0) {
      try {
        // For services: reserve=combinedRate, hourly_rate stored = pod rate only (storage is separate)
        await startPodBilling(appId, user.id, billingRate, plan.price_per_hour, finalReplicas);
      } catch (err) {
        await deleteAppById(appId);
        return res.status(402).json({ error: err.message });
      }
    } else {
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

      // Service (OpenClaw): create workspace PVC before the Deployment
      if (type === 'service' && pvcMount) {
        await k8sService.createPVC({ namespace, name: pvcMount.claimName, size: plan.storage || '5Gi' });
      }

      const { serviceTargetPort } = await k8sService.createDeployment({
        name: resourceName,
        namespace,
        image,
        containerPort,
        plan,
        env,
        command,
        args,
        replicas: finalReplicas,
        hasRegistrySecret,
        loopbackBind,
        pvcMount,
        enableDinD: type === 'service',
      });
      await k8sService.createService({
        name: resourceName,
        namespace,
        servicePort: servicePort,
        containerPort: serviceTargetPort,
      });
      await k8sService.createIngress({ name: resourceName, namespace, host, port: servicePort });
    } catch (k8sErr) {
      logger.error('K8s creation failed, rolling back', k8sErr);
      // Also clean up the PVC if we created one
      if (type === 'service' && pvcMount) {
        await k8sService.deleteNamespacedPVC(pvcMount.claimName, namespace).catch(() => {});
      }
      await killAppCompletely({ id: appId, namespace, type }).catch(() => { });
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

    emailService.emailAppDeployed(user.id, name, url).catch(() => { });
    return res.status(201).json({ id: appId, name, url, status: 'deploying', ...(aliasWarning ? { aliasWarning } : {}) });
  } catch (err) {
    logger.error('createApp error', err);
    res.status(500).json({ error: err.message });
  }
};

export const listApps = async (req, res) => {
  try {
    // Fetch both regular apps AND managed services in one call.
    // The frontend filters by app.type to split them into the correct pages.
    const { rows } = await db.query(
      "SELECT * FROM apps WHERE user_id = $1 AND type IN ('app','service') AND status != 'deleted' ORDER BY created_at DESC",
      [req.user.id]
    );
    const apps = rows.map(app => {
      try {
        return {
          ...app,
          env:     app.env     ? JSON.parse(app.env)     : null,
          command: app.command ? JSON.parse(app.command) : null,
          args:    app.args    ? JSON.parse(app.args)    : null,
        };
      } catch { return app; }
    });

    // Sync status, metrics, and internal IP with k8s for each app.
    // All k8s reads hit the 10s TTL cache so this is safe at any poll frequency.
    const syncedApps = await Promise.all(apps.map(async (app) => {
      const shortId = app.id.split('-')[0];
      const resourceName = `app-${shortId}`;

      const [currentStatus, metrics, internalData, sidecarStatus] = await Promise.all([
        k8sService.getAppStatus(resourceName, app.namespace),
        k8sService.getPodMetrics(app.namespace, resourceName),
        k8sService.getInternalIP(resourceName, app.namespace),
        app.loopback_bind ? k8sService.getSidecarStatus(resourceName, app.namespace) : Promise.resolve({ hasSidecar: false, sidecarReady: false }),
      ]);

      const internalIp = internalData?.ip || null;
      const internalPort = internalData?.port || null;
      const containerPort = internalData?.targetPort || null;

      // If k8s has no pods yet (unknown) — trust the DB status.
      if (currentStatus === 'unknown') {
        return { ...app, internalIp, internalPort, containerPort, metrics: metrics || { cpu: '0', memory: '0' }, ...sidecarStatus };
      }

      return {
        ...app,
        status: currentStatus || app.status,
        internalIp,
        internalPort,
        containerPort,
        metrics: metrics || { cpu: '0', memory: '0' },
        ...sidecarStatus,
      };
    }));

    res.json(syncedApps);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const stopService = async (req, res) => {
  try {
    const app = await getAppById(req.params.id);
    if (!app || app.user_id !== req.user.id || app.type !== 'service') {
      return res.status(404).json({ error: 'Service not found' });
    }
    if (app.status === 'stopped') {
      return res.status(400).json({ error: 'Service is already stopped' });
    }

    const shortId = app.id.split('-')[0];
    const resourceName = `app-${shortId}`;

    // Delete deployment + service (mirrors stopDatabase). PVC is preserved.
    // Ingress stays so the URL remains valid (503 while stopped).
    await k8sService.deleteNamespacedDeployment(resourceName, app.namespace);
    await k8sService.deleteNamespacedService(resourceName, app.namespace);

    // stopPodBilling is aware of type='service' → retains storage reserve
    await stopPodBilling(app.id);
    await updateAppDetails(app.id, { status: 'stopped' });
    res.json({ status: 'stopped' });
  } catch (err) {
    logger.error('stopService error', err);
    res.status(500).json({ error: err.message });
  }
};

export const startService = async (req, res) => {
  try {
    const app = await getAppById(req.params.id);
    if (!app || app.user_id !== req.user.id || app.type !== 'service') {
      return res.status(404).json({ error: 'Service not found' });
    }
    if (app.status === 'running') {
      return res.status(400).json({ error: 'Service is already running' });
    }

    const plan = await getPlanById(app.plan_id);
    if (!plan) return res.status(400).json({ error: 'Plan not found' });

    const combinedRate = plan.price_per_hour + (app.storage_hourly_rate || 0);

    // Balance check (combined pod + storage reserve)
    if (combinedRate > 0 && req.user.balance < combinedRate) {
      return res.status(402).json({
        error: `Insufficient balance. ${plan.name} requires ₹${(combinedRate / 100).toFixed(2)} (1 hr reserve) to restart.`
      });
    }

    const shortId = app.id.split('-')[0];
    const resourceName = `app-${shortId}`;
    const pvcMount = { claimName: `ws-pvc-${shortId}`, mountPath: '/workspace' };

    const baseEnv = app.env || [];
    const newEnv = baseEnv.filter(e => e.name !== 'DOCKER_USERNAME' && e.name !== 'DOCKER_PASSWORD');
    if (req.user.docker_username && req.user.docker_token) {
      newEnv.push({ name: 'DOCKER_USERNAME', value: req.user.docker_username });
      newEnv.push({ name: 'DOCKER_PASSWORD', value: req.user.docker_token });
    }

    // Recreate deployment (with PVC) + service (mirrors startDatabase)
    const { serviceTargetPort } = await k8sService.createDeployment({
      name: resourceName,
      namespace: app.namespace,
      image: app.image,
      containerPort: app.container_port,
      plan,
      env: newEnv,
      command: app.command,
      args: app.args,
      replicas: 1,
      hasRegistrySecret: false,
      loopbackBind: app.loopback_bind,
      pvcMount,
      enableDinD: true, // startService is only for type === 'service'
    });

    await k8sService.createService({
      name: resourceName,
      namespace: app.namespace,
      servicePort: 80,
      containerPort: serviceTargetPort,
    });

    // Start combined billing (pod + storage reserve)
    if (combinedRate > 0) {
      await startPodBilling(app.id, req.user.id, combinedRate, plan.price_per_hour);
    }

    await updateAppDetails(app.id, { status: 'running', env: JSON.stringify(newEnv) });
    res.json({ status: 'running' });
  } catch (err) {
    logger.error('startService error', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * PATCH /api/apps/:id/service-keys
 * Update LLM / GitHub keys from the Settings UI without a full redeploy.
 * Merges new keys into the stored env array and triggers a k8s rolling update.
 */
export const updateServiceKeys = async (req, res) => {
  try {
    const app = await getAppById(req.params.id);
    if (!app || app.user_id !== req.user.id || app.type !== 'service') {
      return res.status(404).json({ error: 'Service not found' });
    }
    if (app.status !== 'running') {
      return res.status(400).json({ error: 'Workspace must be running to update keys' });
    }

    const { serviceEnv = {} } = req.body; // e.g. { OPENAI_API_KEY: '...', GITHUB_TOKEN: '...' }

    // Merge new values into existing env array (preserve WREXER_* vars, overwrite user vars)
    const currentEnv = app.env || [];
    const wrexerVars = currentEnv.filter(e => e.name.startsWith('WREXER_'));
    const newEnv = [
      ...wrexerVars,
      ...Object.entries(serviceEnv).map(([k, v]) => ({ name: k, value: String(v) })),
    ];

    const plan = await getPlanById(app.plan_id);
    const shortId = app.id.split('-')[0];
    const resourceName = `app-${shortId}`;
    const pvcMount = { claimName: `ws-pvc-${shortId}`, mountPath: '/workspace' };

    await k8sService.updateDeployment({
      name: resourceName,
      namespace: app.namespace,
      image: app.image,
      containerPort: app.container_port,
      plan,
      env: newEnv,
      command: app.command,
      args: app.args,
      replicas: 1,
      hasRegistrySecret: false,
      loopbackBind: app.loopback_bind,
      pvcMount,
      enableDinD: true, // updateServiceKeys is only for type === 'service'
    });

    await updateAppDetails(app.id, { env: newEnv });
    res.json({ updated: true });
  } catch (err) {
    logger.error('updateServiceKeys error', err);
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
    const internalData = await k8sService.getInternalIP(resourceName, app.namespace);
    const internalIp = internalData?.ip || null;
    const internalPort = internalData?.port || null;
    const containerPort = internalData?.targetPort || null;
    const sidecarStatus = app.loopback_bind
      ? await k8sService.getSidecarStatus(resourceName, app.namespace)
      : { hasSidecar: false, sidecarReady: false };
    res.json({ ...app, status, metrics, internalIp, internalPort, containerPort, ...sidecarStatus });
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
    // Default to 'app' container; tenants can request 'proxy-sidecar' via ?container=proxy-sidecar
    const container = req.query.container || 'app';
    const logs = await k8sService.getLogs(resourceName, app.namespace, container);
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
    // loopbackBind can be explicitly set by the user from the Advanced toggle
    const explicitLoopbackBind = req.body.loopbackBind;

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
    // loopbackBind priority:
    //  1. Explicit user toggle from req.body (highest — user made a deliberate choice)
    //  2. Auto-detected from new image inspection (middle)
    //  3. Stored DB value from previous deploy (lowest)
    let loopbackBind = explicitLoopbackBind !== undefined
      ? Boolean(explicitLoopbackBind)
      : (app.loopback_bind || false);

    // Enforce Tiny plan restriction
    if (app.plan_id === 'p-tiny') {
      newReplicas = 1;
    }

    // Auto-detect port if image changed but port was not explicitly provided
    if (image && image !== app.image && port === undefined) {
      const detected = await imageService.getExposedPort(image, req.user?.docker_username, req.user?.docker_token);
      if (detected && typeof detected === 'object') {
        newPort = detected.port;
        // Only override loopbackBind from detection if user hasn't toggled it explicitly
        if (explicitLoopbackBind === undefined) loopbackBind = detected.loopbackBind || false;
      } else {
        newPort = detected || 80;
      }
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
      loopbackBind,
    });

    await updateAppDetails(app.id, {
      image: newImage,
      containerPort: newPort,
      env: newEnv,
      command: newCommand,
      args: newArgs,
      replicas: newReplicas,
      loopback_bind: loopbackBind,
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
  if (app.type !== 'app' && app.type !== 'service') {
    return res.status(400).json({ error: 'Aliases are only supported for apps and services, not databases.' });
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
