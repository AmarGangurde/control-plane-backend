import express from 'express';
import {
    handleCreateTicket,
    handleGetTickets,
    handleGetTicketMessages,
    handleReplyTicket
} from '../controllers/support.controller.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

const catchAsync = fn => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

router.use(requireAuth);

router.post('/', catchAsync(handleCreateTicket));
router.get('/', catchAsync(handleGetTickets));
router.get('/:id/messages', catchAsync(handleGetTicketMessages));
router.post('/:id/message', catchAsync(handleReplyTicket));

export default router;
