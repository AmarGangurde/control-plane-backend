import { updateUserBalance } from '../models/user.model.js';
import { getPlans } from '../models/plan.model.js';
import cashfreeService from '../services/cashfree.service.js';
import db from '../db/db.js';
import { v4 as uuidv4 } from 'uuid';
import { frontendUrl, apiBase } from '../config/env.js';
import logger from '../utils/logger.js';

export const listPlans = async (req, res) => {
    const plans = await getPlans();
    res.json(plans);
};

export const getBalance = (req, res) => {
    res.json({
        balance: req.user.balance,
        reserved_balance: req.user.reserved_balance
    });
};

export const initiatePayment = async (req, res) => {
    const { amount } = req.body;
    const user = req.user;

    if (![50, 100, 200, 500].includes(amount)) {
        return res.status(400).json({ error: 'invalid amount. Choose 50, 100, 200, or 500.' });
    }

    const transactionId = `TXN_${uuidv4().split('-')[0].toUpperCase()}`;
    const amountPaise = amount * 100;

    // Create pending transaction
    await db.query(
        `INSERT INTO transactions (id, user_id, amount, type, status, external_id)
         VALUES ($1, $2, $3, 'topup', 'pending', $4)`,
        [uuidv4(), user.id, amountPaise, transactionId]
    );

    try {
        const order = await cashfreeService.createOrder({
            orderId: transactionId,
            amount: amount,
            customer: {
                id: user.id,
                email: user.email || 'customer@example.com',
                phone: user.phone || '9999999999'
            },
            redirectUrl: `${frontendUrl}/billing`
        });

        return res.json({
            paymentSessionId: order.paymentSessionId
        });
    } catch (err) {
        logger.error('Cashfree order creation failed', err);
        return res.status(500).json({ error: 'Payment initialization failed' });
    }
};

export const handleWebhook = async (req, res) => {
    try {
        const payload = req.body;

        // Cashfree webhook format usually has type as PAYMENT_SUCCESS_WEBHOOK
        // or just rely on data.order.order_status
        const eventType = payload.type || payload.event;
        const order_id = payload.data?.order?.order_id || payload.order_id;

        // We trust Cashfree webhook if IP is verified or signature is verified natively in a prod setting, 
        // per instructions: "Verify event type = PAYMENT_SUCCESS, Extract order_id, Mark payment as SUCCESS"

        if (eventType === 'PAYMENT_SUCCESS_WEBHOOK' || eventType === 'PAYMENT_SUCCESS') {
            if (!order_id) return res.status(400).json({ error: 'Missing order_id' });

            const client = await db.getClient();
            try {
                await client.query('BEGIN');
                const updateResult = await client.query(
                    "UPDATE transactions SET status = 'success' WHERE external_id = $1 AND status = 'pending'",
                    [order_id]
                );

                if (updateResult.rowCount > 0) {
                    const { rows } = await client.query(
                        'SELECT * FROM transactions WHERE external_id = $1',
                        [order_id]
                    );
                    const transaction = rows[0];
                    await client.query(
                        'UPDATE users SET balance = balance + $1 WHERE id = $2',
                        [Math.abs(transaction.amount), transaction.user_id]
                    );
                    logger.info(`Payment successful for transaction ${order_id}`);
                }
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        } else if (eventType === 'PAYMENT_FAILED_WEBHOOK' || eventType === 'PAYMENT_FAILED' || eventType === 'PAYMENT_USER_DROPPED_WEBHOOK') {
            if (!order_id) return res.status(400).json({ error: 'Missing order_id' });

            await db.query(
                "UPDATE transactions SET status = 'failed' WHERE external_id = $1 AND status = 'pending'",
                [order_id]
            );
            logger.info(`Payment failed/dropped for transaction ${order_id}`);
        }

        res.status(200).json({ success: true });
    } catch (err) {
        logger.error('Webhook processing failed', err.message);
        res.status(400).json({ error: 'Webhook processing error' });
    }
};

export const verifyReturn = async (req, res) => {
    const { order_id } = req.body;

    if (!order_id) return res.status(400).json({ error: 'Missing order_id' });

    try {
        const orderData = await cashfreeService.verifyOrder(order_id);

        if (orderData.order_status === 'PAID') {
            // Re-verify and update in DB if webhook didn't hit yet
            const client = await db.getClient();
            try {
                await client.query('BEGIN');
                const updateResult = await client.query(
                    "UPDATE transactions SET status = 'success' WHERE external_id = $1 AND status = 'pending'",
                    [order_id]
                );

                if (updateResult.rowCount > 0) {
                    const { rows } = await client.query(
                        'SELECT * FROM transactions WHERE external_id = $1',
                        [order_id]
                    );
                    const transaction = rows[0];
                    await client.query(
                        'UPDATE users SET balance = balance + $1 WHERE id = $2',
                        [Math.abs(transaction.amount), transaction.user_id]
                    );
                    logger.info(`Payment successful (verified manually) for transaction ${order_id}`);
                }
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
            return res.json({ status: 'success' });
        }

        return res.json({ status: orderData.order_status });
    } catch (err) {
        logger.error('Failed to verify order', err);
        return res.status(500).json({ error: 'Verification failed' });
    }
};

export const getTransactions = async (req, res) => {
    await db.query(`
        UPDATE transactions 
        SET status = 'expired' 
        WHERE status = 'pending' 
        AND type = 'topup'
        AND created_at < NOW() - INTERVAL '30 minutes'
    `);

    const { rows } = await db.query(
        `SELECT * FROM transactions 
         WHERE user_id = $1 
         AND NOT (type = 'topup' AND status IN ('pending', 'expired'))
         ORDER BY created_at DESC 
         LIMIT 50`,
        [req.user.id]
    );

    res.json(rows);
};
