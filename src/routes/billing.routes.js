import { Router } from 'express';
import {
    listPlans,
    getBalance,
    initiatePayment,
    handleCallback,
    getTransactions,
    mockCheckout,
    processMockSuccess,
    cancelPayment
} from '../controllers/billing.controller.js';
import { requireApiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

// Public routes
router.get('/plans', listPlans);
router.post('/callback', handleCallback);
router.get('/mock-checkout', mockCheckout);
router.get('/mock-success', processMockSuccess);
router.get('/mock-cancel', cancelPayment);

// Protected routes (Auth + Rate Limit)
router.get('/balance', requireApiKey, rateLimit('user'), getBalance);
router.post('/initiate-payment', requireApiKey, rateLimit('user'), initiatePayment);
router.get('/transactions', requireApiKey, rateLimit('user'), getTransactions);

export default router;
