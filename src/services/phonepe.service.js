import crypto from 'crypto';
import { phonepe, apiBase } from '../config/env.js';

/**
 * Simulations for the PhonePe SDK Classes
 * This ensures the transition to the real SDK is minimal once IDs are available.
 */
class StandardCheckoutPayRequest {
    static builder() {
        return new this();
    }
    merchantOrderId(id) { this.merchantOrderId = id; return this; }
    amount(amt) { this.amount = amt; return this; }
    redirectUrl(url) { this.redirectUrl = url; return this; }
    callbackUrl(url) { this.callbackUrl = url; return this; }
    build() { return this; }
}

class PhonePeService {
    constructor() {
        this.merchantId = phonepe.merchantId || 'MOCK_MERCHANT_ID';
        this.saltKey = phonepe.saltKey || 'MOCK_SALT_KEY';
        this.saltIndex = phonepe.saltIndex || '1';
        this.baseUrl = phonepe.baseUrl || 'https://api-preprod.phonepe.com/apis/pg-sandbox';
    }

    /**
     * Mimics SDK client.pay(request)
     */
    async pay(request) {
        // PhonePe takes amount in paise (x100)
        const amountInPaise = request.amount;

        const payload = {
            merchantId: this.merchantId,
            merchantTransactionId: request.merchantOrderId,
            amount: amountInPaise,
            redirectUrl: request.redirectUrl,
            callbackUrl: request.callbackUrl,
            paymentInstrument: { type: 'PAY_PAGE' }
        };

        const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
        const checksum = this.generateChecksum(base64Payload, '/pg/v1/pay');

        return {
            redirectUrl: `${apiBase}/api/billing/mock-checkout?tid=${request.merchantOrderId}`,
            base64Payload,
            checksum
        };
    }

    generateChecksum(base64Payload, endpoint) {
        const stringToHash = base64Payload + endpoint + this.saltKey;
        const sha256 = crypto.createHash('sha256').update(stringToHash).digest('hex');
        return `${sha256}###${this.saltIndex}`;
    }

    /**
     * Mimics SDK validateCallback(user, pass, auth, body)
     */
    validateCallback(authorization, responseBody) {
        // Simulation of S2S validation
        const bodyStr = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
        const base64Body = Buffer.from(bodyStr).toString('base64');

        const stringToHash = base64Body + this.saltKey;
        const sha256 = crypto.createHash('sha256').update(stringToHash).digest('hex');
        const expectedAuth = `${sha256}###${this.saltIndex}`;

        if (authorization !== expectedAuth) {
            throw new Error('Invalid Checksum Match');
        }

        return JSON.parse(bodyStr);
    }
}

export { StandardCheckoutPayRequest };
export default new PhonePeService();
