import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { pubClient, subClient } from './redis.js';
import logger from '../utils/logger.js';
import { frontendUrl, baseDomain } from '../config/env.js';
import k8sService from '../services/k8s.service.js';
import { getAppById } from '../models/app.model.js';

const JWT_SECRET = process.env.JWT_SECRET;

let io;

export function createSocketServer(httpServer) {
    const allowedOrigins = [
        frontendUrl,
        'http://localhost:5173',
        'http://localhost:3000',
        'http://localhost:3001',
        'https://wrexer.com',
        'https://www.wrexer.com',
        baseDomain ? `https://${baseDomain}` : null,
    ].filter(Boolean);

    io = new Server(httpServer, {
        path: '/socket.io',
        cors: {
            origin: allowedOrigins,
            methods: ['GET', 'POST'],
            credentials: true,
        },
        // Attach Redis adapter for cross-pod pub/sub
        adapter: createAdapter(pubClient, subClient),
    });

    // Auth middleware — handles users (JWT session cookie) and admins (admin-token cookie)
    io.use((socket, next) => {
        try {
            const cookies = socket.handshake.headers?.cookie || '';
            const parseCookie = (name) => cookies.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='))?.split('=')[1];

            // Case 1: Admin — raw ADMIN_API_KEY sent as auth.token (legacy/fallback)
            const rawToken = socket.handshake.auth?.token;
            const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
            if (rawToken && ADMIN_API_KEY && rawToken === ADMIN_API_KEY) {
                socket.userId = 'admin';
                socket.userEmail = 'admin';
                socket.isAdmin = true;
                return next();
            }

            // Case 2: Admin — admin-token cookie (set by Next.js login route, signed with ADMIN_API_KEY)
            const adminCookieToken = parseCookie('admin-token');
            if (adminCookieToken && ADMIN_API_KEY) {
                try {
                    const payload = jwt.verify(adminCookieToken, ADMIN_API_KEY);
                    if (payload.role === 'admin') {
                        socket.userId = 'admin';
                        socket.userEmail = 'admin';
                        socket.isAdmin = true;
                        return next();
                    }
                } catch (_) { /* not a valid admin token, fall through */ }
            }

            // Case 3: User — session JWT cookie (set by backend auth, signed with JWT_SECRET)
            const sessionToken = parseCookie('session');
            if (sessionToken) {
                const payload = jwt.verify(sessionToken, JWT_SECRET);
                socket.userId = payload.sub;
                socket.userEmail = payload.email;
                socket.isAdmin = false;
                return next();
            }

            return next(new Error('Unauthorized'));
        } catch (err) {
            next(new Error('Unauthorized'));
        }
    });

    io.on('connection', (socket) => {
        logger.info(`[Socket.io] Connected: ${socket.userEmail} (admin: ${socket.isAdmin})`);

        // ── Shell sessions ────────────────────────────────────────────────────
        // Map of appId → { write, resize, stop } for this socket's active shells
        const shellSessions = new Map();

        /**
         * shell:start — open a PTY exec session into the app's container.
         * Payload: { appId, container? }
         */
        socket.on('shell:start', async ({ appId, container = 'app' } = {}) => {
            try {
                // Ownership check — user can only shell into their own apps
                const app = await getAppById(appId);
                if (!app || (!socket.isAdmin && app.user_id !== socket.userId)) {
                    socket.emit('shell:error', { appId, message: 'App not found or access denied.' });
                    return;
                }

                // Close any existing session for this app
                if (shellSessions.has(appId)) {
                    shellSessions.get(appId).stop();
                    shellSessions.delete(appId);
                }

                const shortId = app.id.split('-')[0];
                const resourceName = app.type === 'database' ? `db-${shortId}` : `app-${shortId}`;

                const session = await k8sService.openShell(
                    resourceName,
                    app.namespace,
                    container,
                    (chunk) => socket.emit('shell:output', { appId, data: chunk.toString('binary') }),
                    () => {
                        socket.emit('shell:exit', { appId });
                        shellSessions.delete(appId);
                    }
                );

                shellSessions.set(appId, session);
                socket.emit('shell:ready', { appId });
                logger.info(`[Shell] Opened for ${socket.userEmail} → ${resourceName}/${container}`);
            } catch (err) {
                logger.error('[Shell] Failed to open', err.message);
                socket.emit('shell:error', { appId, message: err.message });
            }
        });

        /** shell:input — write data to the PTY stdin */
        socket.on('shell:input', ({ appId, data } = {}) => {
            shellSessions.get(appId)?.write(data);
        });

        /** shell:resize — resize the PTY */
        socket.on('shell:resize', ({ appId, cols, rows } = {}) => {
            shellSessions.get(appId)?.resize(cols, rows);
        });

        /** shell:stop — close a specific shell session */
        socket.on('shell:stop', ({ appId } = {}) => {
            if (shellSessions.has(appId)) {
                shellSessions.get(appId).stop();
                shellSessions.delete(appId);
            }
        });

        // ── Ticket rooms ──────────────────────────────────────────────────────
        socket.on('join_ticket', (ticketId) => {
            if (!ticketId) return;
            socket.join(`ticket:${ticketId}`);
            logger.info(`[Socket.io] ${socket.userEmail} joined ticket:${ticketId}`);
        });

        socket.on('leave_ticket', (ticketId) => {
            if (!ticketId) return;
            socket.leave(`ticket:${ticketId}`);
        });

        socket.on('disconnect', () => {
            // Clean up all open shell sessions for this socket
            for (const [, session] of shellSessions) {
                try { session.stop(); } catch (_) {}
            }
            shellSessions.clear();
            logger.info(`[Socket.io] Disconnected: ${socket.userEmail}`);
        });
    });

    logger.info('[Socket.io] Server initialized with Redis adapter');
    return io;
}

// Emit a new message to all sockets in the ticket room
export function emitNewMessage(ticketId, message) {
    if (!io) return;
    io.to(`ticket:${ticketId}`).emit('new_message', message);
}

// Emit a status change (open/closed) to all sockets in the ticket room
export function emitTicketStatus(ticketId, status) {
    if (!io) return;
    io.to(`ticket:${ticketId}`).emit('ticket_status', { ticketId, status });
}

export { io };
