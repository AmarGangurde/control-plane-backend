import fetch from 'node-fetch';
import { createUser, getUserByEmail } from '../models/user.model.js';
import { createApiKeyForUser, getApiKeyInfoForUser } from '../models/apiKey.model.js';
import { signJwt } from '../middleware/auth.js';
import logger from '../utils/logger.js';
import k8sService from '../services/k8s.service.js';
import { baseDomain } from '../config/env.js';

const isProd = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'PROD';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: isProd,
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  path: '/',
  domain: (isProd && baseDomain && !baseDomain.includes('localhost')) ? `.${baseDomain}` : undefined, // Allow cookie to be shared across subdomains
};

// POST /auth/google
// body: { id_token }
export const googleSignIn = async (req, res) => {
  const { id_token } = req.body || {};

  if (!id_token) return res.status(400).json({ error: 'missing id_token' });

  try {
    // verify token with Google's tokeninfo endpoint
    const verifyRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(id_token)}`
    );

    if (!verifyRes.ok) {
      const err = await verifyRes.json().catch(() => ({}));
      return res.status(401).json({ error: 'invalid id_token', detail: err });
    }

    const payload = await verifyRes.json();
    const { email, email_verified, sub: googleId } = payload;

    if (!email || (email_verified !== 'true' && email_verified !== true)) {
      return res.status(401).json({ error: 'email not verified' });
    }

    let user = await getUserByEmail(email);
    if (!user) {
      user = await createUser(googleId, email);
    }

    // Issue JWT and set as HttpOnly cookie
    const token = signJwt(user.id, user.email);

    // [New] Ensure K8s namespace exists early. Awaiting ensures the environment is ready.
    const namespace = `user-${user.id}`;
    await k8sService.ensureUserNamespace(namespace).catch(k8sErr => {
      logger.error(`Early namespace initialization failed for ${user.id}`, k8sErr);
    });

    res.cookie('session', token, COOKIE_OPTIONS);

    return res.status(200).json({
      user: {
        id: user.id,
        email: user.email,
        balance: user.balance
      }
    });

  } catch (err) {
    logger.error('googleSignIn error', err);
    return res.status(500).json({ error: 'server error' });
  }
};

// POST /auth/logout
export const logout = (_req, res) => {
  res.clearCookie('session', COOKIE_OPTIONS);
  return res.status(200).json({ success: true });
};

// GET /auth/me — returns current user info from the JWT session
export const getMe = async (req, res) => {
  // req.user is set by the requireAuth middleware
  return res.status(200).json({
    user: {
      id: req.user.id,
      email: req.user.email,
      balance: req.user.balance
    }
  });
};

// POST /auth/api-key — creates or replaces the user's API key
export const createUserApiKey = async (req, res) => {
  try {
    const { rawKey, keyPrefix } = await createApiKeyForUser(req.user.id, req.user.email);
    return res.status(201).json({
      key: rawKey, // shown ONCE to the user
      prefix: keyPrefix,
      message: 'API key created. This key will only be shown once. Store it securely.'
    });
  } catch (err) {
    logger.error('createUserApiKey error', err);
    return res.status(500).json({ error: 'Failed to create API key' });
  }
};

// GET /auth/api-key — returns key metadata (prefix only, not the full key)
export const getApiKeyStatus = async (req, res) => {
  try {
    const keyInfo = await getApiKeyInfoForUser(req.user.id);
    if (!keyInfo) {
      return res.status(200).json({ hasKey: false });
    }
    return res.status(200).json({
      hasKey: true,
      prefix: keyInfo.key_prefix,
      name: keyInfo.name,
      created_at: keyInfo.created_at
    });
  } catch (err) {
    logger.error('getApiKeyStatus error', err);
    return res.status(500).json({ error: 'Failed to fetch API key status' });
  }
};

// POST /auth/docker-token — updates the user's Docker Hub/registry credentials
export const updateDockerToken = async (req, res) => {
  try {
    const { username, token } = req.body;
    if (!username || !token) {
      return res.status(400).json({ error: 'Username and token are required' });
    }

    const { updateDockerCredentials } = await import('../models/user.model.js');
    await updateDockerCredentials(req.user.id, username, token);

    // Sync new credentials to K8s immediately so running apps can use them
    const namespace = `user-${req.user.id}`;
    await k8sService.syncUserRegistrySecret(namespace, username, token).catch(err => {
      logger.warn('Failed to sync docker secret to K8s during update (non-fatal)', err?.message);
    });

    return res.status(200).json({
      success: true,
      message: 'Docker credentials updated successfully'
    });
  } catch (err) {
    logger.error('updateDockerToken error', err);
    return res.status(500).json({ error: 'Failed to update Docker credentials' });
  }
};

// --- GitHub OAuth ---

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

// GET /auth/github — Redirects to GitHub OAuth
export const initiateGithubLogin = (req, res) => {
  const scope = 'read:user user:email';
  const githubUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&scope=${encodeURIComponent(scope)}`;
  res.redirect(githubUrl);
};

// GET /auth/github/callback
export const githubCallback = async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.redirect(`${process.env.FRONTEND_URL}/?error=no_code`);
  }

  try {
    // 1. Get Access Token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code
      })
    });

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      logger.error('Failed to get GitHub access token', tokenData);
      return res.redirect(`${process.env.FRONTEND_URL}/?error=token_failed`);
    }

    // 2. Get User Profile
    const userRes = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const profile = await userRes.json();
    const githubId = String(profile.id);

    // 3. Get User Email (primary and verified)
    const emailRes = await fetch('https://api.github.com/user/emails', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const emails = await emailRes.json();
    const primaryEmail = emails.find(e => e.primary && e.verified)?.email || emails[0]?.email;

    if (!primaryEmail) {
      return res.redirect(`${process.env.FRONTEND_URL}/?error=no_email`);
    }

    // 4. Link/Login Logic
    const { getUserByEmail, createUser, getUserByGithubId, updateGithubId } = await import('../models/user.model.js');

    let user = await getUserByGithubId(githubId);

    if (!user) {
      // Check if user with same email exists (merging)
      user = await getUserByEmail(primaryEmail);
      if (user) {
        // Link GitHub account to existing email account
        await updateGithubId(user.id, githubId);
        logger.info(`Linked GitHub account ${githubId} to existing user ${user.id} (${primaryEmail})`);
      } else {
        // Create new user (setting googleId to null for now)
        user = await createUser(null, primaryEmail);
        await updateGithubId(user.id, githubId);
        logger.info(`Created new user via GitHub: ${user.id} (${primaryEmail})`);
      }
    }

    // 5. Setup Session
    const namespace = `user-${user.id}`;
    await k8sService.ensureUserNamespace(namespace).catch(k8sErr => {
      logger.error(`Namespace initialization failed via GitHub login for ${user.id}`, k8sErr);
    });

    const token = signJwt(user.id, user.email);
    res.cookie('session', token, COOKIE_OPTIONS);

    // Redirect back to frontend dashboard
    return res.redirect(`${process.env.FRONTEND_URL}/dashboard`);

  } catch (err) {
    logger.error('githubCallback error', err);
    return res.redirect(`${process.env.FRONTEND_URL}/?error=auth_failed`);
  }
};

// GET /auth/docker-token — returns Docker credential status
export const getDockerTokenStatus = async (req, res) => {
  try {
    const { getUserById } = await import('../models/user.model.js');
    const user = await getUserById(req.user.id);

    return res.status(200).json({
      hasToken: !!user.docker_token,
      username: user.docker_username || null
    });
  } catch (err) {
    logger.error('getDockerTokenStatus error', err);
    return res.status(500).json({ error: 'Failed to fetch Docker status' });
  }
};

// DELETE /auth/docker-token — clears Docker credentials
export const deleteDockerToken = async (req, res) => {
  try {
    const { updateDockerCredentials } = await import('../models/user.model.js');
    await updateDockerCredentials(req.user.id, null, null);

    // Also delete the K8s secret so old creds don't persist in the cluster.
    // If the secret doesn't exist, this is a no-op (handled gracefully inside).
    const namespace = `user-${req.user.id}`;
    await k8sService.deleteNamespacedSecret('user-registry-key', namespace).catch(err => {
      logger.warn('Failed to delete user-registry-key secret from K8s (non-fatal)', err?.message);
    });

    return res.status(200).json({
      success: true,
      message: 'Docker credentials removed'
    });
  } catch (err) {
    logger.error('deleteDockerToken error', err);
    return res.status(500).json({ error: 'Failed to remove Docker credentials' });
  }
};
