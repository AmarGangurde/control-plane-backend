import crypto from 'crypto';
import { phonepe, apiBase } from '../config/env.js';

class PhonePeService {
    constructor() {
        this.merchantId = phonepe.merchantId || 'MOCK_MERCHANT_ID';
        this.saltKey = phonepe.saltKey || 'MOCK_SALT_KEY';
        this.saltIndex = phonepe.saltIndex || '1';
        this.baseUrl = phonepe.baseUrl || 'https://api-preprod.phonepe.com/apis/pg-sandbox';
    }

    generateChecksum(payload, endpoint) {
        const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
        const stringToHash = base64Payload + endpoint + this.saltKey;
        const sha256 = crypto.createHash('sha256').update(stringToHash).digest('hex');
        return `${sha256}###${this.saltIndex}`;
    }

    async initiatePayment({ transactionId, userId, amount, callbackUrl, redirectUrl }) {
        const payload = {
            merchantId: this.merchantId,
            merchantTransactionId: transactionId,
            merchantUserId: userId,
            amount: amount * 100, // PhonePe takes amount in paise
            redirectUrl: redirectUrl,
            redirectMode: 'POST',
            callbackUrl: callbackUrl,
            mobileNumber: '9999999999',
            paymentInstrument: {
                type: 'PAY_PAGE'
            }
        };

        const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
        const checksum = this.generateChecksum(payload, '/pg/v1/pay');

        // In a real scenario, you'd POST this to PhonePe. 
        // For this task, we return the data for the frontend to simulate or the actual URL if we had one.
        // We will return a simulated redirect URL to our own checkout page.

        return {
            url: `${apiBase}/api/billing/mock-checkout?tid=${transactionId}`,
            base64Payload,
            checksum
        };
    }

    verifyCallback(base64Payload, xVerifyHeader) {
        // Validate checksum for security
        const stringToHash = base64Payload + this.saltKey;
        const sha256 = crypto.createHash('sha256').update(stringToHash).digest('hex');
        const expectedChecksum = `${sha256}###${this.saltIndex}`;
        return expectedChecksum === xVerifyHeader;
    }
}

export default new PhonePeService();
