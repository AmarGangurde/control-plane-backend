import { Router } from 'express';
import { googleSignIn, logout, getMe, createUserApiKey, getApiKeyStatus, updateDockerToken, getDockerTokenStatus, deleteDockerToken, initiateGithubLogin, githubCallback } from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Public
router.post('/google', googleSignIn);

// Protected (requires JWT session or API key)
router.post('/logout', requireAuth, logout);
router.get('/me', requireAuth, getMe);
router.post('/api-key', requireAuth, createUserApiKey);
router.get('/api-key', requireAuth, getApiKeyStatus);

// GitHub Auth
router.get('/github', initiateGithubLogin);
router.get('/github/callback', githubCallback);

// Docker Registry Token
router.post('/docker-token', requireAuth, updateDockerToken);
router.get('/docker-token', requireAuth, getDockerTokenStatus);
router.delete('/docker-token', requireAuth, deleteDockerToken);

export default router;
