import db from '../db/db.js';
import k8sService from './k8s.service.js';
import { getPlanById } from '../models/plan.model.js';
import imageService from './image.service.js';
import logger from '../utils/logger.js';

/**
 * On startup, reconcile the k8s cluster state against the DB.
 *
 * For every app/database that the DB says is 'running' (or 'provisioning'),
 * we check if a k8s Deployment already exists. If not, we re-provision it
 * using the exact config stored in the DB row (image, plan, env, db creds, etc.).
 *
 * This makes the system self-healing after a full server rebuild / DB restore —
 * tenants' pods come back automatically without any manual intervention.
 *
 * All k8s calls are idempotent (409 = already-exists is silently ignored),
 * so running this on a working cluster is completely safe.
 */
export async function reconcileK8sResources() {
    logger.info('Reconciler: starting k8s resource reconciliation...');

    let apps;
    try {
        const { rows } = await db.query(`
            SELECT a.*, u.docker_username, u.docker_token
            FROM apps a
            JOIN users u ON u.id = a.user_id
            WHERE a.status IN ('running', 'provisioning')
            ORDER BY a.created_at ASC
        `);
        apps = rows;
    } catch (err) {
        logger.error('Reconciler: failed to query apps from DB', { error: err.message });
        return;
    }

    // Parse JSON fields (stored as strings in DB)
    const parse = (val) => {
        if (!val) return null;
        if (Array.isArray(val)) return val;
        try { return JSON.parse(val); } catch { return null; }
    };

    logger.info(`Reconciler: found ${apps.length} app(s)/database(s) to check`);

    let provisioned = 0;
    let skipped = 0;
    let errors = 0;

    for (const app of apps) {
        const shortId = app.id.split('-')[0];
        const resourceName = app.type === 'database' ? `db-${shortId}` : `app-${shortId}`;
        const namespace = app.namespace;

        try {
            // Check if k8s deployment already exists
            const exists = await deploymentExists(resourceName, namespace);
            if (exists) {
                logger.debug(`Reconciler: ${resourceName} already exists in k8s, skipping`);
                skipped++;
                continue;
            }

            logger.info(`Reconciler: provisioning ${app.type} "${app.name}" (${resourceName}) for namespace ${namespace}`);

            // Ensure the user's namespace and quota exist
            await k8sService.ensureUserNamespace(namespace);

            const plan = await getPlanById(app.plan_id);
            if (!plan) {
                logger.warn(`Reconciler: plan "${app.plan_id}" not found for ${resourceName}, skipping`);
                errors++;
                continue;
            }

            if (app.type === 'database') {
                await reconcileDatabase(app, resourceName, plan);
            } else {
                await reconcileApp(app, resourceName, plan, parse);
            }

            provisioned++;
            logger.info(`Reconciler: ✅ provisioned ${resourceName}`);

        } catch (err) {
            errors++;
            logger.error(`Reconciler: ❌ failed to reconcile ${resourceName}`, {
                appId: app.id,
                error: err.message,
            });
        }
    }

    logger.info(`Reconciler: done — provisioned=${provisioned} skipped=${skipped} errors=${errors}`);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function deploymentExists(name, namespace) {
    try {
        await k8sService.apps.readNamespacedDeployment({ name, namespace });
        return true;
    } catch (err) {
        const code = err?.body?.code || err?.response?.statusCode;
        if (code === 404) return false;
        // If k8s is unavailable or namespace doesn't exist yet, treat as not-exists
        return false;
    }
}

async function reconcileDatabase(app, resourceName, plan) {
    const pvcName = `data-${resourceName}`;

    // PVC first (idempotent)
    await k8sService.createPVC({
        namespace: app.namespace,
        name: pvcName,
        size: plan.storage || app.storage || '1Gi',
    });

    // Deployment (idempotent — 409 ignored inside createDatabaseDeployment)
    await k8sService.createDatabaseDeployment({
        name: resourceName,
        namespace: app.namespace,
        plan,
        dbUser: app.db_user,
        dbPassword: app.db_password,
        dbName: app.db_name,
        pvcName,
    });

    // Service (idempotent)
    await k8sService.createDatabaseService({
        name: resourceName,
        namespace: app.namespace,
    });
}

async function reconcileApp(app, resourceName, plan, parse) {
    const image = app.image;
    const containerPort = app.container_port;
    const env = parse(app.env);
    const command = parse(app.command);
    const args = parse(app.args);
    const replicas = app.replicas || 1;
    const loopbackBind = app.loopback_bind || false;

    // Determine if image is public; if not, sync stored registry secret
    let hasRegistrySecret = false;
    if (app.docker_username && app.docker_token) {
        try {
            const isPublic = await imageService.isPublicImage(image);
            if (!isPublic) {
                await k8sService.syncUserRegistrySecret(
                    app.namespace,
                    app.docker_username,
                    app.docker_token
                );
                hasRegistrySecret = true;
            }
        } catch (err) {
            logger.warn(`Reconciler: could not sync registry secret for ${resourceName}`, { error: err.message });
        }
    }

    // Deployment (idempotent) — returns { serviceTargetPort } for sidecar awareness
    const { serviceTargetPort } = await k8sService.createDeployment({
        name: resourceName,
        namespace: app.namespace,
        image,
        containerPort,
        plan,
        env,
        command,
        args,
        replicas,
        hasRegistrySecret,
        loopbackBind,
    });

    // Service (idempotent) — target the sidecar port if one was injected
    await k8sService.createService({
        name: resourceName,
        namespace: app.namespace,
        servicePort: 80,
        containerPort: serviceTargetPort,
    });

    // Ingress — reconstruct the host from the stored URL
    const host = app.url.replace(/^https?:\/\//, '');
    await k8sService.createIngress({
        name: resourceName,
        namespace: app.namespace,
        host,
        port: 80,
    });

    // Re-apply alias ingress entry if the app had one
    if (app.alias) {
        const { baseDomain } = await import('../config/env.js');
        const aliasHost = `${app.alias}.${baseDomain}`;
        await k8sService.updateIngressHosts(resourceName, app.namespace, [host, aliasHost]);
    }
}
