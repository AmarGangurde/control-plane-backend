import 'dotenv/config';
import app from './app.js';
import { startBillingCron, startPaymentVerificationCron } from './services/billing.service.js';
import db from './db/db.js';
import logger from './utils/logger.js';

const PORT = process.env.PORT || 3000;

const start = async () => {
  // Initialize PostgreSQL tables
  await db.initDb();
  logger.info('✅ Database initialized');

  // Start billing loop
  startBillingCron();

  // Start background payment verification
  startPaymentVerificationCron();

  app.listen(PORT, () => {
    logger.info(`Server listening on port ${PORT}`);
  });
};

start().catch(err => {
  logger.error('❌ Failed to start server:', err);
  process.exit(1);
});

// Graceful shutdown
const shutdown = async () => {
  logger.info('Graceful shutdown initiated');
  try {
    await db.pool.end();
  } catch (e) {
    logger.error('Error during shutdown:', e);
  }
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
