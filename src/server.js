import app from './app.js';
import { startBillingCron } from './services/billing.service.js';
import db from './db/db.js';
import logger from './utils/logger.js';

const PORT = process.env.PORT || 3000;

const start = async () => {
  // Initialize PostgreSQL tables
  await db.initDb();
  logger.info('✅ Database initialized');

  // Start billing loop
  startBillingCron();

  app.listen(PORT, () => {
    logger.info(`Server listening on port ${PORT}`);
  });
};

start().catch(err => {
  logger.error('❌ Failed to start server:', err);
  process.exit(1);
});
