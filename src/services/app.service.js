import k8sService from './k8s.service.js';
import db from '../db/db.js';
import { stopPodBilling } from './billing.service.js';
import logger from '../utils/logger.js';

export const killAppCompletely = async (app) => {
    try {
        logger.info('killAppCompletely called', { id: app.id, namespace: app.namespace, type: app.type });

        // Refund any reserved amount before deleting
        await stopPodBilling(app.id);

        if (app.type === 'database') {
            // Databases: ONLY delete deployment to preserve PVC
            if (app.namespace) {
                await k8sService.deleteNamespacedDeployment('database', app.namespace);
            }
            await db.query(
                "UPDATE apps SET status = 'stopped', reserved_amount = 0 WHERE id = $1",
                [app.id]
            );
            logger.info(`Database ${app.id} stopped (PVC preserved)`);
            return true;
        }

        // Standard Apps: Full deletion
        if (app.namespace) {
            await k8sService.deleteNamespace(app.namespace);
        } else {
            logger.warn('killAppCompletely: missing namespace for app', app.id);
        }
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
