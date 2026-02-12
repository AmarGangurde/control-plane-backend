import * as k8s from '@kubernetes/client-node';
import logger from '../utils/logger.js';
import { execSync } from 'child_process';

class K8sService {
  constructor() {
    const kc = new k8s.KubeConfig();

    const possiblePaths = [
      process.env.KUBECONFIG,
      '/home/node/.kube/config',
      '/app/k3s.yaml',
      '/app/.kube/config',
      '/app/data/k3s.yaml'
    ];

    let loaded = false;
    for (const path of possiblePaths) {
      if (!path) continue;
      try {
        kc.loadFromFile(path);
        logger.info(`✅ Successfully loaded KubeConfig from: ${path}`);
        loaded = true;
        break;
      } catch (e) {
        // Just move to the next one
      }
    }

    if (!loaded) {
      try {
        kc.loadFromDefault();
        logger.info('ℹ️ Loaded KubeConfig from default system path');
      } catch (err) {
        logger.error('❌ Critical: Failed to find any KubeConfig. K8s operations will fail.', err.message);
      }
    }

    const cluster = kc.getCurrentCluster();
    if (cluster && (cluster.server.includes('localhost') || cluster.server.includes('127.0.0.1'))) {
      cluster.skipTLSVerify = true;
    }

    this.core = kc.makeApiClient(k8s.CoreV1Api);
    logger.info('K8s client initialized', {
      server: cluster?.server,
      skipTLS: cluster?.skipTLSVerify
    });
    this.apps = kc.makeApiClient(k8s.AppsV1Api);
    this.net = kc.makeApiClient(k8s.NetworkingV1Api);
    this.metrics = kc.makeApiClient(k8s.CustomObjectsApi);
  }

  async getPodMetrics(namespace) {
    try {
      // Fetch metrics from metrics.k8s.io
      const res = await this.metrics.listNamespacedCustomObject({
        group: 'metrics.k8s.io',
        version: 'v1beta1',
        namespace,
        plural: 'pods'
      });

      const podMetrics = res.items[0];
      if (!podMetrics || !podMetrics.containers || !podMetrics.containers[0]) {
        return { cpu: '0', memory: '0' };
      }

      const usage = podMetrics.containers[0].usage;
      return {
        cpu: usage.cpu, // e.g., "100m" or "1000000n"
        memory: usage.memory // e.g., "128Mi" or "131072Ki"
      };
    } catch (err) {
      // Metrics server might not be installed or pod might not have metrics yet
      return { cpu: '0', memory: '0' };
    }
  }

  async createNamespace(name) {
    await this.core.createNamespace({
      body: { metadata: { name } }
    });
  }

  async createQuota(namespace, plan) {
    const cpu = plan?.cpu || '500m';
    const memory = plan?.memory || '512Mi';
    // For quota, maybe give a bit more buffer or strict?
    // Let's set the quota to the plan limit for now (assuming 1 replica)
    // or maybe 2x to allow rolling updates?
    // Let's simplify: hard limit same as Pod limit * 2 for buffer

    // We need to parse units properly to multiply, but k8s handles strings.
    // For simplicity, let's just set a generous hard quota or match the plan.
    // Actually, let's hardcode a default "User Quota" or per-namespace quota matching the plan.

    await this.core.createNamespacedResourceQuota({
      namespace,
      body: {
        metadata: {
          name: 'app-quota'
        },
        spec: {
          hard: {
            'requests.cpu': cpu,
            'requests.memory': memory,
            'limits.cpu': cpu,
            'limits.memory': memory,
            pods: '2'
          }
        }
      }
    });
  }

  async createDeployment({ namespace, image, containerPort, plan, env, command, args }) {
    const cpu = plan?.cpu || '100m';
    const memory = plan?.memory || '128Mi';

    const container = {
      name: 'app',
      image,
      ports: [{ containerPort }],
      resources: {
        requests: { cpu, memory },
        limits: { cpu, memory }
      }
    };

    if (env && Array.isArray(env)) {
      container.env = env;
    }

    if (command && Array.isArray(command)) {
      container.command = command;
    }

    if (args && Array.isArray(args)) {
      container.args = args;
    }

    await this.apps.createNamespacedDeployment({
      namespace,
      body: {
        metadata: { name: 'app' },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: 'app' } },
          template: {
            metadata: { labels: { app: 'app' } },
            spec: {
              containers: [container]
            }
          }
        }
      }
    });
  }

  async createService({ namespace, servicePort, containerPort }) {
    await this.core.createNamespacedService({
      namespace,
      body: {
        metadata: { name: 'app' },
        spec: {
          selector: { app: 'app' },
          ports: [{ port: servicePort, targetPort: containerPort }]
        }
      }
    });
  }

  async createIngress({ namespace, host, port }) {
    await this.net.createNamespacedIngress({
      namespace,
      body: {
        metadata: {
          name: 'app',
          annotations: {
            'kubernetes.io/ingress.class': 'traefik',
            'traefik.ingress.kubernetes.io/router.entrypoints': 'web'
          }
        },
        spec: {
          ingressClassName: 'traefik',
          rules: [
            {
              host,
              http: {
                paths: [
                  {
                    path: '/',
                    pathType: 'Prefix',
                    backend: {
                      service: {
                        name: 'app',
                        port: { number: port }
                      }
                    }
                  }
                ]
              }
            }
          ]
        }
      }
    });
  }

  async getAppStatus(namespace) {
    const res = await this.core.listNamespacedPod({ namespace });

    if (!res.items.length) return 'unknown';

    const pod = res.items[0];
    const phase = pod.status.phase;

    if (phase === 'Pending') return 'deploying';

    if (phase === 'Running') {
      const statuses = pod.status.containerStatuses || [];
      const ready = statuses.every(s => s.ready);
      if (ready) return 'running';

      const crash = statuses.some(
        s => s.state?.waiting?.reason === 'CrashLoopBackOff'
      );
      if (crash) return 'failed';

      return 'deploying';
    }

    if (phase === 'Failed') return 'failed';

    return 'unknown';
  }

  async getLogs(namespace) {
    try {
      const res = await this.core.listNamespacedPod({ namespace });
      if (!res.items.length) return 'No pods found in namespace.';

      const pod = res.items[0];
      const podName = pod.metadata.name;
      const phase = pod.status.phase;

      // Check if pod is still pending or creating
      const containerStatus = pod.status.containerStatuses?.[0];
      if (phase === 'Pending' || containerStatus?.state?.waiting) {
        return `[System] Container is starting up (${containerStatus?.state?.waiting?.reason || 'Creating'})...`;
      }

      const logsRes = await this.core.readNamespacedPodLog({
        name: podName,
        namespace,
        tailLines: 100 // Get last 100 lines
      });

      return logsRes;
    } catch (err) {
      // Handle the specific k8s error when container is not yet ready
      const body = err.response?.body || err.body;
      if (body?.message?.includes('waiting to start')) {
        return '[System] Container is initializing. Logs will be available in a few seconds...';
      }

      logger.error('Error fetching logs', err?.message || err);
      return `Error fetching logs: ${err?.message || 'Unknown error'}`;
    }
  }

  async deleteNamespace(name) {
    if (!name) {
      logger.warn('k8s.deleteNamespace called with empty name, skipping');
      return;
    }

    logger.info('k8s.deleteNamespace invoked', { name, coreExists: !!this.core, fn: typeof this.core?.deleteNamespace });

    try {
      // ensure we pass a plain string
      const nsName = String(name);
      await this.core.deleteNamespace({ name: nsName });
    } catch (err) {
      logger.error('k8s.deleteNamespace error', err?.message || err, err?.stack);

      // fallback: try using kubectl if available (helps when client binding has issues)
      try {
        logger.info('k8s.deleteNamespace fallback: attempting kubectl delete', { name });
        const out = execSync(`kubectl delete namespace ${String(name)}`, { stdio: 'pipe' }).toString();
        logger.info('kubectl delete output', out.trim());
        return;
      } catch (kubectlErr) {
        logger.error('kubectl fallback failed', kubectlErr?.message || kubectlErr);
      }

      throw err;
    }
  }
}

export default new K8sService();
