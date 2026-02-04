import { Router } from 'express';
import { googleSignIn } from '../controllers/auth.controller.js';

const router = Router();

router.post('/google', googleSignIn);

export default router;
