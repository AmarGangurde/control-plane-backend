import { execSync } from 'child_process';
import logger from '../utils/logger.js';

class ImageService {
    async getExposedPort(imageName) {
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

                // use --config to get the actual image configuration including ExposedPorts
                inspectOutput = execSync(`skopeo inspect --config docker://${fullImageName}`, { stdio: 'pipe' }).toString();
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
}

export default new ImageService();
