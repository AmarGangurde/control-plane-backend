import express from 'express';
import { handleCreateContact } from '../controllers/support.controller.js';
import { contactRateLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

const catchAsync = fn => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// 3 submissions per IP per 10 minutes — enforced via Redis (distributed)
router.post('/', contactRateLimiter, catchAsync(handleCreateContact));

export default router;
