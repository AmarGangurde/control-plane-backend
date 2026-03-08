import { nanoid } from 'nanoid';
import db from '../db/db.js';

/**
 * Creates a new contact message from the public contact form.
 */
export const createContact = async ({ name, email, subject, message, ip, userAgent }) => {
    const id = 'cont_' + nanoid(10);
    const query = `
    INSERT INTO contact_messages (id, name, email, subject, message, ip_address, user_agent)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `;
    const result = await db.query(query, [id, name, email, subject, message, ip, userAgent]);
    return result.rows[0];
};

/**
 * Creates a new support ticket and its first message as a transaction.
 */
export const createTicket = async (userId, subject, message) => {
    const ticketId = 'tic_' + nanoid(10);
    const msgId = 'tmsg_' + nanoid(10);

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const ticketQuery = `
      INSERT INTO tickets (id, user_id, subject)
      VALUES ($1, $2, $3)
      RETURNING *
    `;
        const ticketResult = await client.query(ticketQuery, [ticketId, userId, subject]);

        const messageQuery = `
      INSERT INTO ticket_messages (id, ticket_id, sender_type, sender_id, message)
      VALUES ($1, $2, $3, $4, $5)
    `;
        await client.query(messageQuery, [msgId, ticketId, 'user', userId, message]);

        await client.query('COMMIT');
        return ticketResult.rows[0];
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
};

/**
 * Adds a message to an existing ticket.
 */
export const addTicketMessage = async (ticketId, senderType, senderId, message) => {
    const id = 'tmsg_' + nanoid(10);
    const query = `
    INSERT INTO ticket_messages (id, ticket_id, sender_type, sender_id, message)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `;
    const result = await db.query(query, [id, ticketId, senderType, senderId, message]);

    // Update ticket updated_at
    await db.query('UPDATE tickets SET updated_at = NOW() WHERE id = $1', [ticketId]);

    return result.rows[0];
};

/**
 * Fetches all tickets for a specific user.
 */
export const getUserTickets = async (userId) => {
    const query = `
    SELECT * FROM tickets 
    WHERE user_id = $1 
    ORDER BY updated_at DESC
  `;
    const result = await db.query(query, [userId]);
    return result.rows;
};

/**
 * Fetches all messages for a specific ticket.
 */
export const getTicketMessages = async (ticketId) => {
    const query = `
    SELECT * FROM ticket_messages 
    WHERE ticket_id = $1 
    ORDER BY created_at ASC
  `;
    const result = await db.query(query, [ticketId]);
    return result.rows;
};

/**
 * Admin: List all contact messages.
 */
export const adminListContacts = async () => {
    const query = `SELECT * FROM contact_messages ORDER BY created_at DESC`;
    const result = await db.query(query);
    return result.rows;
};

/**
 * Admin: Update contact message status.
 */
export const adminUpdateContactStatus = async (contactId, status) => {
    const query = `
    UPDATE contact_messages 
    SET status = $1, resolved_at = CASE WHEN $1 = 'resolved' THEN NOW() ELSE resolved_at END
    WHERE id = $2 
    RETURNING *
  `;
    const result = await db.query(query, [status, contactId]);
    return result.rows[0];
};

/**
 * Admin: List all support tickets with user email.
 */
export const adminListTickets = async () => {
    const query = `
    SELECT t.*, u.email as user_email 
    FROM tickets t
    JOIN users u ON t.user_id = u.id
    ORDER BY t.updated_at DESC
  `;
    const result = await db.query(query);
    return result.rows;
};

/**
 * Admin: Get a single ticket metadata.
 */
export const adminGetTicket = async (ticketId) => {
    const query = `
    SELECT t.*, u.email as user_email 
    FROM tickets t
    JOIN users u ON t.user_id = u.id
    WHERE t.id = $1
  `;
    const result = await db.query(query, [ticketId]);
    return result.rows[0];
};

/**
 * Admin: Reply to a ticket.
 */
export const adminReplyTicket = async (ticketId, message) => {
    return await addTicketMessage(ticketId, 'admin', 'admin', message);
};
