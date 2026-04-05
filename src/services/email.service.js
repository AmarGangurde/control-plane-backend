import nodemailer from 'nodemailer';
import logger from '../utils/logger.js';
import db from '../db/db.js';
import { frontendUrl } from '../config/env.js';

// ── Transporter ───────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: process.env.SMTP_SECURE !== 'false', // true = TLS
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

const FROM = process.env.SMTP_FROM || `"Wrexer" <no-reply@wrexer.com>`;

// ── Core sender ───────────────────────────────────────────────────────────────
async function sendMail(to, subject, html) {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        logger.warn(`[email] SMTP not configured — skipping email to ${to}: ${subject}`);
        return;
    }
    try {
        const info = await transporter.sendMail({ from: FROM, to, subject, html });
        logger.info(`[email] Sent "${subject}" → ${to} (id: ${info.messageId})`);
    } catch (err) {
        // Non-fatal — never let email failure break billing
        logger.error(`[email] FAILED to send "${subject}" → ${to}: ${err.message}`);
    }
}

// ── Get user email by userId ──────────────────────────────────────────────────
async function getUserEmail(userId) {
    const { rows } = await db.query('SELECT email FROM users WHERE id = $1', [userId]);
    return rows[0] || null;
}

// ── Shared HTML wrapper ───────────────────────────────────────────────────────
function wrap(content) {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0b1121;color:#e2e8f0;margin:0;padding:0}
.container{max-width:520px;margin:40px auto;padding:32px 36px;background:#111827;border-radius:16px;border:1px solid #1e293b}
h2{margin:0 0 12px;color:#fff;font-size:20px;font-weight:800}
p{margin:8px 0;color:#94a3b8;font-size:14px;line-height:1.6}
.pill{display:inline-block;padding:4px 12px;border-radius:99px;font-size:12px;font-weight:700;margin:4px 0}
.red{background:#7f1d1d;color:#fca5a5}.green{background:#14532d;color:#86efac}.amber{background:#78350f;color:#fcd34d}.violet{background:#2e1065;color:#c4b5fd}
.btn{display:inline-block;margin-top:20px;padding:12px 28px;background:#7c3aed;color:#fff!important;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px}
.footer{margin-top:28px;border-top:1px solid #1e293b;padding-top:16px;font-size:12px;color:#475569;text-align:center}
</style></head><body><div class="container">${content}<div class="footer">Wrexer · Deploy anywhere · <a href="${frontendUrl || 'https://wrexer.com'}" style="color:#7c3aed">wrexer.com</a></div></div></body></html>`;
}

// ── Templates ─────────────────────────────────────────────────────────────────

// 1. App killed by billing (insufficient funds)
export async function emailAppKilledLowBalance(userId, appName, appUrl) {
    const user = await getUserEmail(userId);
    if (!user) return;
    await sendMail(user.email, `⚠️ Your app "${appName}" was stopped — low balance`, wrap(`
        <h2>App Stopped</h2>
        <p>Hi there,</p>
        <p>Your app <strong>${appName}</strong> was automatically stopped because your account balance ran out.</p>
        ${appUrl ? `<p>It was running at: <a href="${appUrl}" style="color:#7c3aed">${appUrl}</a></p>` : ''}
        <p>Your data is safe, but the app is no longer serving traffic. <strong>Top up your balance</strong> and restart it from the dashboard.</p>
        <span class="pill red">App Stopped</span>
        <a href="${frontendUrl || 'https://wrexer.com'}/billing" class="btn">Add Balance →</a>
    `));
}

// 2. Low balance warning (< 1hr reserve left while app running)
export async function emailLowBalanceWarning(userId, appName, balanceRupees) {
    const user = await getUserEmail(userId);
    if (!user) return;
    await sendMail(user.email, `🔋 Low balance — ${appName} may stop soon`, wrap(`
        <h2>Low Balance Warning</h2>
        <p>Hi there,</p>
        <p>Your balance is getting low (₹${balanceRupees.toFixed(2)} remaining). Your app <strong>${appName}</strong> may be stopped soon if you don't top up.</p>
        <span class="pill amber">₹${balanceRupees.toFixed(2)} left</span>
        <a href="${frontendUrl || 'https://wrexer.com'}/billing" class="btn">Top Up Now →</a>
    `));
}

// 3. Low balance runway warning — balance < 5 days of total burn
export async function emailLowRunwayWarning(userId, runwayDays, dailyCostRupees, serviceNames) {
    const user = await getUserEmail(userId);
    if (!user) return;
    const daysStr = runwayDays < 1 ? 'less than 1 day' : `~${Math.floor(runwayDays)} day${Math.floor(runwayDays) === 1 ? '' : 's'}`;
    const serviceList = serviceNames && serviceNames.length
        ? `<ul style="margin:8px 0;padding-left:20px;color:#94a3b8;font-size:14px">${serviceNames.map(n => `<li>${n}</li>`).join('')}</ul>`
        : '';
    await sendMail(user.email, `⚠️ Low balance — your services may stop in ${daysStr}`, wrap(`
        <h2>Low Balance Warning</h2>
        <p>Hi there,</p>
        <p>Based on your current usage, your account balance will run out in approximately <strong>${daysStr}</strong>.</p>
        <p>Your daily infrastructure cost is <strong>₹${dailyCostRupees.toFixed(2)}/day</strong> across your active services:</p>
        ${serviceList}
        <p>Once your balance runs out, running apps will be stopped and databases will enter a <strong>3-day grace period</strong> before permanent deletion.</p>
        <span class="pill amber">~${daysStr} of runway left</span>
        <a href="${frontendUrl || 'https://wrexer.com'}/billing" class="btn">Top Up Now →</a>
    `));
}

// 4. Database stopped — grace period started
export async function emailDatabaseGraceStarted(userId, dbName, deleteDate) {
    const user = await getUserEmail(userId);
    if (!user) return;
    const deleteDateStr = new Date(deleteDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    await sendMail(user.email, `⚠️ Database "${dbName}" stopped — top up within 3 days to keep your data`, wrap(`
        <h2>Database Grace Period Started</h2>
        <p>Hi there,</p>
        <p>Your database <strong>${dbName}</strong> was stopped due to insufficient balance. <strong>Your data is safe for now.</strong></p>
        <p>If you top up before <strong>${deleteDateStr}</strong>, your database will be resumed automatically and all accrued charges will be settled from your new balance.</p>
        <p>If you do not top up by this date, the database (including all data) will be permanently deleted.</p>
        <span class="pill amber">Data safe until ${deleteDateStr}</span>
        <a href="${frontendUrl || 'https://wrexer.com'}/billing" class="btn">Top Up to Keep Data →</a>
    `));
}

// 4. Database destroyed after grace period
export async function emailDatabaseDestroyed(userId, dbName) {
    const user = await getUserEmail(userId);
    if (!user) return;
    await sendMail(user.email, `🗑️ Database "${dbName}" has been deleted`, wrap(`
        <h2>Database Deleted</h2>
        <p>Hi there,</p>
        <p>Your database <strong>${dbName}</strong> and all its data have been permanently deleted because the 3-day grace period expired without a top-up.</p>
        <p>You can create a new database from the dashboard at any time.</p>
        <span class="pill red">Data Permanently Deleted</span>
        <a href="${frontendUrl || 'https://wrexer.com'}/databases" class="btn">Create New Database →</a>
    `));
}

// 5. Database resumed after topup during grace period
export async function emailDatabaseResumed(userId, dbName, chargedRupees) {
    const user = await getUserEmail(userId);
    if (!user) return;
    await sendMail(user.email, `✅ Database "${dbName}" resumed — ₹${chargedRupees.toFixed(2)} charged for grace period`, wrap(`
        <h2>Database Resumed</h2>
        <p>Hi there,</p>
        <p>Your database <strong>${dbName}</strong> has been resumed. We charged <strong>₹${chargedRupees.toFixed(2)}</strong> for the storage used during the grace period.</p>
        <span class="pill green">Database Running</span>
        <a href="${frontendUrl || 'https://wrexer.com'}/databases" class="btn">View Dashboard →</a>
    `));
}

// 6. Reserved alias expiring soon (5 days warning)
export async function emailAliasExpiringSoon(userId, slug, daysLeft, expiresAt) {
    const user = await getUserEmail(userId);
    if (!user) return;
    const expStr = new Date(expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long' });
    await sendMail(user.email, `🔗 Your alias "${slug}.wrexer.com" expires in ${daysLeft} days`, wrap(`
        <h2>Reserved Alias Expiring Soon</h2>
        <p>Hi there,</p>
        <p>Your reserved alias <a href="https://${slug}.wrexer.com" style="color:#7c3aed">${slug}.wrexer.com</a> will expire on <strong>${expStr}</strong> (${daysLeft} days from now).</p>
        <p>Make sure you have at least <strong>₹29</strong> in your balance for the auto-renewal. If the payment fails, the alias will be released and anyone can claim it.</p>
        <span class="pill violet">${slug}.wrexer.com · renews ${expStr}</span>
        <a href="${frontendUrl || 'https://wrexer.com'}/billing" class="btn">Check Balance →</a>
    `));
}

// 7. Reserved alias expired
export async function emailAliasExpired(userId, slug) {
    const user = await getUserEmail(userId);
    if (!user) return;
    await sendMail(user.email, `❌ Your alias "${slug}.wrexer.com" has expired`, wrap(`
        <h2>Reserved Alias Expired</h2>
        <p>Hi there,</p>
        <p>Your reserved alias <strong>${slug}.wrexer.com</strong> has expired because your balance was insufficient at renewal time.</p>
        <p>The alias is now available for anyone to claim. If you'd like it back, you can try to re-reserve it from the Aliases page.</p>
        <span class="pill red">${slug}.wrexer.com · Released</span>
        <a href="${frontendUrl || 'https://wrexer.com'}/aliases" class="btn">Go to Aliases →</a>
    `));
}

// 8. Payment / topup confirmed
export async function emailTopupConfirmed(userId, amountRupees) {
    const user = await getUserEmail(userId);
    if (!user) return;
    await sendMail(user.email, `✅ ₹${amountRupees} added to your Wrexer balance`, wrap(`
        <h2>Payment Confirmed</h2>
        <p>Hi there,</p>
        <p>Your payment of <strong>₹${amountRupees}</strong> has been confirmed and added to your account balance.</p>
        <span class="pill green">+₹${amountRupees} added</span>
        <a href="${frontendUrl || 'https://wrexer.com'}/dashboard" class="btn">Go to Dashboard →</a>
    `));
}

// 9. New app deployed
export async function emailAppDeployed(userId, appName, appUrl) {
    const user = await getUserEmail(userId);
    if (!user) return;
    await sendMail(user.email, `🚀 "${appName}" is live on Wrexer`, wrap(`
        <h2>App Deployed!</h2>
        <p>Hi there,</p>
        <p>Your app <strong>${appName}</strong> is live and serving traffic.</p>
        ${appUrl ? `<a href="${appUrl}" class="btn">Open App →</a>` : ''}
    `));
}
