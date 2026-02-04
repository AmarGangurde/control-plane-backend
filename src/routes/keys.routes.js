import { Router } from 'express';
import {
  createKey,
  listKeys,
  revokeKey,
  listFullKeys
} from '../controllers/keys.controller.js';

const router = Router();

router.get('/full', listFullKeys);
router.post('/', createKey);
router.get('/', listKeys);
router.delete('/:key', revokeKey);

export default router;
