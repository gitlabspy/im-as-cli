import http from 'node:http';

import type { StreamChatParams } from 'remote-agent-control-core/src/lib/bridge/host.js';

import { loadConfig, loadConfigEnvIntoProcess } from './config.js';
import { setupLogger } from './logger.js';
import { PendingPermissions } from './permission-gateway.js';
import { resolveProvider } from './runtime-provider.js';
import { isAuthorizedRequest, type PermissionResolutionPayload, type WorkerHealth } from './worker-protocol.js';

const port = Number.parseInt(process.env.CTI_WORKER_PORT || '', 10);
const token = process.env.CTI_WORKER_TOKEN || '';
const generation = process.env.CTI_WORKER_GENERATION || 'unknown';
const startedAt = new Date();

if (!Number.isInteger(port) || port <= 0 || !token) {
  console.error('[remote-agent-control-worker] Missing CTI_WORKER_PORT or CTI_WORKER_TOKEN.');
  process.exit(1);
}

setupLogger();
loadConfigEnvIntoProcess();

const pendingPerms = new PendingPermissions();
let providerPromise: ReturnType<typeof resolveProvider> | null = null;

function getProvider() {
  providerPromise ??= resolveProvider(loadConfig(), pendingPerms);
  return providerPromise;
}

const server = http.createServer(async (request, response) => {
  if (!isAuthorizedRequest(request.headers.authorization, token)) {
    sendJson(response, 401, { error: 'unauthorized' });
    return;
  }

  try {
    if (request.method === 'GET' && request.url === '/health') {
      const health: WorkerHealth = {
        ok: true,
        state: 'running',
        pid: process.pid,
        port,
        generation,
        startedAt: startedAt.toISOString(),
        uptimeMs: Date.now() - startedAt.getTime(),
      };
      sendJson(response, 200, health);
      return;
    }

    if (request.method === 'POST' && request.url === '/permission') {
      const payload = await readJson<PermissionResolutionPayload>(request);
      const resolved = pendingPerms.resolve(payload.permissionRequestId, payload.resolution);
      sendJson(response, 200, { resolved });
      return;
    }

    if (request.method === 'POST' && request.url === '/stream') {
      const params = await readJson<StreamChatParams>(request);
      const provider = await getProvider();
      const stream = provider.streamChat(params);
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const reader = stream.getReader();
      request.on('close', () => {
        try { reader.cancel().catch(() => undefined); } catch { /* ignore */ }
      });
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          response.write(value);
        }
      } finally {
        try { reader.releaseLock(); } catch { /* ignore */ }
        response.end();
      }
      return;
    }

    if (request.method === 'POST' && request.url === '/shutdown') {
      sendJson(response, 200, { ok: true });
      setTimeout(() => shutdown('control plane requested shutdown'), 25);
      return;
    }

    sendJson(response, 404, { error: 'not found' });
  } catch (err) {
    sendJson(response, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[remote-agent-control-worker] Started (PID: ${process.pid}, port: ${port}, generation: ${generation})`);
});

function shutdown(reason: string): void {
  console.log(`[remote-agent-control-worker] Shutting down (${reason})...`);
  pendingPerms.denyAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('[remote-agent-control-worker] uncaughtException:', err.stack || err.message);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[remote-agent-control-worker] unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
});

function sendJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function readJson<T>(request: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T);
      } catch (err) {
        reject(err);
      }
    });
    request.on('error', reject);
  });
}
