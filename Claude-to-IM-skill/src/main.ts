/**
 * Daemon entry point for remote-agent-control-skill.
 *
 * Assembles all DI implementations and starts the bridge.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { initBridgeContext } from 'remote-agent-control-core/src/lib/bridge/context.js';
import * as bridgeManager from 'remote-agent-control-core/src/lib/bridge/bridge-manager.js';
// Side-effect import to trigger adapter self-registration
import 'remote-agent-control-core/src/lib/bridge/adapters/index.js';
import './adapters/weixin-adapter.js';

import { loadConfig, configToSettings, CTI_HOME, loadConfigEnvIntoProcess } from './config.js';
import { JsonFileStore } from './store.js';
import { PendingPermissions } from './permission-gateway.js';
import { setupLogger } from './logger.js';
import { createControlCommandHandler } from './control-command.js';
import { resolveProvider } from './runtime-provider.js';
import { WorkerClientProvider } from './worker-client-provider.js';
import { WorkerManager } from './worker-manager.js';

const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const STATUS_FILE = path.join(RUNTIME_DIR, 'status.json');
const PID_FILE = path.join(RUNTIME_DIR, 'bridge.pid');

interface StatusInfo {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  channels?: string[];
  lastExitReason?: string;
}

function writeStatus(info: StatusInfo): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  // Merge with existing status to preserve fields like lastExitReason
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch { /* first write */ }
  const merged = { ...existing, ...info };
  const tmp = STATUS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmp, STATUS_FILE);
}

async function main(): Promise<void> {
  loadConfigEnvIntoProcess();
  const config = loadConfig();
  setupLogger();

  const runId = crypto.randomUUID();
  console.log(`[remote-agent-control] Starting bridge (run_id: ${runId})`);

  const settings = configToSettings(config);
  const store = new JsonFileStore(settings);
  const pendingPerms = new PendingPermissions();
  const workerManager = config.workerMode === 'managed' ? new WorkerManager() : undefined;
  const llm = workerManager
    ? new WorkerClientProvider(workerManager, config.workerAutoStart)
    : await resolveProvider(config, pendingPerms);
  const handleControlCommand = createControlCommandHandler({ config, workerManager });
  console.log(`[remote-agent-control] Runtime: ${config.runtime}`);
  console.log(`[remote-agent-control] Worker mode: ${config.workerMode}${config.workerAutoStart ? ' (auto-start)' : ''}`);

  const gateway = {
    resolvePendingPermission: async (id: string, resolution: { behavior: 'allow' | 'deny'; message?: string }) => {
      if (workerManager && llm instanceof WorkerClientProvider) {
        return llm.resolvePendingPermission(id, resolution);
      }
      return pendingPerms.resolve(id, resolution);
    },
  };

  initBridgeContext({
    store,
    llm,
    permissions: gateway,
    lifecycle: {
      onBridgeStart: () => {
        // Write authoritative PID from the actual process (not shell $!)
        fs.mkdirSync(RUNTIME_DIR, { recursive: true });
        fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
        writeStatus({
          running: true,
          pid: process.pid,
          runId,
          startedAt: new Date().toISOString(),
          channels: config.enabledChannels,
        });
        console.log(`[remote-agent-control] Bridge started (PID: ${process.pid}, channels: ${config.enabledChannels.join(', ')})`);
        if (workerManager && config.workerAutoStart) {
          workerManager.start().then((result) => {
            console.log(`[remote-agent-control] ${result.message}`);
          }).catch((err) => {
            console.error('[remote-agent-control] Worker auto-start failed:', err instanceof Error ? err.message : err);
          });
        }
      },
      onBridgeStop: () => {
        writeStatus({ running: false });
        console.log('[remote-agent-control] Bridge stopped');
      },
      handleControlCommand,
    },
  });

  await bridgeManager.start();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const reason = signal ? `signal: ${signal}` : 'shutdown requested';
    console.log(`[remote-agent-control] Shutting down (${reason})...`);
    pendingPerms.denyAll();
    await bridgeManager.stop();
    if (workerManager) {
      await workerManager.stop().catch((err) => {
        console.error('[remote-agent-control] Worker stop failed:', err instanceof Error ? err.message : err);
      });
    }
    writeStatus({ running: false, lastExitReason: reason });
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // ── Exit diagnostics ──
  process.on('unhandledRejection', (reason) => {
    console.error('[remote-agent-control] unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
    writeStatus({ running: false, lastExitReason: `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}` });
  });
  process.on('uncaughtException', (err) => {
    console.error('[remote-agent-control] uncaughtException:', err.stack || err.message);
    writeStatus({ running: false, lastExitReason: `uncaughtException: ${err.message}` });
    process.exit(1);
  });
  process.on('beforeExit', (code) => {
    console.log(`[remote-agent-control] beforeExit (code: ${code})`);
  });
  process.on('exit', (code) => {
    console.log(`[remote-agent-control] exit (code: ${code})`);
  });

  // ── Heartbeat to keep event loop alive ──
  // setInterval is ref'd by default, preventing Node from exiting
  // when the event loop would otherwise be empty.
  setInterval(() => { /* keepalive */ }, 45_000);
}

main().catch((err) => {
  console.error('[remote-agent-control] Fatal error:', err instanceof Error ? err.stack || err.message : err);
  try { writeStatus({ running: false, lastExitReason: `fatal: ${err instanceof Error ? err.message : String(err)}` }); } catch { /* ignore */ }
  process.exit(1);
});
