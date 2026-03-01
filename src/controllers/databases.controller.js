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
import { spawn } from 'child_process';

const genPass = () => crypto.randomBytes(16).toString('hex');
const genUser = () => 'u_' + crypto.randomBytes(4).toString('hex');
const genDb = () => 'db_' + crypto.randomBytes(4).toString('hex');

// Mask sensitive password from connection strings
const maskUrl = (url) => url ? url.replace(/:([^:@]+)(?=@)/, ':••••••••') : '';

export const createDatabase = async (req, res) => {
    try {
        const { name, planId = 'db-small' } = req.body;
        const user = req.user;

        if (!name) return res.status(400).json({ error: 'DB name is required' });

        const plan = await getPlanById(planId);
        if (!plan || !plan.storage) return res.status(400).json({ error: 'Invalid DB plan' });

        // Per-user capacity check (prevent one user from consuming all resources)
        const { rows: caps } = await db.query(`
          SELECT
            COALESCE(SUM(CAST(REPLACE(p.memory, 'Mi', '') AS INT)), 0) as ram,
            COALESCE(SUM(CAST(REPLACE(p.storage, 'Gi', '') AS INT)), 0) as disk
          FROM apps a JOIN plans p ON a.plan_id = p.id
          WHERE a.type = 'database' AND a.status != 'deleted' AND a.user_id = $1
        `, [user.id]);

        const ramLimit = 8192;  // 8GB per user
        const diskLimit = 100;  // 100GB per user
        if (parseInt(caps[0].ram) + parseInt(plan.memory.replace('Mi', '')) > ramLimit) {
            return res.status(503).json({ error: 'You have reached your RAM limit for databases.' });
        }
        if (parseInt(caps[0].disk) + parseInt(plan.storage.replace('Gi', '')) > diskLimit) {
            return res.status(503).json({ error: 'You have reached your disk limit for databases.' });
        }

        if (plan.price_per_hour > 0 && user.balance < plan.price_per_hour) {
            return res.status(402).json({ error: 'Insufficient balance' });
        }

        const appId = uuidv4();
        const shortId = appId.split('-')[0];
        const namespace = `user-${user.id}`;
        const resourceName = `db-${shortId}`;
        const pvcName = `data-db-${shortId}`;

        const dbUser = genUser();
        const dbPass = genPass();
        const dbName = genDb();

        const storageGB = parseInt(plan.storage.replace('Gi', '')) || 0;
        const storageRate = storageGB * 2; // 2 paise per GB per hour
        const combinedRate = plan.price_per_hour + storageRate;

        // 1. Insert DB record
        await insertApp({
            id: appId,
            name,
            namespace,
            image: 'postgres:16-alpine',
            url: `postgres://${dbUser}:${dbPass}@${resourceName}.${namespace}.svc.cluster.local:5432/${dbName}`,
            userId: user.id,
            planId: plan.id,
            type: 'database',
            storage: plan.storage,
            storage_hourly_rate: storageRate,
            db_user: dbUser,
            db_password: dbPass,
            db_name: dbName,
            status: 'provisioning'
        });

        // 2. Start Billing (Pod + Storage combined for the 1-hour reserve)
        if (combinedRate > 0) {
            try {
                await startPodBilling(appId, user.id, combinedRate, plan.price_per_hour);
            } catch (e) {
                await db.query("UPDATE apps SET status = 'deleted' WHERE id = $1", [appId]);
                return res.status(402).json({ error: e.message });
            }
        }

        // 3. K8s Provisioning
        try {
            await k8sService.createPVC({ namespace, name: pvcName, size: plan.storage });
            await k8sService.createDatabaseDeployment({ name: resourceName, namespace, plan, dbUser, dbPassword: dbPass, dbName, pvcName });
            await k8sService.createDatabaseService({ name: resourceName, namespace });

            const internalHost = `${resourceName}.${namespace}.svc.cluster.local`;
            const internalPort = 5432;
            const internalUrl = `postgres://${dbUser}:${dbPass}@${internalHost}:${internalPort}/${dbName}`;

            await updateAppDetails(appId, {
                db_host: internalHost,
                db_port: internalPort,
                url: internalUrl,
                status: 'running'
            });

            res.status(201).json({ id: appId, name, status: 'provisioning', url: internalUrl });
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
    const masked = dbs.map(db => ({
        ...db,
        url: maskUrl(db.url),
        db_password: '••••••••'
    }));
    res.json(masked);
};

export const getDatabase = async (req, res) => {
    const db = await getAppById(req.params.id);
    if (!db || db.user_id !== req.user.id) return res.status(404).json({ error: 'DB not found' });

    const shortId = db.id.split('-')[0];
    const resourceName = `db-${shortId}`;

    let status = await k8sService.getAppStatus(resourceName, db.namespace);
    const metrics = await k8sService.getPodMetrics(db.namespace, resourceName);

    // If k8s says unknown but our DB record says stopped, keep it as stopped
    if (status === 'unknown' && db.status === 'stopped') {
        status = 'stopped';
    }

    res.json({
        ...db,
        url: maskUrl(db.url),
        db_password: '••••••••',
        status,
        metrics
    });
};

export const stopDatabase = async (req, res) => {
    const app = await getAppById(req.params.id);
    if (!app || app.user_id !== req.user.id) return res.status(404).json({ error: 'DB not found' });

    const shortId = app.id.split('-')[0];
    const resourceName = `db-${shortId}`;

    await k8sService.deleteNamespacedDeployment(resourceName, app.namespace);
    await k8sService.deleteNamespacedService(resourceName, app.namespace);
    await stopPodBilling(app.id);
    await updateAppDetails(app.id, { status: 'stopped' });
    res.json({ status: 'stopped' });
};

export const startDatabase = async (req, res) => {
    const app = await getAppById(req.params.id);
    if (!app || app.user_id !== req.user.id) return res.status(404).json({ error: 'DB not found' });

    const plan = await getPlanById(app.plan_id);
    const combinedRate = plan.price_per_hour + (app.storage_hourly_rate || 0);

    if (combinedRate > 0 && req.user.balance < combinedRate) {
        return res.status(402).json({ error: 'Insufficient balance' });
    }

    const shortId = app.id.split('-')[0];
    const resourceName = `db-${shortId}`;
    const pvcName = `data-db-${shortId}`;

    await k8sService.createDatabaseDeployment({
        name: resourceName,
        namespace: app.namespace,
        plan,
        dbUser: app.db_user,
        dbPassword: app.db_password,
        dbName: app.db_name,
        pvcName
    });

    await k8sService.createDatabaseService({
        name: resourceName,
        namespace: app.namespace
    });

    if (combinedRate > 0) {
        await startPodBilling(app.id, req.user.id, combinedRate, plan.price_per_hour);
    }

    await updateAppDetails(app.id, { status: 'running' });
    res.json({ status: 'running' });
};

// Stream a pg_dump backup to the client
export const downloadBackup = async (req, res) => {
    const { id } = req.params;

    try {
        const { rows } = await db.query('SELECT * FROM apps WHERE id = $1 AND user_id = $2', [id, req.user.id]);
        const app = rows[0];

        if (!app) return res.status(404).json({ error: 'Database not found' });
        if (app.type !== 'database') return res.status(400).json({ error: 'Not a database' });
        if (app.status !== 'running') return res.status(400).json({ error: 'Database must be running to take a backup' });

        const shortId = app.id.split('-')[0];
        const resourceName = `db-${shortId}`;

        // Get the running pod
        const podName = await k8sService.getPodName(resourceName, app.namespace);
        if (!podName) return res.status(500).json({ error: 'Pod not found' });

        // Set headers for download
        const filename = `${app.name}_backup_${new Date().toISOString().split('T')[0]}.sql`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/sql');

        // Construct pg_dump command
        // Using psql-style env vars for better reliability in some k8s exec environments
        // Percent-encoding user and password to handle special characters in production
        const encodedUser = encodeURIComponent(app.db_user);
        const encodedPass = encodeURIComponent(app.db_password);

        // Use the internal k8s service hostname
        // db-xyz.user-abc.svc.cluster.local
        const dbHost = `${resourceName}.${app.namespace}.svc.cluster.local`;

        const dumpArgs = [
            '--dbname=' + `postgresql://${encodedUser}:${encodedPass}@${dbHost}:5432/${app.db_name}`,
            '--no-owner',
            '--no-privileges',
            '--clean',
            '--if-exists'
        ];

        // Spawn pg_dump locally inside the backend pod
        const pgDumpProcess = spawn('pg_dump', dumpArgs);

        // Pipe stdout directly to the client response
        pgDumpProcess.stdout.pipe(res);

        let errorLog = '';
        pgDumpProcess.stderr.on('data', (data) => {
            errorLog += data.toString();
        });

        pgDumpProcess.on('close', (code) => {
            if (code !== 0) {
                logger.error('pg_dump process failed', { appId: id, code, errorLog });
                // If headers aren't sent yet, we can send an error response.
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Backup process failed' });
                } else {
                    // Headers already sent (file download started), simply end the stream
                    logger.warn('Backup failed after streaming started');
                    res.end();
                }
            } else {
                logger.info(`Backup completed successfully for app ${id}`);
            }
        });

        pgDumpProcess.on('error', (err) => {
            logger.error('Failed to start pg_dump process', { appId: id, error: err.message });
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to start backup process. Is pg_dump installed?' });
            }
        });

    } catch (err) {
        logger.error('Backup download failed:', {
            appId: id,
            error: err.message,
            stack: err.stack,
            dbName: app?.db_name,
            namespace: app?.namespace
        });

        if (!res.headersSent) {
            res.status(500).json({ error: `Backup failed: ${err.message}` });
        } else {
            // If headers were already sent, the response is corrupted/incomplete.
            // We can't send a JSON error now, but we've logged it.
            logger.warn('Backup failed after headers sent - connection may hang or return partial data');
        }
    }
};

export const destroyDatabase = async (req, res) => {
    const app = await getAppById(req.params.id);
    if (!app || app.user_id !== req.user.id) return res.status(404).json({ error: 'DB not found' });

    // 1. Settle final billing and refund storage reserve
    await stopPodBilling(app.id, true);

    const shortId = app.id.split('-')[0];
    const resourceName = `db-${shortId}`;
    const pvcName = `data-db-${shortId}`;

    // 2. Delete k8s resources (destroys PVC/data)
    await k8sService.deleteNamespacedDeployment(resourceName, app.namespace);
    await k8sService.deleteNamespacedService(resourceName, app.namespace);
    await k8sService.deleteNamespacedPVC(pvcName, app.namespace);

    // 3. Soft delete in DB
    await updateAppDetails(app.id, { status: 'deleted' });
    res.json({ deleted: true });
};
