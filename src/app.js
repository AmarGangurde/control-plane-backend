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
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true, // Required for cookies
}));

app.use(rateLimiter);

// --- Public Routes ---
app.use('/auth', authRoutes);

// --- Mock Payment Routes (no auth needed — redirect endpoints) ---
app.get('/billing/mock-checkout', mockCheckout);
app.get('/billing/mock-success', processMockSuccess);
app.get('/billing/mock-cancel', cancelPayment);

// --- Payment Callback (server-to-server, no user auth) ---
app.post('/billing/callback', handleCallback);

// --- Protected Routes (JWT session or API key) ---
app.post('/apps', requireAuth, createApp);
app.get('/apps', requireAuth, listApps);
app.get('/apps/:id', requireAuth, getApp);
app.get('/apps/:id/logs', requireAuth, getAppLogs);
app.put('/apps/:id', requireAuth, updateApp);
app.delete('/apps/:id', requireAuth, deleteApp);

app.get('/billing/plans', requireAuth, listPlans);
app.get('/billing/balance', requireAuth, getBalance);
app.post('/billing/initiate-payment', requireAuth, initiatePayment);
app.get('/billing/transactions', requireAuth, getTransactions);

// --- Admin Routes ---
app.get('/admin/keys', requireAdminKey, listApiKeys);

export default app;
