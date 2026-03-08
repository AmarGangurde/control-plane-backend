import express from 'express';
import { handleCreateContact } from '../controllers/support.controller.js';

const router = express.Router();

const catchAsync = fn => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

router.post('/', catchAsync(handleCreateContact));

export default router;
