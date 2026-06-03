import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { WorkerManager } from '../worker-manager.js';

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cti-worker-manager-test-'));
}

describe('worker manager', () => {
  it('reports stopped when no status exists', async () => {
    const manager = new WorkerManager({ ctiHome: makeHome() });
    const status = await manager.getStatus();
    assert.equal(status.state, 'stopped');
  });

  it('marks a running worker unhealthy when health check fails', async () => {
    const ctiHome = makeHome();
    const runtimeDir = path.join(ctiHome, 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, 'worker-token'), 'test-token');
    fs.writeFileSync(path.join(runtimeDir, 'worker-status.json'), JSON.stringify({
      state: 'running',
      pid: process.pid,
      port: 9,
    }));

    const manager = new WorkerManager({ ctiHome });
    const status = await manager.getStatus();
    assert.equal(status.state, 'unhealthy');
    assert.ok(status.lastError);
  });

  it('marks a running worker exited when the pid is gone', async () => {
    const ctiHome = makeHome();
    const runtimeDir = path.join(ctiHome, 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, 'worker-status.json'), JSON.stringify({
      state: 'running',
      pid: 999999,
      port: 12345,
    }));

    const manager = new WorkerManager({ ctiHome });
    const status = await manager.getStatus();
    assert.equal(status.state, 'exited');
    assert.equal(status.lastExitReason, 'process not found');
  });

  it('reads a healthy worker status through localhost bearer auth', async () => {
    const ctiHome = makeHome();
    const runtimeDir = path.join(ctiHome, 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, 'worker-token'), 'test-token');

    let serverPort = 0;
    const server = http.createServer((req, res) => {
      assert.equal(req.headers.authorization, 'Bearer test-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, state: 'running', pid: process.pid, port: serverPort, generation: 'gen-1' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    serverPort = (server.address() as AddressInfo).port;

    try {
      fs.writeFileSync(path.join(runtimeDir, 'worker-status.json'), JSON.stringify({
        state: 'running',
        pid: process.pid,
        port: serverPort,
      }));
      const manager = new WorkerManager({ ctiHome });
      const status = await manager.getStatus();
      assert.equal(status.state, 'running');
      assert.equal(status.generation, 'gen-1');
      assert.ok(status.lastHeartbeat);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
