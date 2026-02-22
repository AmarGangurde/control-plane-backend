import dotenv from 'dotenv';

dotenv.config();

export const port = process.env.PORT || 3000;
export const baseDomain = process.env.BASE_DOMAIN;

const isProd = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'PROD';

if (isProd && !baseDomain) {
    throw new Error('BASE_DOMAIN environment variable is REQUIRED in production');
}

export const frontendUrl = process.env.FRONTEND_URL;
if (isProd && !frontendUrl) {
    throw new Error('FRONTEND_URL environment variable is REQUIRED in production');
}

export const apiBase = process.env.VITE_API_BASE;

export const cashfree = {
    appId: process.env.CASHFREE_APP_ID,
    secretKey: process.env.CASHFREE_SECRET_KEY,
    env: process.env.CASHFREE_ENV || 'production'
};
