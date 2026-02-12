import dotenv from 'dotenv';

dotenv.config();

export const port = process.env.PORT || 3000;
export const baseDomain = process.env.BASE_DOMAIN || 'wrexer.com';
const isProd = process.env.NODE_ENV === 'production';

export const frontendUrl = process.env.FRONTEND_URL || (isProd ? 'https://wrexer.com' : 'http://localhost:5173');
export const apiBase = process.env.VITE_API_BASE || (isProd ? 'https://wrexer.com/api' : 'http://localhost:3000');

export const phonepe = {
    merchantId: process.env.PHONEPE_MERCHANT_ID,
    saltKey: process.env.PHONEPE_SALT_KEY,
    saltIndex: process.env.PHONEPE_SALT_INDEX,
    baseUrl: process.env.PHONEPE_BASE_URL
};
