import k8sService from './k8s.service.js';
import db from '../db/db.js';
import { stopPodBilling } from './billing.service.js';
import logger from '../utils/logger.js';

export const killAppCompletely = async (app) => {
    try {
        logger.info('killAppCompletely called', { id: app.id, namespace: app.namespace, type: app.type });

        // Refund any reserved amount
        await stopPodBilling(app.id);

        if (!app.namespace) {
            logger.warn('killAppCompletely: missing namespace for app', app.id);
            return true;
        }

        const shortId = app.id.split('-')[0];
        const resourceName = app.type === 'database' ? `db-${shortId}` : `app-${shortId}`;

        if (app.type === 'database') {
            // Databases: ONLY delete deployment/service to preserve PVC (for "stop" functionality)
            // If the user actually wants to DELETE (destroy), we might need a separate 'destroy' flag
            // but for now killAppCompletely is used for both.
            await k8sService.deleteNamespacedDeployment(resourceName, app.namespace);
            await k8sService.deleteNamespacedService(resourceName, app.namespace);

            await db.query(
                "UPDATE apps SET status = 'stopped' WHERE id = $1",
                [app.id]
            );
            logger.info(`Database ${app.id} stopped (PVC preserved)`);
            return true;
        }

        // Standard Apps: Delete all associated k8s resources but NOT the shared namespace
        await k8sService.deleteNamespacedDeployment(resourceName, app.namespace);
        await k8sService.deleteNamespacedService(resourceName, app.namespace);
        await k8sService.deleteNamespacedIngress(resourceName, app.namespace);

    } catch (err) {
        logger.error('error in killAppCompletely', err?.message || err);
    }

    // Soft-delete for audit safety
    await db.query(
        "UPDATE apps SET status = 'deleted' WHERE id = $1",
        [app.id]
    );
    return true;
};
