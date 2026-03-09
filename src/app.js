import express from 'express';
import cors from 'cors';
import logger from './utils/logger.js';
import { requestId } from './middleware/requestId.js';
import cookieParser from 'cookie-parser';
import authRoutes from './routes/auth.routes.js';
import { listApiKeys } from './controllers/keys.controller.js';
import { createApp, listApps, getApp, getAppLogs, updateApp, deleteApp, setAlias, removeAlias, checkAliasAvailability } from './controllers/apps.controller.js';
import {
  listPlans,
  getBalance,
  initiatePayment,
  handleWebhook,
  verifyReturn,
  getTransactions
} from './controllers/billing.controller.js';
import {
  createDatabase,
  listDatabases,
  getDatabase,
  stopDatabase,
  startDatabase,
  destroyDatabase,
  downloadBackup
} from './controllers/databases.controller.js';
import { requireAuth } from './middleware/auth.js';
import { requireAdminKey } from './middleware/adminAuth.js';
import { rateLimiter } from './middleware/rateLimit.js';
import { frontendUrl, baseDomain } from './config/env.js';

import contactRoutes from './routes/contact.routes.js';
import ticketRoutes from './routes/tickets.routes.js';
import adminSupportRoutes from './routes/admin.support.routes.js';

const app = express();
const catchAsync = fn => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// --- Middleware ---
app.set('trust proxy', 1);
app.use(requestId);               // FIRST: assigns X-Request-ID to every request
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

const allowedOrigins = [
  frontendUrl,
  'http://localhost:5173',
  'http://localhost:3000',
  'https://wrexer.com',
  'https://www.wrexer.com',
  'https://dev.wrexer.com',
  baseDomain ? `https://${baseDomain}` : null,
  baseDomain ? `https://www.${baseDomain}` : null,
  baseDomain ? `https://dev.${baseDomain}` : null,
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    // Allow any subdomain of baseDomain in production
    if (baseDomain && origin.endsWith(`.${baseDomain}`)) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(rateLimiter);

// --- All routes under /api to match Nginx proxy_pass ---
const api = express.Router();

// Public auth routes
api.use('/auth', authRoutes);

// Cashfree Webhook
api.post('/webhook/cashfree', catchAsync(handleWebhook));

// Health check (used by Kubernetes probes)
api.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Protected routes (JWT session or API key)
api.post('/apps', requireAuth, catchAsync(createApp));
api.get('/apps', requireAuth, catchAsync(listApps));
api.get('/apps/:id', requireAuth, catchAsync(getApp));
api.get('/apps/:id/logs', requireAuth, catchAsync(getAppLogs));
api.put('/apps/:id', requireAuth, catchAsync(updateApp));
api.delete('/apps/:id', requireAuth, catchAsync(deleteApp));
api.put('/apps/:id/alias', requireAuth, catchAsync(setAlias));
api.delete('/apps/:id/alias', requireAuth, catchAsync(removeAlias));
api.get('/apps/alias/check', catchAsync(checkAliasAvailability)); // public — no auth

api.get('/billing/plans', requireAuth, catchAsync(listPlans));
api.get('/billing/balance', requireAuth, getBalance);
api.post('/billing/initiate-payment', requireAuth, catchAsync(initiatePayment));
api.post('/billing/verify-return', requireAuth, catchAsync(verifyReturn));
api.get('/billing/transactions', requireAuth, catchAsync(getTransactions));

// Database routes (Physical PostgreSQL Pods)
api.post('/databases', requireAuth, catchAsync(createDatabase));
api.get('/databases', requireAuth, catchAsync(listDatabases));
api.get('/databases/:id', requireAuth, catchAsync(getDatabase));
api.post('/databases/:id/stop', requireAuth, catchAsync(stopDatabase));
api.post('/databases/:id/start', requireAuth, catchAsync(startDatabase));
api.get('/databases/:id/backup', requireAuth, catchAsync(downloadBackup));
api.delete('/databases/:id', requireAuth, catchAsync(destroyDatabase));

// Admin routes
api.get('/admin/keys', requireAdminKey, listApiKeys);

// Support & Contact routes
api.use('/contact', contactRoutes);
api.use('/tickets', ticketRoutes);
api.use('/admin', adminSupportRoutes);

// Mount everything under /api
app.use('/api', api);

// Global error handler — prevents unhandled errors from crashing the process
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { err: err.message, stack: err.stack, path: req.path });

  if (res.headersSent) return next(err);

  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message
  });
});

export default app;
