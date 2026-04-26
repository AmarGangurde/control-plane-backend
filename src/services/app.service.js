import k8sService from './k8s.service.js';
import db from '../db/db.js';
import { stopPodBilling } from './billing.service.js';
import logger from '../utils/logger.js';

export const killAppCompletely = async (app) => {
    try {
        logger.info('killAppCompletely called', { id: app.id, namespace: app.namespace, type: app.type });

        // Settle billing first — refunds unreserved time
        await stopPodBilling(app.id).catch(err =>
            logger.warn('stopPodBilling failed (non-fatal)', { id: app.id, err: err.message })
        );

        if (!app.namespace) {
            logger.warn('killAppCompletely: missing namespace, skipping k8s cleanup', { id: app.id });
            await db.query("UPDATE apps SET status = 'deleted' WHERE id = $1", [app.id]);
            return true;
        }

        const shortId = app.id.split('-')[0];
        const resourceName = app.type === 'database' ? `db-${shortId}` : `app-${shortId}`;

        if (app.type === 'database') {
            // For databases: delete deployment + service but KEEP the PVC (stop preserves data)
            // destroyDatabase handles full PVC deletion separately
            await k8sService.deleteNamespacedDeployment(resourceName, app.namespace);
            await k8sService.deleteNamespacedService(resourceName, app.namespace);
            await db.query("UPDATE apps SET status = 'stopped' WHERE id = $1", [app.id]);
            logger.info('Database stopped — PVC preserved', { id: app.id });
            return true;
        }

        // Service pods (OpenClaw): settle billing then delete everything including workspace PVC
        if (app.type === 'service') {
            await stopPodBilling(app.id, true).catch(() => {});
            const wsPvcName = `ws-pvc-${shortId}`;
            await k8sService.deleteNamespacedDeployment(resourceName, app.namespace);
            await k8sService.deleteNamespacedService(resourceName, app.namespace);
            await k8sService.deleteNamespacedIngress(resourceName, app.namespace);
            await k8sService.deleteNamespacedPVC(wsPvcName, app.namespace);
            await db.query("UPDATE apps SET status = 'deleted' WHERE id = $1", [app.id]);
            logger.info('Service (OpenClaw) workspace destroyed', { id: app.id });
            return true;
        }

        // Standard apps: delete all k8s resources (including PVC if one exists)
        const pvcName = `app-data-${shortId}`; // PVC naming convention for apps that requested storage
        await k8sService.deleteNamespacedDeployment(resourceName, app.namespace);
        await k8sService.deleteNamespacedService(resourceName, app.namespace);
        await k8sService.deleteNamespacedIngress(resourceName, app.namespace);
        await k8sService.deleteNamespacedPVC(pvcName, app.namespace); // 404-tolerant — no-op if not present

        // Soft-delete in DB for audit trail
        await db.query("UPDATE apps SET status = 'deleted' WHERE id = $1", [app.id]);
        logger.info('App deleted', { id: app.id });
        return true;
    } catch (err) {
        logger.error('killAppCompletely failed', { id: app.id, err: err.message });
        // Still mark as deleted in DB to prevent the app from being stuck
        await db.query("UPDATE apps SET status = 'deleted' WHERE id = $1", [app.id]).catch(() => { });
        throw err;
    }
};
