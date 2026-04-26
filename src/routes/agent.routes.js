/**
 * agent.routes.js
 *
 * Routes called by OpenClaw agent pods running inside user namespaces.
 * Auth is via a per-user agent_token (NOT a user JWT session).
 */

import express from 'express';
import db from '../db/db.js';
import logger from '../utils/logger.js';
import { agentDeploy } from '../controllers/agentDeploy.controller.js';

const router = express.Router();

/**
 * Middleware: resolves the user from the Bearer agent_token header.
 * The token is the UUID stored in users.agent_token, injected into each
 * OpenClaw pod as the WREXER_AGENT_TOKEN environment variable.
 */
async function agentAuthMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing agent token' });
  }

  try {
    const { rows } = await db.query(
      'SELECT * FROM users WHERE agent_token = $1',
      [token]
    );
    if (!rows.length) {
      return res.status(401).json({ error: 'Invalid agent token' });
    }
    req.user = rows[0];
    next();
  } catch (err) {
    logger.error('agentAuthMiddleware error', err);
    res.status(500).json({ error: 'Auth check failed' });
  }
}

// POST /api/agent/deploy — trigger a Wrexer app deployment from inside a pod
router.post('/deploy', agentAuthMiddleware, agentDeploy);

export default router;
