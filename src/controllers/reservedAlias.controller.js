import { v4 as uuidv4 } from 'uuid';
import db from '../db/db.js';
import k8sService from '../services/k8s.service.js';
import { baseDomain } from '../config/env.js';
import logger from '../utils/logger.js';
import * as emailService from '../services/email.service.js';

// ── Constants ──────────────────────────────────────────────────────────────────
export const RESERVED_ALIAS_PRICE = 2900; // ₹29.00 in paise
const MONTH_SECONDS = 30 * 24 * 3600;

const ALIAS_BLOCKLIST = new Set([
    'www', 'api', 'admin', 'mail', 'dashboard', 'billing', 'app',
    'wrexer', 'support', 'dev', 'staging', 'ns', 'ftp', 'smtp',
    'cdn', 'static', 'assets', 'auth', 'login', 'signup', 'register',
]);
const ALIAS_REGEX = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

// ── List user's reserved aliases ──────────────────────────────────────────────
export const listReservedAliases = async (req, res) => {
    const { rows } = await db.query(
        `SELECT ra.*, a.name as app_name, a.url as app_url, a.status as app_status
     FROM reserved_aliases ra
     LEFT JOIN apps a ON a.id = ra.assigned_app_id
     WHERE ra.user_id = $1
     ORDER BY ra.reserved_at DESC`,
        [req.user.id]
    );
    return res.json(rows);
};

// ── Reserve a new alias ────────────────────────────────────────────────────────
export const reserveAlias = async (req, res) => {
    const { slug } = req.body;
    if (!slug) return res.status(400).json({ error: 'slug is required' });

    const cleanSlug = slug.toLowerCase().trim();

    if (!ALIAS_REGEX.test(cleanSlug)) {
        return res.status(400).json({ error: 'Invalid slug. Use 3–30 lowercase letters, numbers, and hyphens.' });
    }
    if (ALIAS_BLOCKLIST.has(cleanSlug)) {
        return res.status(400).json({ error: `"${cleanSlug}" is a reserved system name.` });
    }

    // Check if slug is already reserved (by anyone)
    const { rows: existing } = await db.query(
        'SELECT id FROM reserved_aliases WHERE slug = $1 AND status = $2',
        [cleanSlug, 'active']
    );
    if (existing.length > 0) {
        return res.status(409).json({ error: `"${cleanSlug}" is already reserved. Choose a different name.` });
    }

    // Check if slug is in use as a free alias by another user's app
    const { rows: freeAlias } = await db.query(
        'SELECT id FROM apps WHERE alias = $1 AND user_id != $2',
        [cleanSlug, req.user.id]
    );
    if (freeAlias.length > 0) {
        return res.status(409).json({ error: `"${cleanSlug}" is currently in use. Try a different name.` });
    }

    // Deduct 1 month upfront from user balance
    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const { rows: uRows } = await client.query('SELECT balance FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
        const user = uRows[0];
        if (!user || user.balance < RESERVED_ALIAS_PRICE) {
            await client.query('ROLLBACK');
            return res.status(402).json({
                error: `Insufficient balance. Reserving an alias costs ₹${(RESERVED_ALIAS_PRICE / 100).toFixed(0)}/month.`
            });
        }

        await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [RESERVED_ALIAS_PRICE, req.user.id]);

        // Log deduction
        await client.query(
            `INSERT INTO transactions (id, user_id, amount, type, status, external_id, metadata)
       VALUES ($1, $2, $3, 'alias_reserve', 'success', $4, $5)`,
            [uuidv4(), req.user.id, -RESERVED_ALIAS_PRICE, cleanSlug, JSON.stringify({ slug: cleanSlug })]
        );

        const expiresAt = new Date(Date.now() + MONTH_SECONDS * 1000);
        const aliasId = uuidv4();

        await client.query(
            `INSERT INTO reserved_aliases (id, user_id, slug, status, price_per_month, expires_at, last_billed_at)
       VALUES ($1, $2, $3, 'active', $4, $5, NOW())`,
            [aliasId, req.user.id, cleanSlug, RESERVED_ALIAS_PRICE, expiresAt]
        );

        await client.query('COMMIT');
        const { rows } = await db.query('SELECT * FROM reserved_aliases WHERE id = $1', [aliasId]);
        return res.status(201).json(rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(409).json({ error: `"${cleanSlug}" was just reserved by someone else.` });
        }
        logger.error('reserveAlias error', err);
        return res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// ── Assign reserved alias to an app ───────────────────────────────────────────
export const assignAlias = async (req, res) => {
    const { id } = req.params;       // reserved alias ID
    const { appId } = req.body;      // target app ID (or null to unassign)

    const { rows: raRows } = await db.query(
        'SELECT * FROM reserved_aliases WHERE id = $1 AND user_id = $2',
        [id, req.user.id]
    );
    const ra = raRows[0];
    if (!ra) return res.status(404).json({ error: 'Reserved alias not found' });
    if (ra.status !== 'active') return res.status(400).json({ error: 'This alias has expired.' });

    // Unassign flow (appId = null)
    if (!appId) {
        // Remove Ingress rule from currently assigned app if any
        if (ra.assigned_app_id) {
            await _removeAliasFromIngress(ra.assigned_app_id, ra.slug);
            // Clear apps.alias so AppList no longer shows it
            await db.query('UPDATE apps SET alias = NULL WHERE id = $1 AND alias = $2', [ra.assigned_app_id, ra.slug]);
        }
        await db.query('UPDATE reserved_aliases SET assigned_app_id = NULL WHERE id = $1', [id]);
        return res.json({ success: true, assigned: false });
    }

    // Assign flow
    const { rows: appRows } = await db.query('SELECT * FROM apps WHERE id = $1 AND user_id = $2', [appId, req.user.id]);
    const app = appRows[0];
    if (!app) return res.status(404).json({ error: 'App not found' });
    if (app.type !== 'app') return res.status(400).json({ error: 'Can only assign alias to apps, not databases.' });

    // If the target app already has a free alias set, clear it first (1 alias per pod rule)
    if (app.alias && app.alias !== ra.slug) {
        await _removeAliasFromIngress(app.id, app.alias);
        await db.query('UPDATE apps SET alias = NULL WHERE id = $1', [app.id]);
    }

    // Un-assign from previous app first
    if (ra.assigned_app_id && ra.assigned_app_id !== appId) {
        await _removeAliasFromIngress(ra.assigned_app_id, ra.slug);
        // Clear apps.alias on the previous app
        await db.query('UPDATE apps SET alias = NULL WHERE id = $1 AND alias = $2', [ra.assigned_app_id, ra.slug]);
    }

    // Patch Ingress on target app
    const shortId = app.id.split('-')[0];
    const resourceName = `app-${shortId}`;
    const aliasHost = `${ra.slug}.${baseDomain}`;
    const originalHost = app.url.replace(/^https?:\/\//, '');

    try {
        await k8sService.updateIngressHosts(resourceName, app.namespace, [originalHost, aliasHost]);
    } catch (k8sErr) {
        logger.error('Failed to assign reserved alias to ingress', k8sErr);
        return res.status(500).json({ error: 'Failed to update routing. Try again.' });
    }

    await db.query('UPDATE reserved_aliases SET assigned_app_id = $1 WHERE id = $2', [appId, id]);
    // Sync to apps.alias so AppList and edit modal reflect it immediately
    await db.query('UPDATE apps SET alias = $1 WHERE id = $2', [ra.slug, appId]);
    const protocol = baseDomain === 'localhost' ? 'http' : 'https';
    return res.json({ success: true, assigned: true, aliasUrl: `${protocol}://${aliasHost}` });
};

// ── Release (cancel) a reserved alias ─────────────────────────────────────────
export const releaseAlias = async (req, res) => {
    const { id } = req.params;

    const { rows } = await db.query(
        'SELECT * FROM reserved_aliases WHERE id = $1 AND user_id = $2',
        [id, req.user.id]
    );
    const ra = rows[0];
    if (!ra) return res.status(404).json({ error: 'Reserved alias not found' });

    // Remove from any assigned app's Ingress and clear apps.alias
    if (ra.assigned_app_id) {
        await _removeAliasFromIngress(ra.assigned_app_id, ra.slug);
        await db.query('UPDATE apps SET alias = NULL WHERE id = $1 AND alias = $2', [ra.assigned_app_id, ra.slug]);
    }

    await db.query('DELETE FROM reserved_aliases WHERE id = $1', [id]);

    // No refund (same as cancelling mid-month — by design)
    return res.json({ success: true });
};

// ── Monthly billing loop for reserved aliases ─────────────────────────────────
export const runReservedAliasBillingLoop = async () => {
    const lockClient = await db.getClient();
    let lockAcquired = false;
    try {
        const { rows } = await lockClient.query('SELECT pg_try_advisory_lock(1003) as locked');
        lockAcquired = rows[0].locked;
        if (!lockAcquired) return;

        const now = new Date();

        // Find active aliases that are due for renewal (expires_at <= now)
        const { rows: due } = await lockClient.query(
            `SELECT * FROM reserved_aliases WHERE status = 'active' AND expires_at <= $1`,
            [now]
        );

        for (const ra of due) {
            const client = await db.getClient();
            try {
                await client.query('BEGIN');
                const { rows: uRows } = await client.query('SELECT balance FROM users WHERE id = $1 FOR UPDATE', [ra.user_id]);
                const user = uRows[0];

                if (!user || user.balance < ra.price_per_month) {
                    // Can't renew — expire the alias and remove from ingress
                    logger.warn(`Reserved alias ${ra.slug} expired for user ${ra.user_id} (insufficient balance)`);
                    await client.query(`UPDATE reserved_aliases SET status = 'expired' WHERE id = $1`, [ra.id]);
                    // Clear apps.alias so AppList reflects the loss
                    if (ra.assigned_app_id) {
                        await client.query(`UPDATE apps SET alias = NULL WHERE id = $1`, [ra.assigned_app_id]);
                    }
                    await client.query('COMMIT');
                    // Remove from Ingress (non-fatal)
                    if (ra.assigned_app_id) {
                        await _removeAliasFromIngress(ra.assigned_app_id, ra.slug).catch(() => { });
                    }
                    emailService.emailAliasExpired(ra.user_id, ra.slug).catch(() => { });
                    continue;
                }

                // Charge and extend expiry by 30 days
                await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [ra.price_per_month, ra.user_id]);

                const newExpiry = new Date(now.getTime() + MONTH_SECONDS * 1000);
                await client.query(
                    `UPDATE reserved_aliases SET expires_at = $1, last_billed_at = NOW() WHERE id = $2`,
                    [newExpiry, ra.id]
                );

                await client.query(
                    `INSERT INTO transactions (id, user_id, amount, type, status, external_id, metadata)
           VALUES ($1, $2, $3, 'alias_renewal', 'success', $4, $5)`,
                    [uuidv4(), ra.user_id, -ra.price_per_month, ra.slug, JSON.stringify({ slug: ra.slug })]
                );

                await client.query('COMMIT');
                logger.info(`Reserved alias ${ra.slug} renewed for user ${ra.user_id}`);
            } catch (err) {
                await client.query('ROLLBACK');
                logger.error(`Error renewing alias ${ra.id}:`, err.message);
            } finally {
                client.release();
            }
        }
    } catch (err) {
        logger.error('Reserved alias billing loop error:', err);
    } finally {
        if (lockAcquired) await lockClient.query('SELECT pg_advisory_unlock(1003)');
        lockClient.release();
    }

    // 5-day expiry warning — sent at most once per 23 hours per alias
    try {
        const in5 = new Date(Date.now() + 5 * 86400 * 1000);
        const { rows: expiring } = await db.query(
            `SELECT * FROM reserved_aliases
             WHERE status = 'active'
               AND expires_at <= $1
               AND expires_at > NOW()
               AND (last_warning_sent_at IS NULL OR last_warning_sent_at < NOW() - INTERVAL '23 hours')`,
            [in5]
        );
        for (const ra of expiring) {
            const daysLeft = Math.ceil((new Date(ra.expires_at) - Date.now()) / 86400000);
            emailService.emailAliasExpiringSoon(ra.user_id, ra.slug, daysLeft, ra.expires_at).catch(() => { });
            // Stamp sent time so we don't re-send until tomorrow
            db.query(
                `UPDATE reserved_aliases SET last_warning_sent_at = NOW() WHERE id = $1`,
                [ra.id]
            ).catch(() => { });
        }
    } catch (e) {
        logger.warn('Error sending alias expiry warnings:', e.message);
    }

};

export const startReservedAliasBillingCron = () => {
    logger.info('Starting reserved alias monthly billing cron (checks every hour)...');
    setInterval(() => {
        runReservedAliasBillingLoop().catch(err => logger.error('Reserved alias billing error:', err));
    }, 60 * 60 * 1000); // check every hour
};

// ── Private helper ─────────────────────────────────────────────────────────────
async function _removeAliasFromIngress(appId, slug) {
    try {
        const { rows } = await db.query('SELECT * FROM apps WHERE id = $1', [appId]);
        const app = rows[0];
        if (!app) return;
        const shortId = app.id.split('-')[0];
        const resourceName = `app-${shortId}`;
        const originalHost = app.url.replace(/^https?:\/\//, '');
        await k8sService.updateIngressHosts(resourceName, app.namespace, [originalHost]);
        logger.info(`Removed reserved alias ${slug} from app ${appId} ingress`);
    } catch (err) {
        logger.warn(`Could not remove alias from ingress for app ${appId}: ${err.message}`);
    }
}
