import http from 'node:http';

import type { LLMProvider, StreamChatParams } from 'remote-agent-control-core/src/lib/bridge/host.js';

import { sseEvent } from './sse-utils.js';
import type { PermissionResolution } from './permission-gateway.js';
import { serializeStreamChatParams } from './worker-protocol.js';
import type { WorkerManager } from './worker-manager.js';

export class WorkerClientProvider implements LLMProvider {
  constructor(private readonly worker: WorkerManager, private readonly autoStart: boolean) {}

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const worker = this.worker;
    const autoStart = this.autoStart;
    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          try {
            const status = autoStart ? await worker.ensureRunning() : await worker.getStatus();
            if (status.state !== 'running' || !status.port) {
              controller.enqueue(sseEvent('error', 'Agent Worker is offline. Use /ctl worker start or /ctl worker restart, then try again.'));
              controller.close();
              return;
            }
            const endpoint = worker.getEndpoint();
            if (!endpoint) {
              controller.enqueue(sseEvent('error', 'Agent Worker endpoint is unavailable. Use /ctl worker restart, then try again.'));
              controller.close();
              return;
            }

            const response = await postStream({
              port: endpoint.port,
              token: endpoint.token,
              path: '/stream',
              body: serializeStreamChatParams(params),
              abortSignal: params.abortController?.signal,
            });
            response.on('data', (chunk) => controller.enqueue(Buffer.from(chunk).toString('utf-8')));
            response.on('end', () => controller.close());
            response.on('error', (err) => {
              controller.enqueue(sseEvent('error', `Worker stream failed: ${err.message}`));
              controller.close();
            });
          } catch (err) {
            controller.enqueue(sseEvent('error', err instanceof Error ? err.message : String(err)));
            controller.close();
          }
        })();
      },
    });
  }

  async resolvePendingPermission(permissionRequestId: string, resolution: PermissionResolution): Promise<boolean> {
    const status = await this.worker.getStatus();
    if (status.state !== 'running') return false;
    const endpoint = this.worker.getEndpoint();
    if (!endpoint) return false;
    const result = await postJson<{ resolved: boolean }>({
      port: endpoint.port,
      token: endpoint.token,
      path: '/permission',
      body: { permissionRequestId, resolution },
      timeoutMs: 5000,
    });
    return result.resolved;
  }
}

function postStream(opts: {
  port: number;
  token: string;
  path: string;
  body: unknown;
  abortSignal?: AbortSignal;
}): Promise<http.IncomingMessage> {
  const body = JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: opts.port,
      path: opts.path,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      if ((response.statusCode ?? 500) >= 400) {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on('end', () => reject(new Error(Buffer.concat(chunks).toString('utf-8') || `HTTP ${response.statusCode}`)));
        return;
      }
      resolve(response);
    });
    request.on('error', reject);
    opts.abortSignal?.addEventListener('abort', () => request.destroy(new Error('stream aborted')), { once: true });
    request.write(body);
    request.end();
  });
}

function postJson<T>(opts: { port: number; token: string; path: string; body: unknown; timeoutMs: number }): Promise<T> {
  const body = JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: opts.port,
      path: opts.path,
      method: 'POST',
      timeout: opts.timeoutMs,
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(text || `HTTP ${response.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(text) as T); } catch (err) { reject(err); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('request timed out')));
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}
