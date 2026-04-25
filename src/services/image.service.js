import { execSync } from 'child_process';
import logger from '../utils/logger.js';

class ImageService {
    async getExposedPort(imageName, username, token) {
        imageName = imageName?.trim();
        try {
            logger.info(`Inspecting image metadata: ${imageName}`);

            const fullImageName = imageName.includes('/') ?
                (imageName.includes('.') ? imageName : `docker.io/${imageName}`) :
                `docker.io/library/${imageName}`;

            let inspectOutput;
            try {
                const credsFlag = (username && token) ? `--creds "${username}:${token}"` : '';
                // Use a larger timeout and absolute path if possible, though 'skopeo' in PATH is usually fine
                inspectOutput = execSync(`skopeo inspect ${credsFlag} --config docker://${fullImageName}`, { 
                    stdio: 'pipe',
                    timeout: 15000 
                }).toString();
            } catch (e) {
                logger.warn(`Skopeo check failed for ${imageName}: ${e.message}. Attempting without credentials...`);
                try {
                    // Try without credentials as a fallback (for public images on private registries)
                    inspectOutput = execSync(`skopeo inspect --config docker://${fullImageName}`, { 
                        stdio: 'pipe',
                        timeout: 15000 
                    }).toString();
                } catch (fallbackErr) {
                    logger.warn(`Public skopeo check also failed: ${fallbackErr.message}. Falling back to default port 80.`);
                    return { port: 80, loopbackBind: false };
                }
            }

            const data = JSON.parse(inspectOutput);
            
            // Search for ExposedPorts in multiple possible locations
            // 1. .config.ExposedPorts (Standard OCI/Docker)
            // 2. .Config.ExposedPorts (Docker alternate)
            // 3. .container_config.ExposedPorts
            // 4. .info.imageSpec.config.ExposedPorts (crictl style)
            const config = data.config || data.Config || data.container_config || data.info?.imageSpec?.config || data.info?.config || data;
            const exposedPorts = config?.ExposedPorts || data.ExposedPorts || {};

            const ports = Object.keys(exposedPorts);
            if (ports.length > 0) {
                // Key format can be "3000/tcp" or "127.0.0.1:3000/tcp" (loopback-bound)
                const firstPortKey = ports[0];
                const portPart = firstPortKey.split('/')[0]; // e.g. "3000" or "127.0.0.1:3000"
                const loopbackBind = portPart.startsWith('127.0.0.1:') || portPart.startsWith('::1:');
                const port = parseInt(portPart.split(':').pop(), 10);
                logger.info(`Detected exposed port for ${imageName}: ${port} (loopbackBind=${loopbackBind})`);
                return { port, loopbackBind };
            }

            logger.warn(`No exposed ports found in metadata for ${imageName}, defaulting to 80`);
            return { port: 80, loopbackBind: false };
        } catch (err) {
            logger.error(`Critical error in port detection for ${imageName}: ${err.message}`);
            return { port: 80, loopbackBind: false };
        }
    }

    /**
     * Option A: Pre-flight image visibility check.
     * Returns true if the image can be pulled WITHOUT any credentials (i.e., it's public).
     * Falls back to false on any error, which means private images still work correctly.
     */
    async isPublicImage(imageName) {
        imageName = imageName?.trim();
        const fullImageName = imageName.includes('/')
            ? (imageName.includes('.') ? imageName : `docker.io/${imageName}`)
            : `docker.io/library/${imageName}`;

        try {
            execSync('skopeo --version', { stdio: 'ignore' });
            // --no-creds tells skopeo to NOT use any auth — simulates anonymous pull
            execSync(`skopeo inspect --no-creds docker://${fullImageName}`, {
                stdio: 'pipe',
                timeout: 10000, // 10s timeout to avoid hanging deploys
            });
            logger.info(`Image is public (no-creds check passed): ${fullImageName}`);
            return true;
        } catch (err) {
            // Could be: auth required (private), image not found, or skopeo not available
            logger.info(`Image is not public or check failed for ${fullImageName}: ${err.message?.slice(0, 80)}`);
            return false;
        }
    }
}

export default new ImageService();
