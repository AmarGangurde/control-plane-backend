import { updateUserBalance } from '../models/user.model.js';
import { getPlans } from '../models/plan.model.js';
import phonepeService from '../services/phonepe.service.js';
import db from '../db/db.js';
import { v4 as uuidv4 } from 'uuid';
import { frontendUrl, apiBase } from '../config/env.js';

export const listPlans = (req, res) => {
    const plans = getPlans();
    res.json(plans);
};

export const getBalance = (req, res) => {
    res.json({ balance: req.user.balance });
};

export const initiatePayment = async (req, res) => {
    const { amount } = req.body;
    const userId = req.user.id;

    if (![50, 100, 200, 500].includes(amount)) {
        return res.status(400).json({ error: 'invalid amount. Choose 50, 100, 200, or 500.' });
    }

    const transactionId = `TXN_${uuidv4().split('-')[0].toUpperCase()}`;

    // Create pending transaction
    db.prepare(`
        INSERT INTO transactions (id, user_id, amount, type, status, external_id)
        VALUES (?, ?, ?, 'topup', 'pending', ?)
    `).run(uuidv4(), userId, amount, transactionId);

    const paymentData = await phonepeService.initiatePayment({
        transactionId,
        userId,
        amount,
        callbackUrl: `${apiBase}/api/billing/callback`,
        redirectUrl: `${frontendUrl}/billing?status=success`
    });

    res.json({ url: paymentData.url });
};

export const handleCallback = (req, res) => {
    // In real PhonePe, this would be a POST with Base64 payload and X-VERIFY header
    const { response } = req.body; // Mocked for simplicity in this dev environment

    // Logic to update transaction status and user balance...
    // In our mock, we'll implement a specific route for the "Success" button on the mock page
    res.json({ success: true });
};

export const processMockSuccess = (req, res) => {
    const { tid } = req.query;

    const transaction = db.prepare('SELECT * FROM transactions WHERE external_id = ? AND status = \'pending\'').get(tid);

    if (transaction) {
        db.prepare('UPDATE transactions SET status = \'success\' WHERE external_id = ?').run(tid);
        updateUserBalance(transaction.user_id, Math.abs(transaction.amount));
        return res.redirect(`${frontendUrl}/billing?topup=success`);
    }

    res.send('Transaction not found or already processed.');
};

export const getTransactions = (req, res) => {
    const transactions = db.prepare(`
        SELECT * FROM transactions 
        WHERE user_id = ? 
        ORDER BY created_at DESC 
        LIMIT 50
    `).all(req.user.id);

    res.json(transactions);
};

export const mockCheckout = (req, res) => {
    const { tid } = req.query;
    const transaction = db.prepare('SELECT * FROM transactions WHERE external_id = ?').get(tid);

    if (!transaction) return res.status(404).send('Transaction not found');

    res.send(`
        <html>
            <head>
                <title>PhonePe Mock Checkout</title>
                <script src="https://cdn.tailwindcss.com"></script>
            </head>
            <body class="bg-gray-100 flex items-center justify-center min-h-screen">
                <div class="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full text-center border-t-8 border-purple-600">
                    <img src="https://www.phonepe.com/en/assets/images/logo.png" class="h-8 mx-auto mb-6" alt="PhonePe">
                    <h1 class="text-2xl font-bold mb-2">Secure Payment</h1>
                    <p class="text-gray-500 mb-6">Order: ${tid}</p>
                    
                    <div class="bg-gray-50 p-6 rounded-xl mb-8">
                        <div class="text-sm text-gray-500 mb-1">Total Amount</div>
                        <div class="text-4xl font-bold text-slate-900">₹${transaction.amount}</div>
                    </div>

                    <div class="space-y-4">
                        <a href="/api/billing/mock-success?tid=${tid}" class="block bg-purple-600 hover:bg-purple-700 text-white font-bold py-4 rounded-xl transition-all shadow-lg shadow-purple-200">
                            Pay via UPI / PhonePe
                        </a>
                        <a href="${frontendUrl}/billing?status=cancelled" class="block text-gray-400 font-medium hover:text-red-500 transition-colors">
                            Cancel Payment
                        </a>
                    </div>
                    
                    <div class="mt-8 flex items-center justify-center gap-2 text-xs text-gray-400">
                        <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z"></path></svg>
                        SSL SECURE PAYMENT
                    </div>
                </div>
            </body>
        </html>
    `);
};
