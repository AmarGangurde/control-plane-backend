import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { pubClient, subClient } from './redis.js';
import logger from '../utils/logger.js';
import { frontendUrl, baseDomain } from '../config/env.js';

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

        // Client joins a ticket room to receive live updates
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
