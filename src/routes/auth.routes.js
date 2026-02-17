import { Router } from 'express';
import { googleSignIn, logout, getMe, createUserApiKey, getApiKeyStatus } from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Public
router.post('/google', googleSignIn);

// Protected (requires JWT session or API key)
router.post('/logout', requireAuth, logout);
router.get('/me', requireAuth, getMe);
router.post('/api-key', requireAuth, createUserApiKey);
router.get('/api-key', requireAuth, getApiKeyStatus);

export default router;
