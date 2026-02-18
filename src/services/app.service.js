import k8sService from './k8s.service.js';
import db from '../db/db.js';
import { stopPodBilling } from './billing.service.js';
import logger from '../utils/logger.js';

export const killAppCompletely = async (app) => {
    try {
        logger.info('killAppCompletely called', { id: app.id, namespace: app.namespace });

        // Refund any reserved amount before deleting
        await stopPodBilling(app.id);

        if (app.namespace) {
            await k8sService.deleteNamespace(app.namespace);
        } else {
            logger.warn('killAppCompletely: missing namespace for app', app.id);
        }
    } catch (err) {
        logger.error('error deleting namespace in killAppCompletely', err?.message || err);
    }

    // Soft-delete for audit safety
    await db.query(
        "UPDATE apps SET status = 'deleted' WHERE id = $1",
        [app.id]
    );
    return true;
};
