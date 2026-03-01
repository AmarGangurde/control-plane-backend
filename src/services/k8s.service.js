import * as k8s from '@kubernetes/client-node';
import streamModule from 'stream';
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
    const cluster = kc.getCurrentCluster();
    if (cluster) {
      if (process.env.K8S_SKIP_TLS_VERIFY === 'true') {
        cluster.skipTLSVerify = true;
      }
      const apiServerOverride = process.env.K8S_API_SERVER;
      if (apiServerOverride) {
        logger.info(`Overriding K8s API server to ${apiServerOverride}`);
        cluster.server = apiServerOverride;
      }
    }

    this.kc = kc;
    this.core = kc.makeApiClient(k8s.CoreV1Api);
    this.apps = kc.makeApiClient(k8s.AppsV1Api);
    this.net = kc.makeApiClient(k8s.NetworkingV1Api);
    this.metrics = kc.makeApiClient(k8s.CustomObjectsApi);

    const currentCluster = kc.getCurrentCluster();
    logger.info('K8s client initialized', { server: currentCluster?.server, skipTLS: currentCluster?.skipTLSVerify });
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
      if (!items.length) {
        return { cpu: '0', memory: '0' };
      }

      let totalCpuNano = 0n;
      let totalMemBytes = 0n;

      for (const pod of items) {
        for (const container of (pod.containers || [])) {
          const usage = container.usage;
          if (usage) {
            totalCpuNano += this._parseCpuToNano(usage.cpu);
            totalMemBytes += this._parseMemToBytes(usage.memory);
          }
        }
      }

      // Return in a format the frontend can parse easily (millicores and MiB)
      // Using 'm' for CPU and 'Mi' for memory as standard K8s strings
      const totalCpuMillis = Number(totalCpuNano / 1000000n);
      const totalMemMiB = Number(totalMemBytes / (1024n * 1024n));

      return {
        cpu: `${totalCpuMillis}m`,
        memory: `${totalMemMiB}Mi`
      };
    } catch (err) {
      logger.error('Error fetching metrics', err?.message || err);
      return { cpu: '0', memory: '0' };
    }
  }

  // ── Namespaces ─────────────────────────────────────────────────────────────

  async createNamespace(name) {
    try {
      await withRetry(() => this.core.createNamespace({ body: { metadata: { name } } }), {
        label: `createNamespace(${name})`,
        retryIf: (err) => Number(this._getErrorCode(err)) !== 409,
      });
    } catch (err) {
      if (Number(this._getErrorCode(err)) === 409) return; // already exists — fine
      throw err;
    }
  }

  /**
   * High-level helper to ensure a user's environment is ready.
   * Creates namespace and quota if they don't exist.
   */
  async ensureUserNamespace(namespace) {
    logger.info(`Ensuring ecosystem for ${namespace}`);
    await this.createNamespace(namespace);
    await this.createQuota(namespace);
  }

  async deleteNamespace(name) {
    if (!name) {
      logger.warn('deleteNamespace called with empty name, skipping');
      return;
    }
    try {
      await withRetry(() => this.core.deleteNamespace({ name: String(name) }), {
        label: `deleteNamespace(${name})`,
        retryIf: (err) => this._getErrorCode(err) !== 404,
      });
    } catch (err) {
      if (this._getErrorCode(err) === 404) return; // already gone — fine
      throw err;
    }
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
        if (Number(this._getErrorCode(err)) === 409) return; // exists — fine (no update needed)
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
    }), { label: `createDeployment(${name})` })
      .catch(err => {
        if (Number(this._getErrorCode(err)) === 409) return;
        throw err;
      });
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
      if (this._getErrorCode(err) === 404) return;
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
        if (Number(this._getErrorCode(err)) === 409) return;
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
        if (this._getErrorCode(err) === 409) return null;
        throw err;
      });
    return res;
  }

  async deleteNamespacedService(name, namespace) {
    await withRetry(() => this.core.deleteNamespacedService({ name, namespace }), {
      label: `deleteService(${name})`,
      retryIf: (err) => err?.body?.code !== 404,
    }).catch(err => {
      if (this._getErrorCode(err) === 404) return;
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
        if (Number(this._getErrorCode(err)) === 409) return;
        throw err;
      });
  }

  async deleteNamespacedIngress(name, namespace) {
    await withRetry(() => this.net.deleteNamespacedIngress({ name, namespace }), {
      label: `deleteIngress(${name})`,
      retryIf: (err) => err?.body?.code !== 404,
    }).catch(err => {
      if (this._getErrorCode(err) === 404) return;
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
        if (this._getErrorCode(err) === 409) return;
        throw err;
      });
  }

  async deleteNamespacedPVC(name, namespace) {
    await withRetry(() => this.core.deleteNamespacedPersistentVolumeClaim({ name, namespace }), {
      label: `deletePVC(${name})`,
      retryIf: (err) => err?.body?.code !== 404,
    }).catch(err => {
      if (this._getErrorCode(err) === 404) return;
      throw err;
    });
  }

  // ── Pod helpers ────────────────────────────────────────────────────────────

  async getAppStatus(name, namespace) {
    const res = await withRetry(
      () => this.core.listNamespacedPod({ namespace, labelSelector: `app=${name}` }),
      { label: `listPods(${name})` }
    ).catch(() => ({ items: [] }));

    const pods = res.items || res.body?.items || [];
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
    const items = res.items || res.body?.items || [];
    if (!items.length) return null;

    // Prioritize Running pods that are NOT terminating
    const running = items.find(p => p.status.phase === 'Running' && !p.metadata.deletionTimestamp);
    if (running) return running.metadata.name;

    // Fallback to any Running pod, then any pod
    const anyRunning = items.find(p => p.status.phase === 'Running');
    return anyRunning ? anyRunning.metadata.name : items[0].metadata.name;
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
    const stderrStream = new streamModule.PassThrough();
    let stderrData = '';
    stderrStream.on('data', chunk => { stderrData += chunk; });

    return new Promise((resolve, reject) => {
      try {
        const req = exec.exec(
          namespace,
          podName,
          containerName,
          commandArray,
          stream,
          stderrStream,
          null,
          false,
          (status) => {
            if (status.status === 'Success') resolve();
            else {
              const msg = status.message || stderrData.trim() || 'Exec failed';
              reject(new Error(msg));
            }
          }
        );

        if (req && typeof req.catch === 'function') {
          req.catch(reject);
        }
      } catch (err) {
        reject(err);
      }
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

  _getErrorCode(err) {
    // 1. Standard structure
    let code = err?.body?.code || err?.response?.statusCode || err?.code;

    // 2. Body as string
    if (!code && typeof err?.body === 'string' && err.body.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(err.body);
        code = parsed.code;
      } catch (_) { }
    }

    // 3. Message parsing
    if (!code && err.message) {
      const match = err.message.match(/HTTP-Code:\s*(\d+)/i);
      if (match) code = parseInt(match[1], 10);
    }

    // 4. Client-side body (sometimes k8s-client does this)
    if (!code && err?.response?.body?.code) {
      code = err.response.body.code;
    }

    return code ? Number(code) : code;
  }

  _parseCpuToNano(cpuStr) {
    if (!cpuStr) return 0n;
    const match = cpuStr.match(/^([0-9.]+)([a-z]*)$/i);
    if (!match) return 0n;

    const value = parseFloat(match[1]);
    const unit = match[2];

    switch (unit) {
      case 'n': return BigInt(Math.round(value));
      case 'u': return BigInt(Math.round(value * 1000));
      case 'm': return BigInt(Math.round(value * 1000000));
      case '': return BigInt(Math.round(value * 1000000000));
      default: return 0n;
    }
  }

  _parseMemToBytes(memStr) {
    if (!memStr) return 0n;
    const match = memStr.match(/^([0-9.]+)([a-z]*)$/i);
    if (!match) return 0n;

    const value = parseFloat(match[1]);
    const unit = match[2];

    const binaryUnits = {
      'Ki': 1024n, 'Mi': 1024n ** 2n, 'Gi': 1024n ** 3n,
      'Ti': 1024n ** 4n, 'Pi': 1024n ** 5n, 'Ei': 1024n ** 6n
    };
    const decimalUnits = {
      'k': 1000n, 'm': 1000n ** 2n, 'g': 1000n ** 3n,
      't': 1000n ** 4n, 'p': 1000n ** 5n, 'e': 1000n ** 6n
    };

    const multiplier = binaryUnits[unit] || decimalUnits[unit.toLowerCase()] || 1n;
    return BigInt(Math.round(value)) * multiplier;
  }
}

export default new K8sService();
