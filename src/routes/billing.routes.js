import { Router } from 'express';
import {
    listPlans,
    getBalance,
    initiatePayment,
    handleCallback,
    getTransactions,
    mockCheckout,
    processMockSuccess
} from '../controllers/billing.controller.js';
import { requireApiKey } from '../middleware/auth.js';

const router = Router();

// Public routes
router.get('/plans', listPlans);
router.post('/callback', handleCallback);
router.get('/mock-checkout', mockCheckout);
router.get('/mock-success', processMockSuccess);

// Protected routes
router.get('/balance', requireApiKey, getBalance);
router.post('/initiate-payment', requireApiKey, initiatePayment);
router.get('/transactions', requireApiKey, getTransactions);

export default router;
