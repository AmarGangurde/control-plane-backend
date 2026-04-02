import { spawn } from 'child_process';
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
