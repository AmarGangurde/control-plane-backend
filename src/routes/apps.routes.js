import { Router } from 'express';
import {
  createApp,
  listApps,
  getApp,
  deleteApp
} from '../controllers/apps.controller.js';

const router = Router();

router.post('/', createApp);
router.get('/', listApps);
router.get('/:id', getApp);
router.delete('/:id', deleteApp);

export default router;
