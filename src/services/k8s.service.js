import * as k8s from '@kubernetes/client-node';
import logger from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

class K8sService {
  constructor() {
    const kc = new k8s.KubeConfig();

    // Load config: prefer explicit env override, then common file paths, then default
    const explicitPath = process.env.KUBECONFIG;
    const candidates = [
      explicitPath,
      '/home/node/.kube/config',
      '/app/k3s.yaml',
      '/app/.kube/config',
      '/app/data/k3s.yaml',
    ].filter(Boolean);

    let loaded = false;
    for (const path of candidates) {
      try {
        kc.loadFromFile(path);
        logger.info(`Loaded KubeConfig from: ${path}`);
        loaded = true;
        break;
      } catch (_) { /* try next */ }
    }

    if (!loaded) {
      try {
        kc.loadFromDefault();
        logger.info('Loaded KubeConfig from default system path');
      } catch (err) {
        logger.error('Critical: failed to find any KubeConfig — K8s operations will fail', err);
      }
    }

    // Optional: allow overriding the API server (e.g. when running inside a pod with
    // a kubeconfig that points to 127.0.0.1 or localhost and we need the real node IP).
    const apiServerOverride = process.env.K8S_API_SERVER;
    if (apiServerOverride) {
      const cluster = kc.getCurrentCluster();
      if (cluster) {
        logger.info(`Overriding K8s API server to ${apiServerOverride}`);
        cluster.server = apiServerOverride;
        cluster.skipTLSVerify = process.env.K8S_SKIP_TLS_VERIFY === 'true';
      }
    }

    this.kc = kc;
    this.core = kc.makeApiClient(k8s.CoreV1Api);
    this.apps = kc.makeApiClient(k8s.AppsV1Api);
    this.net = kc.makeApiClient(k8s.NetworkingV1Api);
    this.metrics = kc.makeApiClient(k8s.CustomObjectsApi);

    const cluster = kc.getCurrentCluster();
    logger.info('K8s client initialized', { server: cluster?.server, skipTLS: cluster?.skipTLSVerify });
  }

  // ── Metrics ────────────────────────────────────────────────────────────────

  /**
   * Returns CPU + memory for the first pod matching app=<name> in the given namespace.
   * Falls back to zero values if metrics-server is not installed or pod has no metrics yet.
   */
  async getPodMetrics(namespace, name) {
    try {
      const res = await this.metrics.listNamespacedCustomObject({
        group: 'metrics.k8s.io',
        version: 'v1beta1',
        namespace,
        plural: 'pods',
        labelSelector: name ? `app=${name}` : undefined,
      });

      const items = res.items || [];
      if (!items.length || !items[0].containers?.length) {
        return { cpu: '0', memory: '0' };
      }

      const usage = items[0].containers[0].usage;
      return { cpu: usage.cpu, memory: usage.memory };
    } catch (_err) {
      return { cpu: '0', memory: '0' };
    }
  }

  // ── Namespaces ─────────────────────────────────────────────────────────────

  async createNamespace(name) {
    await withRetry(() => this.core.createNamespace({ body: { metadata: { name } } }), {
      label: `createNamespace(${name})`,
      retryIf: (err) => err?.body?.code !== 409,
    }).catch(err => {
      if (err?.body?.code === 409) return; // already exists — fine
      throw err;
    });
  }

  async deleteNamespace(name) {
    if (!name) {
      logger.warn('deleteNamespace called with empty name, skipping');
      return;
    }
    await withRetry(() => this.core.deleteNamespace({ name: String(name) }), {
      label: `deleteNamespace(${name})`,
      retryIf: (err) => err?.body?.code !== 404,
    }).catch(err => {
      if (err?.body?.code === 404) return; // already gone — fine
      throw err;
    });
  }

  // ── Resource Quota ─────────────────────────────────────────────────────────

  async createQuota(namespace, maxPods = 50) {
    await withRetry(() => this.core.createNamespacedResourceQuota({
      namespace,
      body: {
        metadata: { name: 'user-quota' },
        spec: { hard: { pods: String(maxPods) } },
      },
    }), { label: `createQuota(${namespace})` })
      .catch(err => {
        if (err?.body?.code === 409) return; // exists — fine (no update needed)
        throw err;
      });
  }

  // ── Deployments ────────────────────────────────────────────────────────────

  async createDeployment({ name, namespace, image, containerPort, plan, env, command, args, replicas = 1 }) {
    const spec = this._buildPodSpec({ image, containerPort, plan, env, command, args });
    await withRetry(() => this.apps.createNamespacedDeployment({
      namespace,
      body: {
        metadata: { name, labels: { app: name } },
        spec: {
          replicas: parseInt(replicas, 10),
          strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
          selector: { matchLabels: { app: name } },
          template: {
            metadata: { labels: { app: name } },
            spec,
          },
        },
      },
    }), { label: `createDeployment(${name})` });
  }

  async updateDeployment({ name, namespace, image, containerPort, plan, env, command, args, replicas }) {
    const current = await withRetry(
      () => this.apps.readNamespacedDeployment({ name, namespace }),
      { label: `readDeployment(${name})` }
    );

    const newSpec = this._buildPodSpec({
      image: image ?? current.spec.template.spec.containers[0].image,
      containerPort: containerPort ?? current.spec.template.spec.containers[0].ports[0].containerPort,
      plan,
      env: env !== undefined ? env : null,
      command: command !== undefined ? command : null,
      args: args !== undefined ? args : null,
    });

    current.spec.template.spec = { ...current.spec.template.spec, ...newSpec };
    if (replicas !== undefined) current.spec.replicas = parseInt(replicas, 10);
    current.spec.strategy = { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } };

    await withRetry(() => this.apps.replaceNamespacedDeployment({ name, namespace, body: current }), {
      label: `updateDeployment(${name})`,
    });
  }

  async deleteNamespacedDeployment(name, namespace) {
    await withRetry(() => this.apps.deleteNamespacedDeployment({ name, namespace }), {
      label: `deleteDeployment(${name})`,
      retryIf: (err) => err?.body?.code !== 404,
    }).catch(err => {
      if (err?.body?.code === 404) return;
      throw err;
    });
  }

  // ── Database Deployment ────────────────────────────────────────────────────

  async createDatabaseDeployment({ name, namespace, plan, dbUser, dbPassword, dbName, pvcName }) {
    const cpuLimit = plan?.cpu || '250m';
    const memoryLimit = plan?.memory || '256Mi';
    const cpuRequest = plan?.cpu_request || '50m';
    const memoryRequest = plan?.memory_request || '128Mi';

    await withRetry(() => this.apps.createNamespacedDeployment({
      namespace,
      body: {
        metadata: { name, labels: { app: name } },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: name } },
          template: {
            metadata: { labels: { app: name } },
            spec: {
              containers: [{
                name: 'database',
                image: 'postgres:16-alpine',
                ports: [{ containerPort: 5432 }],
                env: [
                  { name: 'POSTGRES_USER', value: dbUser },
                  { name: 'POSTGRES_PASSWORD', value: dbPassword },
                  { name: 'POSTGRES_DB', value: dbName },
                  { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
                ],
                resources: {
                  requests: { cpu: cpuRequest, memory: memoryRequest },
                  limits: { cpu: cpuLimit, memory: memoryLimit },
                },
                volumeMounts: [{ name: 'data', mountPath: '/var/lib/postgresql/data', subPath: 'pgdata' }],
                livenessProbe: {
                  exec: { command: ['pg_isready', '-U', dbUser, '-d', dbName] },
                  initialDelaySeconds: 30,
                  periodSeconds: 10,
                  failureThreshold: 5,
                },
                readinessProbe: {
                  exec: { command: ['pg_isready', '-U', dbUser, '-d', dbName] },
                  initialDelaySeconds: 5,
                  periodSeconds: 5,
                },
              }],
              volumes: [{ name: 'data', persistentVolumeClaim: { claimName: pvcName } }],
            },
          },
        },
      },
    }), { label: `createDatabaseDeployment(${name})` });
  }

  // ── Services ───────────────────────────────────────────────────────────────

  async createService({ name, namespace, servicePort, containerPort }) {
    await withRetry(() => this.core.createNamespacedService({
      namespace,
      body: {
        metadata: { name },
        spec: {
          selector: { app: name },
          ports: [{ port: servicePort, targetPort: containerPort }],
        },
      },
    }), { label: `createService(${name})` })
      .catch(err => {
        if (err?.body?.code === 409) return;
        throw err;
      });
  }

  async createDatabaseService({ name, namespace }) {
    const res = await withRetry(() => this.core.createNamespacedService({
      namespace,
      body: {
        metadata: { name },
        spec: {
          type: 'ClusterIP',
          selector: { app: name },
          ports: [{ port: 5432, targetPort: 5432, protocol: 'TCP' }],
        },
      },
    }), { label: `createDatabaseService(${name})` })
      .catch(err => {
        if (err?.body?.code === 409) return null;
        throw err;
      });
    return res;
  }

  async deleteNamespacedService(name, namespace) {
    await withRetry(() => this.core.deleteNamespacedService({ name, namespace }), {
      label: `deleteService(${name})`,
      retryIf: (err) => err?.body?.code !== 404,
    }).catch(err => {
      if (err?.body?.code === 404) return;
      throw err;
    });
  }

  // ── Ingress ────────────────────────────────────────────────────────────────

  async createIngress({ name, namespace, host, port }) {
    await withRetry(() => this.net.createNamespacedIngress({
      namespace,
      body: {
        metadata: {
          name,
          annotations: {
            'kubernetes.io/ingress.class': 'traefik',
            'traefik.ingress.kubernetes.io/router.entrypoints': 'web,websecure',
          },
        },
        spec: {
          ingressClassName: 'traefik',
          rules: [{
            host,
            http: {
              paths: [{
                path: '/',
                pathType: 'Prefix',
                backend: { service: { name, port: { number: port } } },
              }],
            },
          }],
        },
      },
    }), { label: `createIngress(${name})` })
      .catch(err => {
        if (err?.body?.code === 409) return;
        throw err;
      });
  }

  async deleteNamespacedIngress(name, namespace) {
    await withRetry(() => this.net.deleteNamespacedIngress({ name, namespace }), {
      label: `deleteIngress(${name})`,
      retryIf: (err) => err?.body?.code !== 404,
    }).catch(err => {
      if (err?.body?.code === 404) return;
      throw err;
    });
  }

  // ── PVC ────────────────────────────────────────────────────────────────────

  async createPVC({ namespace, name, size = '1Gi' }) {
    await withRetry(() => this.core.createNamespacedPersistentVolumeClaim({
      namespace,
      body: {
        metadata: { name },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: size } },
        },
      },
    }), { label: `createPVC(${name})` })
      .catch(err => {
        if (err?.body?.code === 409) return;
        throw err;
      });
  }

  async deleteNamespacedPVC(name, namespace) {
    await withRetry(() => this.core.deleteNamespacedPersistentVolumeClaim({ name, namespace }), {
      label: `deletePVC(${name})`,
      retryIf: (err) => err?.body?.code !== 404,
    }).catch(err => {
      if (err?.body?.code === 404) return;
      throw err;
    });
  }

  // ── Pod helpers ────────────────────────────────────────────────────────────

  async getAppStatus(name, namespace) {
    const res = await withRetry(
      () => this.core.listNamespacedPod({ namespace, labelSelector: `app=${name}` }),
      { label: `listPods(${name})` }
    ).catch(() => ({ items: [] }));

    const pods = res.items || [];
    if (!pods.length) return 'unknown';

    const statuses = pods.map(pod => {
      const phase = pod.status.phase;
      if (phase === 'Pending') return 'deploying';
      if (phase === 'Running') {
        const cs = pod.status.containerStatuses || [];
        if (cs.every(s => s.ready)) return 'running';
        if (cs.some(s => s.state?.waiting?.reason === 'CrashLoopBackOff')) return 'failed';
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
    const res = await this.core.listNamespacedPod({ namespace, labelSelector: `app=${name}` });
    const items = res.items || [];
    if (!items.length) return null;
    return items[0].metadata.name;
  }

  async getLogs(name, namespace) {
    try {
      const res = await this.core.listNamespacedPod({ namespace, labelSelector: `app=${name}` });
      const pods = res.items || [];
      if (!pods.length) return 'No pods found for this app.';

      const pod = pods[0];
      const podName = pod.metadata.name;
      const phase = pod.status.phase;
      const containerStatus = pod.status.containerStatuses?.[0];

      if (phase === 'Pending' || containerStatus?.state?.waiting) {
        return `[System] Container is starting up (${containerStatus?.state?.waiting?.reason || 'Creating'})...`;
      }

      const logsRes = await this.core.readNamespacedPodLog({ name: podName, namespace, tailLines: 200 });
      return logsRes || '';
    } catch (err) {
      const body = err.response?.body || err.body;
      if (body?.message?.includes('waiting to start')) {
        return '[System] Container is initializing. Logs will be available in a few seconds...';
      }
      logger.error('Error fetching logs', err?.message || err);
      return `Error fetching logs: ${err?.message || 'Unknown error'}`;
    }
  }

  /**
   * Lists all pods across all namespaces (for admin use).
   */
  async listAllPods() {
    const res = await withRetry(() => this.core.listPodForAllNamespaces(), { label: 'listAllPods' });
    return res.items || [];
  }

  /**
   * Streams a command executed inside a running pod (pg_dump, etc.)
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
        process.stderr,
        null,
        false,
        (status) => {
          if (status.status === 'Success') resolve();
          else reject(new Error(status.message));
        }
      ).catch(reject);
    });
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  _buildPodSpec({ image, containerPort, plan, env, command, args }) {
    const cpuRequest = plan?.cpu_request || '10m';
    const cpuLimit = plan?.cpu || '100m';
    const memoryRequest = plan?.memory_request || plan?.memory || '128Mi';
    const memoryLimit = plan?.memory || '128Mi';

    const container = {
      name: 'app',
      image,
      ports: [{ containerPort }],
      resources: {
        requests: { cpu: cpuRequest, memory: memoryRequest },
        limits: { cpu: cpuLimit, memory: memoryLimit },
      },
      securityContext: { allowPrivilegeEscalation: false },
    };

    if (env && Array.isArray(env)) container.env = env;
    if (command && Array.isArray(command)) container.command = command;
    if (args && Array.isArray(args)) container.args = args;

    const podSpec = {
      imagePullSecrets: [{ name: 'regcred' }],
      containers: [container],
    };

    if (plan?.runtime === 'kata') {
      podSpec.runtimeClassName = 'kata';
      podSpec.nodeSelector = { runtime: 'kata' };
    }

    return podSpec;
  }
}

export default new K8sService();
