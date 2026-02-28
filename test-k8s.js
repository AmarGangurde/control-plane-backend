import k8sService from './src/services/k8s.service.js';
import logger from './src/utils/logger.js';

async function testIdempotency() {
    console.log('--- Testing K8s Service Idempotency ---');

    const testNamespace = 'test-idempotency-ns';

    try {
        console.log('1. First creation attempt...');
        await k8sService.ensureUserNamespace(testNamespace);
        console.log('   Succeeded.');

        console.log('2. Second creation attempt (should be silent)...');
        await k8sService.ensureUserNamespace(testNamespace);
        console.log('   Succeeded (Idempotent).');

        console.log('3. Manually fetching namespace to verify it exists...');
        const ns = await k8sService.core.readNamespace({ name: testNamespace });
        console.log(`   Namespace status: ${ns.status.phase}`);

        console.log('4. Testing error extraction logic...');
        // Mock an error object that looks like what we saw in the logs
        const mockError = {
            message: 'HTTP-Code: 409\nBody: "{\\"kind\\":\\"Status\\",\\"apiVersion\\":\\"v1\\",\\"metadata\\":{},\\"status\\":\\"Failure\\",\\"message\\":\\"namespaces \\\\\\"user-0d8cdc5e-5c32-446e-afeb-bbddedac7329\\\\\\" already exists\\",\\"reason\\":\\"AlreadyExists\\",\\"details\\":{\\"name\\":\\"user-0d8cdc5e-5c32-446e-afeb-bbddedac7329\\",\\"kind\\":\\"namespaces\\"},\\"code\\":409}"'
        };
        const extractedCode = k8sService._getErrorCode(mockError);
        console.log(`   Extracted code from mock error: ${extractedCode}`);
        if (extractedCode === 409) {
            console.log('   Extraction Logic: PASSED');
        } else {
            console.log('   Extraction Logic: FAILED');
        }

    } catch (err) {
        console.error('Test failed unexpectedly:', err);
    } finally {
        console.log('5. Cleanup (optional, keeping for manual check)...');
        // await k8sService.deleteNamespace(testNamespace);
    }
}

testIdempotency();
