import dotenv from 'dotenv';

dotenv.config();

export const port = process.env.PORT || 3000;
export const baseDomain = process.env.BASE_DOMAIN || 'wrexer.com';

const isProd = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'PROD';

export const frontendUrl = process.env.FRONTEND_URL || (isProd ? 'https://wrexer.com' : 'http://localhost:5173');
export const apiBase = process.env.VITE_API_BASE || (isProd ? 'https://wrexer.com/api' : 'http://localhost:3000');

export const cashfree = {
    appId: process.env.CASHFREE_APP_ID,
    secretKey: process.env.CASHFREE_SECRET_KEY,
    env: process.env.CASHFREE_ENV || 'production'
};
