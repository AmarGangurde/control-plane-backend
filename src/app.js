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
const allowedOrigins = [
  'https://wrexer.com',
  'https://www.wrexer.com',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || origin.endsWith('.wrexer.com')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true
}));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// auth (google sign-in)
app.use('/api/auth', authRoutes);

/**
 * Admin-only routes
 */
app.use(
  '/api/keys',
  requireAdminKey,
  rateLimit('admin'),
  keysRoutes
);

/**
 * App routes (API key protected)
 */
app.use(
  '/api/apps',
  requireApiKey,
  rateLimit('user'),
  appsRoutes
);

/**
 * Billing routes (Mixed protection)
 */
app.use(
  '/api/billing',
  billingRoutes
);

export default app;
