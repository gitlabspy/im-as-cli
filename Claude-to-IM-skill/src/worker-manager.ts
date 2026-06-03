import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WorkerControlResult, WorkerHealth, WorkerState, WorkerStatusFile } from './worker-protocol.js';

interface WorkerManagerOptions {
  ctiHome?: string;
  skillDir?: string;
  nodePath?: string;
  workerEntry?: string;
  statusPath?: string;
  tokenPath?: string;
  portPath?: string;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  spawnProcess?: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess;
}

const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_TIMEOUT_MS = 8_000;

export class WorkerManager {
  private readonly ctiHome: string;
  private readonly skillDir: string;
  private readonly statusPath: string;
  private readonly tokenPath: string;
  private readonly portPath: string;
  private readonly workerEntry: string;
  private readonly workerNodeArgs: string[];
  private readonly nodePath: string;
  private readonly startTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly spawnProcess: NonNullable<WorkerManagerOptions['spawnProcess']>;
  private activeChild: ChildProcess | null = null;
  private transition: Promise<WorkerControlResult> | null = null;

  constructor(options: WorkerManagerOptions = {}) {
    this.ctiHome = options.ctiHome ?? process.env.CTI_HOME ?? path.join(os.homedir(), '.claude-to-im');
    this.skillDir = options.skillDir ?? resolveSkillDir();
    const runtimeDir = path.join(this.ctiHome, 'runtime');
    this.statusPath = options.statusPath ?? path.join(runtimeDir, 'worker-status.json');
    this.tokenPath = options.tokenPath ?? path.join(runtimeDir, 'worker-token');
    this.portPath = options.portPath ?? path.join(runtimeDir, 'worker-port');
    this.workerEntry = options.workerEntry ?? resolveWorkerEntry(this.skillDir);
    this.workerNodeArgs = this.workerEntry.endsWith('.ts') ? process.execArgv : [];
    this.nodePath = options.nodePath ?? process.execPath;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  async ensureRunning(): Promise<WorkerStatusFile> {
    const status = await this.getStatus();
    if (status.state === 'running') return status;
    const started = await this.start();
    if (!started.ok) throw new Error(started.message);
    return started.status;
  }

  async getStatus(): Promise<WorkerStatusFile> {
    const current = this.readStatus();
    if (current.state === 'running' || current.state === 'starting') {
      if (current.pid && !isPidAlive(current.pid)) {
        const exited = this.writeStatus({
          ...current,
          state: 'exited',
          stoppedAt: new Date().toISOString(),
          lastExitReason: 'process not found',
        });
        return exited;
      }

      const health = await this.health(current).catch((err): WorkerHealth => ({
        ok: false,
        state: 'unhealthy' as WorkerState,
        error: err instanceof Error ? err.message : String(err),
      }));
      if (!health.ok && current.state === 'running') {
        return this.writeStatus({ ...current, state: 'unhealthy', lastError: health.error });
      }
      if (health.ok) {
        return this.writeStatus({
          ...current,
          state: 'running',
          pid: health.pid ?? current.pid,
          port: health.port ?? current.port,
          generation: health.generation ?? current.generation,
          startedAt: health.startedAt ?? current.startedAt,
          lastHeartbeat: new Date().toISOString(),
          lastError: undefined,
        });
      }
    }
    return current;
  }

  async start(): Promise<WorkerControlResult> {
    return this.runExclusive(() => this.startInternal());
  }

  async stop(): Promise<WorkerControlResult> {
    return this.runExclusive(() => this.stopInternal());
  }

  async restart(): Promise<WorkerControlResult> {
    return this.runExclusive(async () => {
      const stopped = await this.stopInternal();
      if (!stopped.ok) return stopped;
      return this.startInternal();
    });
  }

  async health(status = this.readStatus()): Promise<WorkerHealth> {
    if (!status.port) {
      return { ok: false, state: status.state, error: 'worker port is unknown' };
    }
    return requestJson<WorkerHealth>({
      port: status.port,
      path: '/health',
      token: this.ensureToken(),
      timeoutMs: 2000,
    });
  }

  getEndpoint(): { port: number; token: string } | null {
    const status = this.readStatus();
    if (!status.port) return null;
    return { port: status.port, token: this.ensureToken() };
  }

  private async startInternal(): Promise<WorkerControlResult> {
    const current = await this.getStatus();
    if (current.state === 'running') {
      return { ok: true, message: `Worker already running (PID ${current.pid ?? 'unknown'})`, status: current };
    }
    if (current.state === 'starting' || current.state === 'stopping') {
      return { ok: false, message: `Worker is ${current.state}; try again shortly.`, status: current };
    }
    if (current.state === 'unhealthy') {
      const stopped = await this.stopInternal();
      if (!stopped.ok) return stopped;
    }

    fs.mkdirSync(path.dirname(this.statusPath), { recursive: true });
    const token = this.ensureToken();
    const port = await reserveLoopbackPort();
    const generation = crypto.randomUUID();
    fs.writeFileSync(this.portPath, String(port), { encoding: 'utf-8', mode: 0o600 });
    const starting = this.writeStatus({
      state: 'starting',
      port,
      generation,
      startedAt: new Date().toISOString(),
    });

    const child = this.spawnProcess(this.nodePath, [...this.workerNodeArgs, this.workerEntry], {
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        CTI_HOME: this.ctiHome,
        CTI_WORKER_PORT: String(port),
        CTI_WORKER_TOKEN: token,
        CTI_WORKER_GENERATION: generation,
      },
    });
    this.activeChild = child;
    child.unref();
    this.writeStatus({ ...starting, pid: child.pid });

    child.once('exit', (code, signal) => {
      const latest = this.readStatus();
      if (latest.generation !== generation) return;
      this.writeStatus({
        ...latest,
        state: 'exited',
        stoppedAt: new Date().toISOString(),
        lastExitReason: signal ? `signal: ${signal}` : `exit code: ${code ?? 'unknown'}`,
      });
    });

    const ready = await this.waitUntilHealthy(generation, this.startTimeoutMs);
    if (!ready.ok) {
      return { ok: false, message: ready.error ?? 'Worker did not become healthy in time.', status: this.readStatus() };
    }
    const status = this.writeStatus({
      state: 'running',
      pid: ready.pid ?? child.pid,
      port,
      generation,
      startedAt: ready.startedAt ?? starting.startedAt,
      lastHeartbeat: new Date().toISOString(),
    });
    return { ok: true, message: `Worker started (PID ${status.pid ?? 'unknown'}, port ${port})`, status };
  }

  private async stopInternal(): Promise<WorkerControlResult> {
    const current = this.readStatus();
    if (current.state !== 'running' && current.state !== 'starting' && current.state !== 'unhealthy') {
      const stopped = this.writeStatus({ ...current, state: 'stopped', stoppedAt: new Date().toISOString() });
      return { ok: true, message: 'Worker already stopped.', status: stopped };
    }

    const stopping = this.writeStatus({ ...current, state: 'stopping' });
    await this.requestShutdown(stopping).catch(() => false);
    if (stopping.pid) await waitForPidExit(stopping.pid, this.stopTimeoutMs);
    if (stopping.pid && isPidAlive(stopping.pid)) {
      try { process.kill(stopping.pid); } catch { /* ignore */ }
      await waitForPidExit(stopping.pid, 1500);
    }
    if (this.activeChild?.pid === stopping.pid) this.activeChild = null;
    const status = this.writeStatus({
      ...stopping,
      state: 'stopped',
      stoppedAt: new Date().toISOString(),
      lastExitReason: 'stopped by control plane',
    });
    return { ok: true, message: 'Worker stopped.', status };
  }

  private async runExclusive(fn: () => Promise<WorkerControlResult>): Promise<WorkerControlResult> {
    if (this.transition) return this.transition;
    this.transition = fn().finally(() => { this.transition = null; });
    return this.transition;
  }

  private readStatus(): WorkerStatusFile {
    try {
      return JSON.parse(fs.readFileSync(this.statusPath, 'utf-8')) as WorkerStatusFile;
    } catch {
      return { state: 'stopped' };
    }
  }

  private writeStatus(status: WorkerStatusFile): WorkerStatusFile {
    fs.mkdirSync(path.dirname(this.statusPath), { recursive: true });
    const tmp = `${this.statusPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(status, null, 2), 'utf-8');
    fs.renameSync(tmp, this.statusPath);
    return status;
  }

  private ensureToken(): string {
    try {
      const existing = fs.readFileSync(this.tokenPath, 'utf-8').trim();
      if (existing) return existing;
    } catch { /* create below */ }
    fs.mkdirSync(path.dirname(this.tokenPath), { recursive: true });
    const token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(this.tokenPath, token, { encoding: 'utf-8', mode: 0o600 });
    return token;
  }

  private async waitUntilHealthy(generation: string, timeoutMs: number): Promise<WorkerHealth> {
    const startedAt = Date.now();
    let lastError = 'worker did not answer health check';
    while (Date.now() - startedAt < timeoutMs) {
      const status = this.readStatus();
      if (status.generation !== generation) return { ok: false, state: 'exited', error: 'worker generation changed' };
      const health = await this.health(status).catch((err) => {
        lastError = err instanceof Error ? err.message : String(err);
        return null;
      });
      if (health?.ok) return health;
      await delay(250);
    }
    return { ok: false, state: 'unhealthy', error: lastError };
  }

  private async requestShutdown(status: WorkerStatusFile): Promise<boolean> {
    if (!status.port) return false;
    const result = await requestJson<{ ok: boolean }>({
      port: status.port,
      path: '/shutdown',
      method: 'POST',
      token: this.ensureToken(),
      timeoutMs: 2000,
    });
    return result.ok;
  }
}

function resolveSkillDir(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.dirname(path.dirname(currentFile));
}

function resolveWorkerEntry(skillDir: string): string {
  const bundled = path.join(skillDir, 'dist', 'worker.mjs');
  if (fs.existsSync(bundled)) return bundled;
  return path.join(skillDir, 'src', 'worker-main.ts');
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to reserve worker port')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function requestJson<T>(opts: { port: number; path: string; method?: string; token: string; body?: unknown; timeoutMs: number }): Promise<T> {
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: opts.port,
      path: opts.path,
      method: opts.method ?? 'GET',
      timeout: opts.timeoutMs,
      headers: {
        Authorization: `Bearer ${opts.token}`,
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
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
        try {
          resolve(JSON.parse(text) as T);
        } catch (err) {
          reject(err);
        }
      });
    });
    request.on('timeout', () => {
      request.destroy(new Error('request timed out'));
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isPidAlive(pid)) return;
    await delay(200);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
