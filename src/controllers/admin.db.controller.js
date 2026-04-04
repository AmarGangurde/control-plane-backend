import { spawn } from 'child_process';
import { URL } from 'url';
import logger from '../utils/logger.js';

/**
 * Admin-only: Stream a pg_dump of the Wrexer infra database to the client.
 * Uses the DATABASE_URL env var from the backend environment.
 * Protected by requireAdminKey — no tenant auth needed.
 */
export const adminDownloadInfraBackup = async (req, res) => {
    const dbUrl = process.env.DATABASE_URL;

    if (!dbUrl) {
        return res.status(500).json({ error: 'DATABASE_URL is not configured on the backend' });
    }

    const filename = `wrexer_infra_backup_${new Date().toISOString().split('T')[0]}.sql`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/sql');

    const dumpArgs = [
        `--dbname=${dbUrl}`,
        '--no-owner',
        '--no-privileges',
        '--clean',
        '--if-exists',
    ];

    const pgDumpProcess = spawn('pg_dump', dumpArgs);

    // Pipe stdout directly to the HTTP response
    pgDumpProcess.stdout.pipe(res);

    let errorLog = '';
    pgDumpProcess.stderr.on('data', (data) => {
        errorLog += data.toString();
    });

    pgDumpProcess.on('close', (code) => {
        if (code !== 0) {
            logger.error('Infra pg_dump process failed', { code, errorLog });
            if (!res.headersSent) {
                res.status(500).json({ error: 'Backup process failed' });
            } else {
                logger.warn('Infra backup failed after streaming started');
                res.end();
            }
        } else {
            logger.info('Infra DB backup completed successfully');
        }
    });

    pgDumpProcess.on('error', (err) => {
        logger.error('Failed to start infra pg_dump process', { error: err.message });
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to start backup process. Is pg_dump installed?' });
        }
    });
};

/**
 * Admin-only: Accept an uploaded .sql file and restore it into the Wrexer infra database
 * using psql, replacing all existing data.
 * Protected by requireAdminKey.
 */
export const adminRestoreInfraDb = async (req, res) => {
    const dbUrl = process.env.DATABASE_URL;

    if (!dbUrl) {
        return res.status(500).json({ error: 'DATABASE_URL is not configured on the backend' });
    }

    logger.info('Infra DB restore started');

    const psqlProcess = spawn('psql', [`--dbname=${dbUrl}`, '--quiet']);

    let errorLog = '';
    psqlProcess.stderr.on('data', (data) => {
        errorLog += data.toString();
    });

    // Pipe the raw request body (the uploaded SQL file) into psql stdin
    req.pipe(psqlProcess.stdin);

    req.on('error', (err) => {
        logger.error('Restore: request stream error', { error: err.message });
        psqlProcess.stdin.destroy();
        if (!res.headersSent) {
            res.status(500).json({ error: 'Upload stream error: ' + err.message });
        }
    });

    psqlProcess.on('close', (code) => {
        if (code !== 0) {
            logger.error('Infra psql restore failed', { code, errorLog });
            return res.status(500).json({ error: 'Restore failed: ' + errorLog });
        }
        logger.info('Infra DB restore completed successfully');
        res.json({ success: true, message: 'Database restored successfully.' });
    });

    psqlProcess.on('error', (err) => {
        logger.error('Failed to start psql restore process', { error: err.message });
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to start restore process. Is psql installed?' });
        }
    });
};
