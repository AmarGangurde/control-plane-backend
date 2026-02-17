import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import authRoutes from './routes/auth.routes.js';
import { listApiKeys } from './controllers/keys.controller.js';
import { createApp, listApps, getApp, getAppLogs, updateApp, deleteApp } from './controllers/apps.controller.js';
import {
  listPlans,
  getBalance,
  initiatePayment,
  handleCallback,
  getTransactions,
  mockCheckout,
  processMockSuccess,
  cancelPayment
} from './controllers/billing.controller.js';
import { requireAuth } from './middleware/auth.js';
import { requireAdminKey } from './middleware/adminAuth.js';
import { rateLimiter } from './middleware/rateLimit.js';
import { frontendUrl } from './config/env.js';

const app = express();

// --- Middleware ---
app.use(express.json());
app.use(cookieParser());

const allowedOrigins = [
  frontendUrl,
  'http://localhost:5173',
  'http://localhost:3000',
  'https://wrexer.com',
  'https://www.wrexer.com',
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
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

// Mock payment routes (no auth — redirect endpoints)
api.get('/billing/mock-checkout', mockCheckout);
api.get('/billing/mock-success', processMockSuccess);
api.get('/billing/mock-cancel', cancelPayment);

// Payment callback (server-to-server, no user auth)
api.post('/billing/callback', handleCallback);

// Protected routes (JWT session or API key)
api.post('/apps', requireAuth, createApp);
api.get('/apps', requireAuth, listApps);
api.get('/apps/:id', requireAuth, getApp);
api.get('/apps/:id/logs', requireAuth, getAppLogs);
api.put('/apps/:id', requireAuth, updateApp);
api.delete('/apps/:id', requireAuth, deleteApp);

api.get('/billing/plans', requireAuth, listPlans);
api.get('/billing/balance', requireAuth, getBalance);
api.post('/billing/initiate-payment', requireAuth, initiatePayment);
api.get('/billing/transactions', requireAuth, getTransactions);

// Admin routes
api.get('/admin/keys', requireAdminKey, listApiKeys);

// Mount everything under /api
app.use('/api', api);

export default app;
