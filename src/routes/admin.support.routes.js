import express from 'express';
import {
    handleAdminListContacts,
    handleAdminUpdateContactStatus,
    handleAdminListTickets,
    handleAdminGetTicket,
    handleAdminReplyTicket,
    handleAdminUpdateTicketStatus,
} from '../controllers/support.controller.js';
import { requireAdminKey } from '../middleware/adminAuth.js';

const router = express.Router();

const catchAsync = fn => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

router.use(requireAdminKey);

router.get('/contacts', catchAsync(handleAdminListContacts));
router.patch('/contacts/:id/status', catchAsync(handleAdminUpdateContactStatus));

router.get('/tickets', catchAsync(handleAdminListTickets));
router.get('/tickets/:id', catchAsync(handleAdminGetTicket));
router.post('/tickets/:id/message', catchAsync(handleAdminReplyTicket));
router.patch('/tickets/:id/status', catchAsync(handleAdminUpdateTicketStatus));

export default router;
