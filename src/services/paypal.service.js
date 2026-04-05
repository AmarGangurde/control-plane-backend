import axios from 'axios';
import { paypal as paypalConfig } from '../config/env.js';

class PaypalService {
    constructor() {
        this.clientId = paypalConfig.clientId;
        this.clientSecret = paypalConfig.clientSecret;
        this.baseUrl =
            paypalConfig.env === 'production'
                ? 'https://api-m.paypal.com'
                : 'https://api-m.sandbox.paypal.com';
        this._accessToken = null;
        this._tokenExpiry = 0;
    }

    /**
     * Fetches a cached OAuth2 access token from PayPal.
     */
    async getAccessToken() {
        if (this._accessToken && Date.now() < this._tokenExpiry) {
            return this._accessToken;
        }

        if (!this.clientId || !this.clientSecret) {
            throw new Error('PayPal credentials missing. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env');
        }

        const res = await axios.post(
            `${this.baseUrl}/v1/oauth2/token`,
            'grant_type=client_credentials',
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                auth: { username: this.clientId, password: this.clientSecret }
            }
        );

        this._accessToken = res.data.access_token;
        // Expire 60 seconds early to be safe
        this._tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
        return this._accessToken;
    }

    /**
     * Creates a PayPal order and returns the approve URL + PayPal order ID.
     * @param {string} internalOrderId - Our internal transaction ID (for reference)
     * @param {number} amountUsd - Amount in USD (e.g. 1.20)
     * @param {string} returnUrl - URL to redirect to after approval
     * @param {string} cancelUrl - URL to redirect to on cancellation
     */
    async createOrder({ internalOrderId, amountUsd, returnUrl, cancelUrl }) {
        const token = await this.getAccessToken();

        const res = await axios.post(
            `${this.baseUrl}/v2/checkout/orders`,
            {
                intent: 'CAPTURE',
                purchase_units: [
                    {
                        reference_id: internalOrderId,
                        amount: {
                            currency_code: 'USD',
                            value: amountUsd.toFixed(2)
                        }
                    }
                ],
                application_context: {
                    brand_name: 'Wrexer',
                    landing_page: 'NO_PREFERENCE',
                    user_action: 'PAY_NOW',
                    return_url: returnUrl,
                    cancel_url: cancelUrl
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const approveLink = res.data.links.find(l => l.rel === 'approve');
        if (!approveLink) {
            throw new Error('PayPal did not return an approve URL');
        }

        return {
            paypalOrderId: res.data.id,
            approveUrl: approveLink.href
        };
    }

    /**
     * Captures a PayPal order after the user approves it.
     * @param {string} paypalOrderId - The PayPal order ID
     * @returns {string} - Capture status ('COMPLETED', etc.)
     */
    async captureOrder(paypalOrderId) {
        const token = await this.getAccessToken();

        const res = await axios.post(
            `${this.baseUrl}/v2/checkout/orders/${paypalOrderId}/capture`,
            {},
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return res.data.status; // 'COMPLETED' on success
    }
}

export default new PaypalService();
