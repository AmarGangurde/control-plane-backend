import express from 'express';
import {
    handleAdminListContacts,
    handleAdminUpdateContactStatus,
    handleAdminListTickets,
    handleAdminGetTicket,
    handleAdminReplyTicket,
    handleAdminUpdateTicketStatus,
} from '../controllers/support.controller.js';
import { adminGrantTopup } from '../controllers/billing.controller.js';
import { adminDownloadInfraBackup } from '../controllers/admin.db.controller.js';
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

router.post('/grants/topup', catchAsync(adminGrantTopup));

// Infra DB backup download
router.get('/infra-db/backup', catchAsync(adminDownloadInfraBackup));

export default router;
