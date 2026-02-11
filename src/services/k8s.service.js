import * as k8s from '@kubernetes/client-node';
import logger from '../utils/logger.js';
import { execSync } from 'child_process';

class K8sService {
  constructor() {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();

    this.core = kc.makeApiClient(k8s.CoreV1Api);
    logger.info('K8s client initialized', { server: kc.getCurrentCluster()?.server });
    this.apps = kc.makeApiClient(k8s.AppsV1Api);
    this.net = kc.makeApiClient(k8s.NetworkingV1Api);
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

  async createDeployment({ namespace, image, port, plan }) {
    const cpu = plan?.cpu || '100m';
    const memory = plan?.memory || '128Mi';

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
              containers: [
                {
                  name: 'app',
                  image,
                  ports: [{ containerPort: port }],
                  resources: {
                    requests: {
                      cpu: cpu,
                      memory: memory
                    },
                    limits: {
                      cpu: cpu,
                      memory: memory
                    }
                  }
                }
              ]
            }
          }
        }
      }
    });
  }

  async createService({ namespace, port }) {
    await this.core.createNamespacedService({
      namespace,
      body: {
        metadata: { name: 'app' },
        spec: {
          selector: { app: 'app' },
          ports: [{ port, targetPort: port }]
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
