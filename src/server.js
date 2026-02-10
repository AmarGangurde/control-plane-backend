import 'dotenv/config';
import app from './app.js';
import { port } from './config/env.js';
import { startBillingCron } from './services/billing.service.js';

startBillingCron();

app.listen(port, () => {
  console.log(`🚀 Control plane API listening on port ${port}`);
});
