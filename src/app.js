import express from 'express';
import cors from 'cors';
import billingRoutes from './routes/billing.routes.js';
import appsRoutes from './routes/apps.routes.js';
import keysRoutes from './routes/keys.routes.js';
import authRoutes from './routes/auth.routes.js';
import { requireApiKey } from './middleware/auth.js';
import { requireAdminKey } from './middleware/adminAuth.js';
import { rateLimit } from './middleware/rateLimit.js';

const app = express();

app.use(express.json());
// Configure CORS (more secure for production)
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
app.use(cors({
  origin: frontendUrl,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// auth (google sign-in)
app.use('/auth', authRoutes);

/**
 * Admin-only routes
 */
app.use(
  '/keys',
  requireAdminKey,
  rateLimit('admin'),
  keysRoutes
);

/**
 * App routes (API key protected)
 */
app.use(
  '/apps',
  requireApiKey,
  rateLimit('user'),
  appsRoutes
);

/**
 * Billing routes (API key protected)
 */
app.use(
  '/billing',
  requireApiKey,
  rateLimit('user'),
  billingRoutes
);

export default app;
