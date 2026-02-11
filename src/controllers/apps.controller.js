import { v4 as uuidv4 } from 'uuid';
import k8sService from '../services/k8s.service.js';
import { baseDomain } from '../config/env.js';
import logger from '../utils/logger.js';
import {
  insertApp,
  getAppById,
  listAppsByUserId,
  deleteAppById
} from '../models/app.model.js';
import { getPlanById } from '../models/plan.model.js';
import { updateUserBalance } from '../models/user.model.js';
import { killAppCompletely } from '../services/app.service.js';

export const createApp = async (req, res) => {
  try {
    const { image, port, planId = 'p-small', name } = req.body;
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

    // Billing check (skip for free plan)
    if (plan.price_per_hour > 0 && user.balance < plan.price_per_hour) {
      return res.status(402).json({
        error: `insufficient balance. ${plan.name} plan requires at least ₹${plan.price_per_hour} to start`
      });
    }

    if (!image || !port) {
      return res.status(400).json({
        error: 'image and port are required'
      });
    }

    // Deduct initial charge
    updateUserBalance(user.id, -plan.price_per_hour);
    // Log transaction (optional but good)
    // We'll skip explicit transaction log here to keep it simple or user can see balance drop. 
    // Actually, let's keep it simple.

    const appId = uuidv4();
    const planName = plan.id.replace('p-', '');
    // Namespace: name-plan-random
    const namespace = `${sanitizedName}-${planName}-${appId.split('-')[0]}`;
    const host = `${namespace}.${baseDomain}`;
    const url = `http://${host}`;

    await k8sService.createNamespace(namespace);
    // Pass plan resources
    await k8sService.createQuota(namespace, plan);
    await k8sService.createDeployment({ namespace, image, port, plan });
    await k8sService.createService({ namespace, port });
    await k8sService.createIngress({ namespace, host, port });

    insertApp({
      id: appId,
      name,
      namespace,
      image,
      url,
      apiKey,
      userId: user.id,
      planId: plan.id
    });

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
  const app = getAppById(req.params.id);

  if (!app || app.api_key !== req.apiKey) {
    return res.status(404).json({ error: 'app not found' });
  }

  const status = await k8sService.getAppStatus(app.namespace);
  res.json({ ...app, status });
};


export const deleteApp = async (req, res) => {
  const app = getAppById(req.params.id);

  if (!app || app.api_key !== req.apiKey) {
    return res.status(404).json({ error: 'app not found' });
  }

  await killAppCompletely(app);

  res.json({ deleted: true });
};
