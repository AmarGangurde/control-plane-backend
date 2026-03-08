import * as supportService from '../services/support.service.js';
import logger from '../utils/logger.js';

/**
 * Public Contact API
 */
export const handleCreateContact = async (req, res) => {
    const { name, email, subject, message } = req.body;

    if (!name || !email || !message) {
        return res.status(400).json({ error: 'Name, email, and message are required' });
    }

    try {
        const contact = await supportService.createContact({
            name,
            email,
            subject: subject || 'No Subject',
            message,
            ip: req.ip,
            userAgent: req.get('User-Agent'),
        });
        res.status(201).json(contact);
    } catch (err) {
        logger.error('Failed to create contact message', err);
        res.status(500).json({ error: 'Failed to send message' });
    }
};

/**
 * User Tickets API
 */
export const handleCreateTicket = async (req, res) => {
    const { subject, message } = req.body;
    const userId = req.user.id;

    if (!subject || !message) {
        return res.status(400).json({ error: 'Subject and message are required' });
    }

    try {
        const ticket = await supportService.createTicket(userId, subject, message);
        res.status(201).json(ticket);
    } catch (err) {
        logger.error('Failed to create ticket', err);
        res.status(500).json({ error: 'Failed to create ticket' });
    }
};

export const handleGetTickets = async (req, res) => {
    try {
        const tickets = await supportService.getUserTickets(req.user.id);
        res.json(tickets);
    } catch (err) {
        logger.error('Failed to fetch user tickets', err);
        res.status(500).json({ error: 'Failed to fetch tickets' });
    }
};

export const handleGetTicketMessages = async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    try {
        // Basic ownership check
        const ticket = await supportService.getUserTickets(userId);
        if (!ticket.some(t => t.id === id)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const messages = await supportService.getTicketMessages(id);
        res.json(messages);
    } catch (err) {
        logger.error('Failed to fetch ticket messages', err);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
};

export const handleReplyTicket = async (req, res) => {
    const { id } = req.params;
    const { message } = req.body;
    const userId = req.user.id;

    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

    try {
        // Basic ownership check
        const tickets = await supportService.getUserTickets(userId);
        if (!tickets.some(t => t.id === id)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const newMessage = await supportService.addTicketMessage(id, 'user', userId, message);
        res.status(201).json(newMessage);
    } catch (err) {
        logger.error('Failed to reply to ticket', err);
        res.status(500).json({ error: 'Failed to send reply' });
    }
};

/**
 * Admin Support API
 */
export const handleAdminListContacts = async (req, res) => {
    try {
        const contacts = await supportService.adminListContacts();
        res.json(contacts);
    } catch (err) {
        res.status(500).json({ error: 'Internal error' });
    }
};

export const handleAdminUpdateContactStatus = async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
        const updated = await supportService.adminUpdateContactStatus(id, status);
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: 'Internal error' });
    }
};

export const handleAdminListTickets = async (req, res) => {
    try {
        const tickets = await supportService.adminListTickets();
        res.json(tickets);
    } catch (err) {
        res.status(500).json({ error: 'Internal error' });
    }
};

export const handleAdminGetTicket = async (req, res) => {
    const { id } = req.params;
    try {
        const ticket = await supportService.adminGetTicket(id);
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
        const messages = await supportService.getTicketMessages(id);
        res.json({ ticket, messages });
    } catch (err) {
        res.status(500).json({ error: 'Internal error' });
    }
};

export const handleAdminReplyTicket = async (req, res) => {
    const { id } = req.params;
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    try {
        const newMessage = await supportService.adminReplyTicket(id, message);
        res.status(201).json(newMessage);
    } catch (err) {
        res.status(500).json({ error: 'Internal error' });
    }
};
