/**
 * agent.routes.js
 *
 * Routes called by WrexForge pods via the wrexer CLI.
 * Auth: Bearer <agent_token> (per-user UUID stored in users.agent_token).
 */

import express from 'express';
import db from '../db/db.js';
import logger from '../utils/logger.js';
import { agentDeploy } from '../controllers/agentDeploy.controller.js';
import {
  agentGetContext,
  agentEstimate,
  agentListApps,
  agentListDatabases,
  agentDatabaseCreds,
  agentCreateDatabase,
  agentStopApp,
  agentDeleteApp,
  agentStopDatabase,
  agentDeleteDatabase,
  agentGetAppLogs,
} from '../controllers/agent.controller.js';

const router = express.Router();

/**
 * Middleware: resolves the user from the Bearer agent_token header.
 * The token is the UUID stored in users.agent_token, injected into each
 * WrexForge pod as the WREXER_AGENT_TOKEN environment variable.
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

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── Context & Estimation ────────────────────────────────────────────────────
router.get('/context',  agentAuthMiddleware, wrap(agentGetContext));
router.post('/estimate', agentAuthMiddleware, wrap(agentEstimate));

import { updateApp } from '../controllers/apps.controller.js';

// ── App deployment ──────────────────────────────────────────────────────────
router.post('/deploy',       agentAuthMiddleware, wrap(agentDeploy));
router.get('/apps',          agentAuthMiddleware, wrap(agentListApps));
router.get('/apps/:id/logs', agentAuthMiddleware, wrap(agentGetAppLogs));
router.patch('/apps/:id',    agentAuthMiddleware, wrap(updateApp));
router.post('/apps/:id/stop', agentAuthMiddleware, wrap(agentStopApp));
router.delete('/apps/:id',   agentAuthMiddleware, wrap(agentDeleteApp));

// ── Database provisioning ───────────────────────────────────────────────────
router.post('/database',              agentAuthMiddleware, wrap(agentCreateDatabase));
router.get('/databases',              agentAuthMiddleware, wrap(agentListDatabases));
router.get('/databases/:id/creds',    agentAuthMiddleware, wrap(agentDatabaseCreds));
router.post('/databases/:id/stop',    agentAuthMiddleware, wrap(agentStopDatabase));
router.delete('/databases/:id',       agentAuthMiddleware, wrap(agentDeleteDatabase));

export default router;
