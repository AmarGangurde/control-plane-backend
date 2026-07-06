/**
 * agentDeploy.controller.js
 *
 * Called by WrexForge pods via:
 *   POST /api/agent/deploy
 *   Authorization: Bearer <agent_token>
 *
 * Validates the agent token, resolves the user, and triggers a standard
 * Wrexer app deployment on behalf of that user — without exposing any
 * Kubernetes credentials to the agent itself.
 */

import { v4 as uuidv4 } from 'uuid';
import k8sService from '../services/k8s.service.js';
import { baseDomain } from '../config/env.js';
import logger from '../utils/logger.js';
import { insertApp, listAppsByUserId } from '../models/app.model.js';
import { getPlanById } from '../models/plan.model.js';
import { killAppCompletely } from '../services/app.service.js';
import imageService from '../services/image.service.js';
import { startPodBilling } from '../services/billing.service.js';
import db from '../db/db.js';
import * as emailService from '../services/email.service.js';

/**
 * POST /api/agent/deploy
 * Body: { image, port, name, planId }
 */
export const agentDeploy = async (req, res) => {
  try {
    const user = req.user; // resolved by agentAuthMiddleware
    const { image, port, name, planId = 'p-small', env } = req.body;

    if (!image || !name) {
      return res.status(400).json({ error: 'image and name are required' });
    }

    // Sanitize name for k8s
    const sanitizedName = name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    const plan = await getPlanById(planId);
    if (!plan) {
      return res.status(400).json({ error: 'Invalid planId' });
    }

    // Kata plans not available for agent-triggered deploys
    if (plan.runtime === 'kata') {
      return res.status(400).json({ error: 'Kata plans are not available via agent deploy.' });
    }

    // Tiny plan: 1 per account
    if (plan.id === 'p-tiny') {
      const existingApps = await listAppsByUserId(user.id);
      if (existingApps.find(a => a.plan_id === 'p-tiny')) {
        return res.status(403).json({ error: 'Tiny plan limit reached (1 per account).' });
      }
    }

    // Balance check
    if (plan.price_per_hour > 0 && user.balance < plan.price_per_hour) {
      return res.status(402).json({
        error: `Insufficient balance. ${plan.name} plan requires at least ₹${(plan.price_per_hour / 100).toFixed(2)} to start.`,
      });
    }

    // Resolve container port
    let containerPort = port ? parseInt(port, 10) : null;
    let loopbackBind = false;
    if (!containerPort) {
      const detected = await imageService.getExposedPort(image, user.docker_username, user.docker_token);
      if (detected && typeof detected === 'object') {
        containerPort = detected.port;
        loopbackBind = detected.loopbackBind || false;
      } else {
        containerPort = detected || 80;
      }
    }

    const servicePort = 80;
    const appId = uuidv4();
    const shortId = appId.split('-')[0];
    const namespace = `user-${user.id}`;
    const host = `${sanitizedName}-${shortId}.${baseDomain}`;
    const protocol = baseDomain === 'localhost' ? 'http' : 'https';
    const url = `${protocol}://${host}`;

    // Insert app record
    await insertApp({
      id: appId,
      name,
      namespace,
      image,
      url,
      userId: user.id,
      planId: plan.id,
      containerPort,
      env: env || null,
      command: null,
      args: null,
      replicas: 1,
      loopbackBind,
    });

    // Billing
    if (plan.price_per_hour > 0) {
      try {
        await startPodBilling(appId, user.id, plan.price_per_hour, undefined, 1);
      } catch (err) {
        await db.query('DELETE FROM apps WHERE id = $1', [appId]);
        return res.status(402).json({ error: err.message });
      }
    } else {
      const now = Math.floor(Date.now() / 1000);
      await db.query(
        "UPDATE apps SET status = 'running', started_at = $1, last_billed_at = $2 WHERE id = $3",
        [now, now, appId]
      );
    }

    // K8s deployment
    try {
      const imageIsPublic = await imageService.isPublicImage(image);
      let hasRegistrySecret = false;
      if (!imageIsPublic && user.docker_username && user.docker_token) {
        await k8sService.syncUserRegistrySecret(namespace, user.docker_username, user.docker_token);
        hasRegistrySecret = true;
      }

      const { serviceTargetPort } = await k8sService.createDeployment({
        name: `app-${shortId}`,
        namespace,
        image,
        containerPort,
        plan,
        env: env || null,
        command: null,
        args: null,
        replicas: 1,
        hasRegistrySecret,
        loopbackBind,
      });

      await k8sService.createService({
        name: `app-${shortId}`,
        namespace,
        servicePort,
        containerPort: serviceTargetPort,
      });
      await k8sService.createIngress({ name: `app-${shortId}`, namespace, host, port: servicePort });
    } catch (k8sErr) {
      logger.error('Agent deploy K8s error, rolling back', k8sErr);
      await killAppCompletely({ id: appId, namespace, type: 'app' }).catch(() => {});
      throw new Error(`Cloud deployment failed: ${k8sErr.message}`);
    }

    emailService.emailAppDeployed(user.id, name, url).catch(() => {});

    logger.info(`Agent deployed app: ${name} (${appId}) for user ${user.id}`);
    return res.status(201).json({ appId, url, status: 'deploying' });
  } catch (err) {
    logger.error('agentDeploy error', err);
    res.status(500).json({ error: err.message });
  }
};
