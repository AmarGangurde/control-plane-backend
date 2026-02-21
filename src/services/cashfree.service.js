import axios from 'axios';
import { cashfree } from '../config/env.js';

class CashfreeService {
    constructor() {
        this.appId = cashfree.appId;
        this.secretKey = cashfree.secretKey;
        this.baseUrl =
            cashfree.env === 'production'
                ? 'https://api.cashfree.com/pg'
                : 'https://sandbox.cashfree.com/pg';
    }

    async createOrder({ orderId, amount, customer, redirectUrl }) {
        if (!this.appId || !this.secretKey) {
            console.warn('Cashfree credentials missing. Ensure CASHFREE_APP_ID and CASHFREE_SECRET_KEY are set.');
        }

        try {
            const res = await axios.post(
                `${this.baseUrl}/orders`,
                {
                    order_id: orderId,
                    order_amount: amount,
                    order_currency: "INR",
                    customer_details: {
                        customer_id: customer.id || "CUST_DEFAULT",
                        customer_email: customer.email || "customer@example.com",
                        customer_phone: customer.phone || "9999999999"
                    },
                    order_meta: {
                        return_url: `${redirectUrl}?order_id=${orderId}`
                    }
                },
                {
                    headers: {
                        "x-api-version": "2023-08-01",
                        "x-client-id": this.appId,
                        "x-client-secret": this.secretKey,
                        "Content-Type": "application/json"
                    }
                }
            );

            return {
                orderId: res.data.order_id,
                paymentSessionId: res.data.payment_session_id
            };
        } catch (err) {
            throw new Error(`Cashfree createOrder error: ${JSON.stringify(err.response?.data) || err.message}`);
        }
    }

    async verifyOrder(orderId) {
        try {
            const res = await axios.get(
                `${this.baseUrl}/orders/${orderId}`,
                {
                    headers: {
                        "x-api-version": "2023-08-01",
                        "x-client-id": this.appId,
                        "x-client-secret": this.secretKey
                    }
                }
            );

            return res.data;
        } catch (err) {
            throw new Error(`Cashfree verifyOrder error: ${JSON.stringify(err.response?.data) || err.message}`);
        }
    }
}

export default new CashfreeService();
