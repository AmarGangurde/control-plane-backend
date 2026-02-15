import { Router } from 'express';
import {
  createApp,
  listApps,
  getApp,
  deleteApp,
  getAppLogs,
  updateApp
} from '../controllers/apps.controller.js';

const router = Router();

router.post('/', createApp);
router.get('/', listApps);
router.get('/:id', getApp);
router.get('/:id/logs', getAppLogs);
router.put('/:id', updateApp);
router.delete('/:id', deleteApp);

export default router;
