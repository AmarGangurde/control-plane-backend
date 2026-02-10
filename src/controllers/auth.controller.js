import fetch from 'node-fetch';
import { createUser, getUserByEmail } from '../models/user.model.js';
import { createApiKey, getApiKeyByName, getApiKey } from '../models/apiKey.model.js';

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
    const { email, email_verified, sub: googleId } = payload;

    if (!email || (email_verified !== 'true' && email_verified !== true)) {
      return res.status(401).json({ error: 'email not verified' });
    }

    let user = getUserByEmail(email);
    if (!user) {
      user = createUser(googleId, email);
    }

    // For backward compatibility / ease of use, we can still issue an API Key for this user
    // In a real app we'd use a JWT session for the frontend.
    // For this MVP, let's link an API key to the email (which is unique per user).
    // If key exists, return it. If not, create it.
    // Note: Ideally we should link keys to user_id, but our legacy scheme binds to name/email.
    // Let's stick to the existing apiKey model for the "token" part, but return the User object.

    let keyRecord = getApiKeyByName(email);
    let key;
    if (keyRecord) {
      key = keyRecord.key;
    } else {
      key = createApiKey(email);
    }

    // Return the key and the user object
    return res.status(200).json({
      key,
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

