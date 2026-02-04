import 'dotenv/config';
import app from './app.js';
import { port } from './config/env.js';

app.listen(port, () => {
  console.log(`🚀 Control plane API listening on port ${port}`);
});
