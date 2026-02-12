import dotenv from 'dotenv';

dotenv.config();

export const port = process.env.PORT || 3000;
export const baseDomain = process.env.BASE_DOMAIN || 'wrexer.com';
export const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
export const apiBase = process.env.VITE_API_BASE || 'http://localhost:3000';

export const phonepe = {
    merchantId: process.env.PHONEPE_MERCHANT_ID,
    saltKey: process.env.PHONEPE_SALT_KEY,
    saltIndex: process.env.PHONEPE_SALT_INDEX,
    baseUrl: process.env.PHONEPE_BASE_URL
};
