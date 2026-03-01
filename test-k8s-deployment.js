import k8sService from './src/services/k8s.service.js';

async function testDeployment() {
    console.log('--- Testing K8s Deployment Creation ---');
    const testNamespace = 'test-deploy-ns';
    const resourceName = 'test-app';
    
    try {
        console.log('1. Ensuring namespace...');
        await k8sService.ensureUserNamespace(testNamespace);
        
        console.log('2. Attempting to create deployment...');
        await k8sService.createDeployment({
            name: resourceName,
            namespace: testNamespace,
            image: 'nginx:alpine',
            containerPort: 80,
            plan: { cpu: '100m', memory: '128Mi' },
            replicas: 1
        });
        console.log('   Succeeded.');
        
        console.log('3. Cleaning up...');
        await k8sService.deleteNamespacedDeployment(resourceName, testNamespace);
        // await k8sService.deleteNamespace(testNamespace);
        console.log('   Cleanup done.');

    } catch (err) {
        console.error('Test failed:', err.message);
        if (err.response) {
            console.error('Response body:', JSON.stringify(err.response.body, null, 2));
            console.error('Headers:', JSON.stringify(err.response.headers, null, 2));
        }
    }
}

testDeployment();
