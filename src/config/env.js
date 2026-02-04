import dotenv from 'dotenv';

dotenv.config();

export const port = process.env.PORT || 3000;
export const baseDomain = process.env.BASE_DOMAIN || 'apps.localhost';
