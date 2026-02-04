import { v4 as uuidv4 } from 'uuid';
import k8sService from '../services/k8s.service.js';
import { baseDomain } from '../config/env.js';
import logger from '../utils/logger.js';
import {
  insertApp,
  getAppById,
  listAppsByKey,
  deleteAppById
} from '../models/app.model.js';

export const createApp = async (req, res) => {
  try {
    const { image, port } = req.body;
    const apiKey = req.apiKey;

    if (!image || !port) {
      return res.status(400).json({
        error: 'image and port are required'
      });
    }

    const appId = uuidv4();
    const namespace = `app-${appId}`;
    const host = `${namespace}.${baseDomain}`;
    const url = `http://${host}`;

    await k8sService.createNamespace(namespace);
    await k8sService.createQuota(namespace);
    await k8sService.createDeployment({ namespace, image, port });
    await k8sService.createService({ namespace, port });
    await k8sService.createIngress({ namespace, host, port });

    insertApp({
      id: appId,
      namespace,
      image,
      url,
      apiKey
    });

    res.status(201).json({
      id: appId,
      url,
      status: 'deploying'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const listApps = async (req, res) => {
  const apps = listAppsByKey(req.apiKey);
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

  try {
    logger.info('deleteApp called', { id: app.id, namespace: app.namespace });
    if (app.namespace) {
      await k8sService.deleteNamespace(app.namespace);
    } else {
      logger.warn('deleteApp: missing namespace for app', app.id);
    }
  } catch (err) {
    // log and continue to remove DB entry to avoid leaving dangling records
    logger.error('error deleting namespace', err?.message || err);
  }

  deleteAppById(app.id);

  res.json({ deleted: true });
};
