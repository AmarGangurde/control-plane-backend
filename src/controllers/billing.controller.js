import { updateUserBalance } from '../models/user.model.js';
import { getPlans } from '../models/plan.model.js';
import phonepeService, { StandardCheckoutPayRequest } from '../services/phonepe.service.js';
import db from '../db/db.js';
import { v4 as uuidv4 } from 'uuid';
import { frontendUrl, apiBase } from '../config/env.js';
import logger from '../utils/logger.js';

export const listPlans = (req, res) => {
    const plans = getPlans();
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
    const userId = req.user.id;

    if (![50, 100, 200, 500].includes(amount)) {
        return res.status(400).json({ error: 'invalid amount. Choose 50, 100, 200, or 500.' });
    }

    const transactionId = `TXN_${uuidv4().split('-')[0].toUpperCase()}`;

    // Create pending transaction in our DB
    db.prepare(`
        INSERT INTO transactions (id, user_id, amount, type, status, external_id)
        VALUES (?, ?, ?, 'topup', 'pending', ?)
    `).run(uuidv4(), userId, amount, transactionId);

    // Using the SDK-style request builder
    const request = StandardCheckoutPayRequest.builder()
        .merchantOrderId(transactionId)
        .amount(amount * 100) // Convert to paise
        .redirectUrl(`${frontendUrl}/billing?status=processing`)
        .callbackUrl(`${apiBase}/api/billing/callback`)
        .build();

    const response = await phonepeService.pay(request);

    res.json({ url: response.redirectUrl });
};

export const handleCallback = (req, res) => {
    try {
        const auth = req.headers['x-verify'] || req.headers['authorization'];
        const responseBody = req.body;

        const callbackData = phonepeService.validateCallback(auth, responseBody);
        const { merchantTransactionId, state } = callbackData.payload;

        if (state === 'COMPLETED') {
            const transaction = db.prepare('SELECT * FROM transactions WHERE external_id = ? AND status = \'pending\'').get(merchantTransactionId);
            if (transaction) {
                db.prepare('UPDATE transactions SET status = \'success\' WHERE external_id = ?').run(merchantTransactionId);
                updateUserBalance(transaction.user_id, Math.abs(transaction.amount));
                logger.info(`Payment successful for transaction ${merchantTransactionId}`);
            }
        }

        res.status(200).json({ success: true });
    } catch (err) {
        logger.error('Callback validation failed', err.message);
        res.status(400).json({ error: 'Unauthorized' });
    }
};

export const processMockSuccess = (req, res) => {
    const { tid } = req.query;

    // Simulate S2S Callback first (how PhonePe actually works)
    const transaction = db.prepare('SELECT * FROM transactions WHERE external_id = ?').get(tid);
    if (!transaction) return res.status(404).send('Not Found');

    const callbackPayload = {
        success: true,
        code: 'PAYMENT_SUCCESS',
        message: 'Payment Completed',
        payload: {
            merchantId: 'MOCK_MERCHANT_ID',
            merchantTransactionId: tid,
            transactionId: `T${Date.now()}`,
            amount: transaction.amount * 100,
            state: 'COMPLETED',
            responseCode: 'SUCCESS'
        }
    };

    const auth = phonepeService.generateChecksum(Buffer.from(JSON.stringify(callbackPayload)).toString('base64'), '');

    // Execute internal callback
    try {
        const mockReq = { headers: { 'x-verify': auth }, body: callbackPayload };
        handleCallback(mockReq, { status: () => ({ json: () => { } }) });
    } catch (e) { }

    res.redirect(`${frontendUrl}/billing?topup=success`);
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
                <title>PhonePe Secure Payment</title>
                <script src="https://cdn.tailwindcss.com"></script>
                <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;700;900&display=swap" rel="stylesheet">
                <style>body { font-family: 'Outfit', sans-serif; }</style>
            </head>
            <body class="bg-[#f4f4f7] flex items-center justify-center min-h-screen p-4">
                <div class="bg-white rounded-[2.5rem] shadow-[0_20px_50px_rgba(0,0,0,0.1)] max-w-md w-full overflow-hidden">
                    <div class="bg-[#5f259f] p-10 text-center relative overflow-hidden">
                        <div class="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -mr-16 -mt-16 blur-2xl"></div>
                        <img src="https://www.phonepe.com/en/assets/images/logo.png" class="h-8 mx-auto mb-8 brightness-0 invert" alt="PhonePe">
                        <div class="text-white/60 text-xs font-bold uppercase tracking-[0.2em] mb-2">Amount to Pay</div>
                        <div class="text-5xl font-black text-white leading-none">₹${transaction.amount}</div>
                    </div>
                    
                    <div class="p-10">
                        <div class="flex items-center justify-between mb-8 pb-8 border-b border-gray-100">
                            <div>
                                <div class="text-[10px] text-gray-400 font-black uppercase tracking-widest mb-1">Order ID</div>
                                <div class="text-sm font-bold text-gray-800">${tid}</div>
                            </div>
                            <div class="text-right">
                                <div class="text-[10px] text-gray-400 font-black uppercase tracking-widest mb-1">Status</div>
                                <div class="flex items-center gap-1 text-amber-500 font-bold text-sm">
                                    <div class="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></div>
                                    Awaiting Payment
                                </div>
                            </div>
                        </div>

                        <div class="bg-blue-50/50 border border-blue-100 p-6 rounded-3xl mb-8 flex items-start gap-4">
                            <div class="bg-blue-500 text-white p-2 rounded-xl">
                                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                            </div>
                            <p class="text-[13px] text-blue-800 leading-relaxed font-medium">
                                This is a <span class="font-black">Safe Sandbox Payment</span>. No real money will be deducted from your account.
                            </p>
                        </div>

                        <div class="space-y-4">
                            <a href="/api/billing/mock-success?tid=${tid}" class="group relative block w-full bg-[#5f259f] hover:bg-[#4d1e82] text-white font-black py-5 rounded-[1.5rem] transition-all text-center overflow-hidden shadow-xl shadow-purple-200">
                                <span class="relative z-10 flex items-center justify-center gap-3">
                                    Pay via UPI / PhonePe
                                    <svg class="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg>
                                </span>
                            </a>
                            <a href="${frontendUrl}/billing?status=cancelled" class="block text-center text-gray-400 text-sm font-bold hover:text-red-500 transition-colors py-2">
                                Cancel & Return to Dashboard
                            </a>
                        </div>

                        <div class="mt-12 pt-8 border-t border-gray-100 flex items-center justify-center gap-6 opacity-30 grayscale">
                            <img src="https://upload.wikimedia.org/wikipedia/commons/e/e1/UPI-Logo.png" class="h-4">
                            <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/c/cb/Rupay-Logo.png/1200px-Rupay-Logo.png" class="h-3">
                            <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/5/5e/Visa_Inc._logo.svg/2560px-Visa_Inc._logo.svg.png" class="h-2">
                        </div>
                    </div>
                </div>
                
                <div class="fixed bottom-8 text-center w-full text-gray-400 text-[10px] font-black uppercase tracking-[0.3em]">
                    Secured by PhonePe Payment Gateway
                </div>
            </body>
        </html>
    `);
};
