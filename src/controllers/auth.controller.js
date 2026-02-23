import fetch from 'node-fetch';
import { createUser, getUserByEmail } from '../models/user.model.js';
import { createApiKeyForUser, getApiKeyInfoForUser } from '../models/apiKey.model.js';
import { signJwt } from '../middleware/auth.js';

const isProd = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'PROD';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: isProd,
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  path: '/',
  domain: isProd ? '.wrexer.com' : undefined, // Allow cookie to be shared across subdomains
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

    res.cookie('session', token, COOKIE_OPTIONS);

    return res.status(200).json({
      user: {
        id: user.id,
        email: user.email,
        balance: user.balance
      }
    });

  } catch (err) {
    console.error('googleSignIn error', err?.message || err);
    return res.status(500).json({ error: 'server error' });
  }
};

// POST /auth/logout
export const logout = (_req, res) => {
  res.clearCookie('session', { path: '/' });
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
    console.error('createUserApiKey error', err?.message || err);
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
    console.error('getApiKeyStatus error', err?.message || err);
    return res.status(500).json({ error: 'Failed to fetch API key status' });
  }
};
