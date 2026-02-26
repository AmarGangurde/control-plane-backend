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

    this.kc = kc;

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
    try {
      await this.core.createNamespace({
        body: { metadata: { name } }
      });
    } catch (err) {
      if (err.body?.code !== 409) throw err; // 409 = Conflict (Already Exists)
    }
  }

  async createQuota(namespace, maxPods = 50) {
    // Only limit pod count to prevent runaway resource usage.
    // Default to 50 for a shared user namespace.
    try {
      await this.core.createNamespacedResourceQuota({
        namespace,
        body: {
          metadata: {
            name: 'user-quota'
          },
          spec: {
            hard: {
              pods: String(maxPods)
            }
          }
        }
      });
    } catch (err) {
      if (err.body?.code !== 409) throw err;
      // If exists, we could update it, but for now just leave it
    }
  }

  async createDeployment({ name, namespace, image, containerPort, plan, env, command, args, replicas = 1 }) {
    const cpuRequest = plan?.cpu_request || '10m';
    const cpuLimit = plan?.cpu || '100m';
    const memoryRequest = plan?.memory_request || plan?.memory || '128Mi';
    const memory = plan?.memory || '128Mi';

    const container = {
      name: 'app',
      image,
      ports: [{ containerPort }],
      resources: {
        requests: { cpu: cpuRequest, memory: memoryRequest },
        limits: { cpu: cpuLimit, memory }
      },
      securityContext: {
        allowPrivilegeEscalation: false
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

    const podSpec = {
      containers: [container]
    };

    // Future RuntimeClass support (dormant until Kata nodes exist)
    if (plan?.runtime === 'kata') {
      podSpec.runtimeClassName = 'kata';
      podSpec.nodeSelector = { runtime: 'kata' };
    }

    await this.apps.createNamespacedDeployment({
      namespace,
      body: {
        metadata: { name, labels: { app: name } },
        spec: {
          replicas: parseInt(replicas, 10),
          strategy: {
            type: 'RollingUpdate',
            rollingUpdate: {
              maxSurge: 1,
              maxUnavailable: 0
            }
          },
          selector: { matchLabels: { app: name } },
          template: {
            metadata: { labels: { app: name } },
            spec: podSpec
          }
        }
      }
    });
  }

  async createPVC({ namespace, name, size = '1Gi' }) {
    await this.core.createNamespacedPersistentVolumeClaim({
      namespace,
      body: {
        metadata: { name },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: {
            requests: { storage: size }
          }
        }
      }
    });
  }

  async createDatabaseDeployment({ name, namespace, plan, dbUser, dbPassword, dbName, pvcName }) {
    const cpuLimit = plan?.cpu || '250m';
    const memoryLimit = plan?.memory || '256Mi';

    // PostgreSQL usually needs a bit more than nothing to start
    const cpuRequest = plan?.cpu_request || '50m';
    const memoryRequest = plan?.memory_request || '128Mi';

    const podSpec = {
      containers: [{
        name: 'database',
        image: 'postgres:16-alpine',
        ports: [{ containerPort: 5432 }],
        env: [
          { name: 'POSTGRES_USER', value: dbUser },
          { name: 'POSTGRES_PASSWORD', value: dbPassword },
          { name: 'POSTGRES_DB', value: dbName },
          { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' }
        ],
        resources: {
          requests: { cpu: cpuRequest, memory: memoryRequest },
          limits: { cpu: cpuLimit, memory: memoryLimit }
        },
        volumeMounts: [{
          name: 'data',
          mountPath: '/var/lib/postgresql/data',
          subPath: 'pgdata'
        }],
        livenessProbe: {
          exec: { command: ['pg_isready', '-U', dbUser, '-d', dbName] },
          initialDelaySeconds: 30,
          periodSeconds: 10
        }
      }],
      volumes: [{
        name: 'data',
        persistentVolumeClaim: { claimName: pvcName }
      }]
    };

    await this.apps.createNamespacedDeployment({
      namespace,
      body: {
        metadata: { name, labels: { app: name } },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: name } },
          template: {
            metadata: { labels: { app: name } },
            spec: podSpec
          }
        }
      }
    });
  }

  async createDatabaseService({ name, namespace }) {
    // Use ClusterIP for internal access only
    const res = await this.core.createNamespacedService({
      namespace,
      body: {
        metadata: { name },
        spec: {
          type: 'ClusterIP',
          selector: { app: name },
          ports: [{
            port: 5432,
            targetPort: 5432,
            protocol: 'TCP'
          }]
        }
      }
    });
    return res.body;
  }

  async deleteNamespacedDeployment(name, namespace) {
    try {
      await this.apps.deleteNamespacedDeployment({ name, namespace });
    } catch (err) {
      if (err.body?.code !== 404) throw err;
    }
  }

  async deleteNamespacedService(name, namespace) {
    try {
      await this.core.deleteNamespacedService({ name, namespace });
    } catch (err) {
      if (err.body?.code !== 404) throw err;
    }
  }

  async deleteNamespacedIngress(name, namespace) {
    try {
      await this.net.deleteNamespacedIngress({ name, namespace });
    } catch (err) {
      if (err.body?.code !== 404) throw err;
    }
  }

  async deleteNamespacedPVC(name, namespace) {
    try {
      await this.core.deleteNamespacedPersistentVolumeClaim({ name, namespace });
    } catch (err) {
      if (err.body?.code !== 404) throw err;
    }
  }

  async updateDeployment({ name, namespace, image, containerPort, plan, env, command, args, replicas }) {
    const cpuRequest = plan?.cpu_request || '10m';
    const cpuLimit = plan?.cpu || '100m';
    const memoryRequest = plan?.memory_request || plan?.memory || '128Mi';
    const memory = plan?.memory || '128Mi';

    const container = {
      name: 'app',
      image,
      ports: [{ containerPort }],
      resources: {
        requests: { cpu: cpuRequest, memory: memoryRequest },
        limits: { cpu: cpuLimit, memory }
      },
      securityContext: {
        allowPrivilegeEscalation: false
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

    // Read current deployment, modify, and replace (zero-downtime rolling update)
    const current = (await this.apps.readNamespacedDeployment({ name, namespace })).body;

    const podSpec = {
      ...current.spec.template.spec,
      containers: [container]
    };

    // Future RuntimeClass support (dormant until Kata nodes exist)
    if (plan?.runtime === 'kata') {
      podSpec.runtimeClassName = 'kata';
      podSpec.nodeSelector = { runtime: 'kata' };
    }

    current.spec.template.spec = podSpec;
    if (replicas !== undefined) {
      current.spec.replicas = parseInt(replicas, 10);
    }
    current.spec.strategy = {
      type: 'RollingUpdate',
      rollingUpdate: {
        maxSurge: 1,
        maxUnavailable: 0
      }
    };

    await this.apps.replaceNamespacedDeployment({
      name,
      namespace,
      body: current
    });
  }

  async createService({ name, namespace, servicePort, containerPort }) {
    await this.core.createNamespacedService({
      namespace,
      body: {
        metadata: { name },
        spec: {
          selector: { app: name },
          ports: [{ port: servicePort, targetPort: containerPort }]
        }
      }
    });
  }

  async createIngress({ name, namespace, host, port }) {
    await this.net.createNamespacedIngress({
      namespace,
      body: {
        metadata: {
          name,
          annotations: {
            'kubernetes.io/ingress.class': 'traefik',
            'traefik.ingress.kubernetes.io/router.entrypoints': 'web,websecure'
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
                        name,
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

  async getAppStatus(name, namespace) {
    const res = await this.core.listNamespacedPod({
      namespace,
      labelSelector: `app=${name}`
    });

    if (!res.body.items.length) return 'unknown';

    const pods = res.body.items;
    // If any pod is running, and at least one is ready, we consider it running
    // During rolling update, we might have multiple pods.
    const statuses = pods.map(pod => {
      const phase = pod.status.phase;
      if (phase === 'Pending') return 'deploying';
      if (phase === 'Running') {
        const cs = pod.status.containerStatuses || [];
        const ready = cs.every(s => s.ready);
        if (ready) return 'running';
        const crash = cs.some(s => s.state?.waiting?.reason === 'CrashLoopBackOff');
        if (crash) return 'failed';
        return 'deploying';
      }
      if (phase === 'Failed') return 'failed';
      return 'unknown';
    });

    if (statuses.includes('failed')) return 'failed';
    if (statuses.includes('deploying')) return 'deploying';
    if (statuses.includes('running')) return 'running';

    return 'unknown';
  }

  async getPodName(name, namespace) {
    const res = await this.core.listNamespacedPod({
      namespace,
      labelSelector: `app=${name}`
    });
    if (!res.body.items.length) return null;
    return res.body.items[0].metadata.name;
  }

  async getLogs(name, namespace) {
    try {
      const res = await this.core.listNamespacedPod({
        namespace,
        labelSelector: `app=${name}`
      });
      if (!res.body.items.length) return 'No pods found for this app.';

      // Get logs from the first pod in the list
      const pod = res.body.items[0];
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

      return logsRes.body;
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

  /**
   * Executes a command in a running pod and streams stdout.
   * Used for pg_dump backups.
   */
  async execAndStream(namespace, podName, containerName, commandArray, stream) {
    const exec = new k8s.Exec(this.kc);

    return new Promise((resolve, reject) => {
      exec.exec(
        namespace,
        podName,
        containerName,
        commandArray,
        stream,
        process.stderr, // log stderr to server console for debugging
        null, // no stdin
        false, // tty must be false for clean binary/text output
        (status) => {
          if (status.status === 'Success') resolve();
          else reject(new Error(status.message));
        }
      ).catch(reject);
    });
  }
}

export default new K8sService();
