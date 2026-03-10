import { execSync } from 'child_process';
import logger from '../utils/logger.js';

class ImageService {
    async getExposedPort(imageName, username, token) {
        imageName = imageName?.trim();
        try {
            logger.info(`Inspecting image metadata via skopeo: ${imageName}`);

            // Ensure we have the full image name for skopeo (default to docker.io if no registry provided)
            const fullImageName = imageName.includes('/') ?
                (imageName.includes('.') ? imageName : `docker.io/${imageName}`) :
                `docker.io/library/${imageName}`;

            let inspectOutput;
            try {
                // Check if skopeo is available
                try {
                    execSync('skopeo --version', { stdio: 'ignore' });
                } catch (e) {
                    throw new Error('skopeo not found in PATH');
                }

                // Add credentials if provided
                const credsFlag = (username && token) ? `--creds "${username}:${token}"` : '';

                // use --config to get the actual image configuration including ExposedPorts
                inspectOutput = execSync(`skopeo inspect ${credsFlag} --config docker://${fullImageName}`, { stdio: 'pipe' }).toString();
            } catch (e) {
                logger.warn(`Skopeo check failed: ${e.message}.`);

                // If it's a "skopeo not found" error, we probably shouldn't try sudo crictl 
                // because it will definitely ask for a password and hang the backend.
                if (e.message.includes('not found')) {
                    logger.error('Skopeo is not installed. Port detection will default to 80 to avoid sudo password prompts.');
                    return 80;
                }

                logger.warn(`Falling back to crictl pull/inspect for ${fullImageName}`);
                try {
                    // Try without sudo first? crictl usually needs sudo on k3s
                    inspectOutput = execSync(`sudo -n crictl inspecti ${imageName}`, { stdio: 'pipe' }).toString();
                } catch (innerE) {
                    logger.error(`Crictl fallback failed (likely needs sudo password): ${innerE.message}`);
                    return 80; // Final fallback
                }
            }

            const data = JSON.parse(inspectOutput);

            // --config output often has it directly in .config.ExposedPorts
            // while crictl has it in .info.imageSpec.config.ExposedPorts
            const config = data.config || data.info?.imageSpec?.config || data.info?.config;
            const exposedPorts = config?.ExposedPorts || {};

            const ports = Object.keys(exposedPorts);
            if (ports.length > 0) {
                // Extract numeric part from "80/tcp" or "80/udp"
                const firstPort = ports[0].split('/')[0];
                logger.info(`Detected exposed port for ${imageName}: ${firstPort}`);
                return parseInt(firstPort, 10);
            }

            logger.warn(`No exposed ports found for ${imageName}, defaulting to 80`);
            return 80;
        } catch (err) {
            logger.error(`Error detecting port for ${imageName}: ${err.message}`);
            return 80; // Fallback to 80
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
