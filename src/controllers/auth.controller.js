import fetch from 'node-fetch';
import { createApiKey, getApiKeyByName } from '../models/apiKey.model.js';

// POST /auth/google
// body: { id_token }
export const googleSignIn = async (req, res) => {
  const { id_token } = req.body || {};

  if (!id_token) return res.status(400).json({ error: 'missing id_token' });

  try {
    // verify token with Google's tokeninfo endpoint
    const verifyRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(
        id_token
      )}`
    );

    if (!verifyRes.ok) {
      const err = await verifyRes.json().catch(() => ({}));
      return res.status(401).json({ error: 'invalid id_token', detail: err });
    }

    const payload = await verifyRes.json();

    // tokeninfo returns fields like email, email_verified
    const { email, email_verified } = payload;

    if (!email || email_verified !== 'true' && email_verified !== true) {
      return res.status(401).json({ error: 'email not verified' });
    }

    // check if a key already exists for this email; if so, refuse to reveal
    const existing = getApiKeyByName(email);
    if (existing) {
      return res.status(409).json({
        error:
          'API key for this account already exists. Contact admin to re-issue.'
      });
    }

    // create a new API key with the user's email as name
    const key = createApiKey(email);

    // return the key once (client should save it securely)
    return res.status(201).json({ key, email });
  } catch (err) {
    console.error('googleSignIn error', err?.message || err);
    return res.status(500).json({ error: 'server error' });
  }
};
