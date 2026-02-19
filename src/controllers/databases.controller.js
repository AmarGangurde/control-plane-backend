import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import k8sService from '../services/k8s.service.js';
import { baseDomain } from '../config/env.js';
import logger from '../utils/logger.js';
import {
    insertApp,
    getAppById,
    listAppsByUserId,
    updateAppDetails
} from '../models/app.model.js';
import { getPlanById } from '../models/plan.model.js';
import { startPodBilling, stopPodBilling } from '../services/billing.service.js';
import db from '../db/db.js';

const genPass = () => crypto.randomBytes(16).toString('hex');
const genUser = () => 'u_' + crypto.randomBytes(4).toString('hex');
const genDb = () => 'db_' + crypto.randomBytes(4).toString('hex');

export const createDatabase = async (req, res) => {
    try {
        const { name, planId = 'db-small' } = req.body;
        const user = req.user;

        if (!name) return res.status(400).json({ error: 'DB name is required' });

        const plan = await getPlanById(planId);
        if (!plan || !plan.storage) return res.status(400).json({ error: 'Invalid DB plan' });

        // Capacity check
        const { rows: caps } = await db.query(`
      SELECT 
        COALESCE(SUM(CAST(REPLACE(p.memory, 'Mi', '') AS INT)), 0) as ram,
        COALESCE(SUM(CAST(REPLACE(p.storage, 'Gi', '') AS INT)), 0) as disk
      FROM apps a JOIN plans p ON a.plan_id = p.id
      WHERE a.type = 'database' AND a.status != 'deleted'
    `);

        const ramLimit = 20480; // 20GB
        const diskLimit = 180;  // 180GB
        if (parseInt(caps[0].ram) + parseInt(plan.memory.replace('Mi', '')) > ramLimit) {
            return res.status(503).json({ error: 'Server RAM capacity reached' });
        }
        if (parseInt(caps[0].disk) + parseInt(plan.storage.replace('Gi', '')) > diskLimit) {
            return res.status(503).json({ error: 'Server Disk capacity reached' });
        }

        if (plan.price_per_hour > 0 && user.balance < plan.price_per_hour) {
            return res.status(402).json({ error: 'Insufficient balance' });
        }

        const appId = uuidv4();
        const sanitizedName = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
        const namespace = `db-${sanitizedName}-${appId.split('-')[0]}`;

        const dbUser = genUser();
        const dbPass = genPass();
        const dbName = genDb();

        // 1. Insert DB record
        await insertApp({
            id: appId,
            name,
            namespace,
            image: 'postgres:16-alpine',
            url: `postgres://${dbUser}:${dbPass}@${baseDomain}:PORT/${dbName}`,
            userId: user.id,
            planId: plan.id,
            type: 'database',
            storage: plan.storage,
            db_user: dbUser,
            db_password: dbPass,
            db_name: dbName,
            status: 'provisioning'
        });

        // 2. Start Billing
        if (plan.price_per_hour > 0) {
            try {
                await startPodBilling(appId, user.id, plan.price_per_hour);
            } catch (e) {
                await db.query("UPDATE apps SET status = 'deleted' WHERE id = $1", [appId]);
                return res.status(402).json({ error: e.message });
            }
        }

        // 3. K8s Provisioning
        try {
            await k8sService.createNamespace(namespace);
            await k8sService.createPVC({ namespace, size: plan.storage });
            await k8sService.createDatabaseDeployment({ namespace, plan, dbUser, dbPassword: dbPass, dbName });
            const svc = await k8sService.createDatabaseService({ namespace });

            const nodePort = svc.spec.ports[0].nodePort;
            const publicUrl = `postgres://${dbUser}:${dbPass}@${baseDomain}:${nodePort}/${dbName}`;

            await updateAppDetails(appId, {
                db_host: baseDomain,
                db_port: nodePort,
                url: publicUrl,
                status: 'running'
            });

            res.status(201).json({ id: appId, name, status: 'provisioning', url: publicUrl });
        } catch (err) {
            logger.error('DB K8s creation failed', err);
            // We don't delete namespace here to preserve PVC as per requirements if it failed later
            // But if it failed at creation, we might need cleanup. 
            // Requirement: "never deleted automatically on crash"
            await updateAppDetails(appId, { status: 'error' });
            res.status(500).json({ error: 'Deployment failed. Check dashboard for details.' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

export const listDatabases = async (req, res) => {
    const dbs = await listAppsByUserId(req.user.id, 'database');
    res.json(dbs);
};

export const getDatabase = async (req, res) => {
    const db = await getAppById(req.params.id);
    if (!db || db.user_id !== req.user.id) return res.status(404).json({ error: 'DB not found' });

    const status = await k8sService.getAppStatus(db.namespace);
    const metrics = await k8sService.getPodMetrics(db.namespace);
    res.json({ ...db, status, metrics });
};

export const stopDatabase = async (req, res) => {
    const app = await getAppById(req.params.id);
    if (!app || app.user_id !== req.user.id) return res.status(404).json({ error: 'DB not found' });

    await k8sService.deleteNamespacedDeployment('database', app.namespace);
    await stopPodBilling(app.id);
    await updateAppDetails(app.id, { status: 'stopped' });
    res.json({ status: 'stopped' });
};

export const startDatabase = async (req, res) => {
    const app = await getAppById(req.params.id);
    if (!app || app.user_id !== req.user.id) return res.status(404).json({ error: 'DB not found' });

    const plan = await getPlanById(app.plan_id);
    if (plan.price_per_hour > 0 && req.user.balance < plan.price_per_hour) {
        return res.status(402).json({ error: 'Insufficient balance' });
    }

    await k8sService.createDatabaseDeployment({
        namespace: app.namespace,
        plan,
        dbUser: app.db_user,
        dbPassword: app.db_password,
        dbName: app.db_name
    });

    if (plan.price_per_hour > 0) {
        await startPodBilling(app.id, req.user.id, plan.price_per_hour);
    }

    await updateAppDetails(app.id, { status: 'running' });
    res.json({ status: 'running' });
};

export const destroyDatabase = async (req, res) => {
    const app = await getAppById(req.params.id);
    if (!app || app.user_id !== req.user.id) return res.status(404).json({ error: 'DB not found' });

    // 1. Stop billing if running
    if (app.status === 'running') {
        await stopPodBilling(app.id);
    }

    // 2. Delete entire namespace (destroys PVC/data)
    await k8sService.deleteNamespace(app.namespace);

    // 3. Soft delete in DB
    await updateAppDetails(app.id, { status: 'deleted' });
    res.json({ deleted: true });
};
