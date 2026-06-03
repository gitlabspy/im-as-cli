import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ControlCommandRequest, ControlCommandResponse } from 'remote-agent-control-core/src/lib/bridge/host.js';

import { maskSecrets } from './logger.js';
import type { Config } from './config.js';
import type { WorkerManager } from './worker-manager.js';
import type { WorkerHealth, WorkerStatusFile } from './worker-protocol.js';

interface ControlCommandOptions {
  ctiHome?: string;
  skillDir?: string;
  config?: Pick<Config, 'controlAllowedUsers' | 'controlAllowedChats'>;
  workerManager?: Pick<WorkerManager, 'getStatus' | 'start' | 'stop' | 'restart' | 'health'>;
  restartDelayMs?: number;
  scheduleRestart?: (delayMs: number) => void;
}

interface StatusFile {
  running?: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  channels?: string[];
  lastExitReason?: string;
}

const DEFAULT_LOG_LINES = 50;
const MAX_LOG_LINES = 200;
const MAX_LOG_CHARS = 3500;

export function createControlCommandHandler(options: ControlCommandOptions = {}) {
  const ctiHome = options.ctiHome ?? process.env.CTI_HOME ?? path.join(os.homedir(), '.claude-to-im');
  const skillDir = options.skillDir ?? resolveSkillDir();
  const restartDelayMs = options.restartDelayMs ?? 2000;
  const scheduleRestart = options.scheduleRestart ?? ((delayMs: number) => scheduleBridgeRestart(skillDir, delayMs));
  const workerManager = options.workerManager;
  const allowedUsers = new Set(options.config?.controlAllowedUsers ?? []);
  const allowedChats = new Set(options.config?.controlAllowedChats ?? []);

  return async function handleControlCommand(request: ControlCommandRequest): Promise<ControlCommandResponse> {
    if (!isAuthorized(request, allowedUsers, allowedChats)) {
      return { text: 'Unauthorized: /ctl commands are restricted to configured users or chats.', parseMode: 'plain' };
    }

    const action = normalizeAction(request.action, request.args);
    switch (request.action) {
      case 'status':
        return { text: formatStatus(ctiHome, workerManager ? await workerManager.getStatus() : undefined), parseMode: 'plain' };
      case 'health': {
        const workerStatus = workerManager ? await workerManager.getStatus() : undefined;
        let workerHealth: WorkerHealth | undefined;
        if (workerManager && workerStatus && workerStatus.state === 'running') {
          workerHealth = await workerManager.health(workerStatus).catch((err): WorkerHealth => ({
            ok: false,
            state: 'unhealthy',
            error: err instanceof Error ? err.message : String(err),
          }));
        }
        return { text: formatHealth(ctiHome, workerStatus, workerHealth), parseMode: 'plain' };
      }
      case 'logs':
        return { text: formatLogs(ctiHome, parseLogLineCount(request.args)), parseMode: 'plain' };
      case 'restart':
        scheduleRestart(restartDelayMs);
        return {
          text: `Restart requested. The bridge will restart in ${Math.round(restartDelayMs / 100) / 10}s.`,
          parseMode: 'plain',
        };
      default:
        break;
    }

    if (action.kind === 'worker') {
      if (!workerManager) {
        return { text: 'Worker management is not enabled in this host.', parseMode: 'plain' };
      }
      switch (action.command) {
        case 'status':
          return { text: formatWorkerStatus(await workerManager.getStatus()), parseMode: 'plain' };
        case 'start':
          return { text: formatWorkerControlResult(await workerManager.start()), parseMode: 'plain' };
        case 'stop':
          return { text: formatWorkerControlResult(await workerManager.stop()), parseMode: 'plain' };
        case 'restart':
          return { text: formatWorkerControlResult(await workerManager.restart()), parseMode: 'plain' };
        default:
          return { text: 'Usage: /ctl worker status|start|stop|restart', parseMode: 'plain' };
      }
    }

    return { text: 'Usage: /ctl status|health|logs [N]|worker status|worker start|worker stop|worker restart', parseMode: 'plain' };
  };
}

function normalizeAction(action: string, args: string): { kind: 'worker'; command: string } | { kind: 'other' } {
  if (action !== 'worker') return { kind: 'other' };
  const command = args.trim().split(/\s+/, 1)[0]?.toLowerCase() || '';
  return { kind: 'worker', command };
}

function isAuthorized(request: ControlCommandRequest, allowedUsers: Set<string>, allowedChats: Set<string>): boolean {
  if (allowedUsers.size === 0 && allowedChats.size === 0) return true;
  return (!!request.userId && allowedUsers.has(request.userId)) || allowedChats.has(request.chatId);
}

function resolveSkillDir(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.dirname(path.dirname(currentFile));
}

function formatStatus(ctiHome: string, workerStatus?: WorkerStatusFile): string {
  const statusPath = path.join(ctiHome, 'runtime', 'status.json');
  const status = readStatus(statusPath);
  const lines = ['Control plane: online'];

  if (!status) {
    lines.push(`Bridge status: unknown (missing ${statusPath})`);
    lines.push(`Current PID: ${process.pid}`);
    return lines.join('\n');
  }

  lines.push(`Bridge status: ${status.running ? 'running' : 'not running'}`);
  lines.push(`PID: ${status.pid ?? process.pid}`);
  if (status.runId) lines.push(`Run ID: ${status.runId}`);
  if (status.startedAt) lines.push(`Started: ${status.startedAt}`);
  if (status.channels?.length) lines.push(`Channels: ${status.channels.join(', ')}`);
  if (status.lastExitReason) lines.push(`Last exit: ${status.lastExitReason}`);
  if (workerStatus) {
    lines.push('');
    lines.push(...formatWorkerStatusLines(workerStatus));
  }
  return lines.join('\n');
}

function formatHealth(ctiHome: string, workerStatus?: WorkerStatusFile, workerHealth?: WorkerHealth): string {
  const lines = [formatStatus(ctiHome, workerStatus), '', 'Health:'];
  lines.push('Control plane: ok');
  if (!workerStatus) {
    lines.push('Worker: unavailable');
  } else if (workerHealth) {
    lines.push(`Worker: ${workerHealth.ok ? 'ok' : 'failed'} (${workerHealth.state})`);
    if (workerHealth.uptimeMs !== undefined) lines.push(`Worker uptime: ${Math.round(workerHealth.uptimeMs / 1000)}s`);
    if (workerHealth.error) lines.push(`Worker error: ${workerHealth.error}`);
  } else {
    lines.push(`Worker: ${workerStatus.state}`);
  }
  return lines.join('\n');
}

function formatWorkerStatus(status: WorkerStatusFile): string {
  return formatWorkerStatusLines(status).join('\n');
}

function formatWorkerStatusLines(status: WorkerStatusFile): string[] {
  const lines = [`Worker status: ${status.state}`];
  if (status.pid) lines.push(`Worker PID: ${status.pid}`);
  if (status.port) lines.push(`Worker port: ${status.port}`);
  if (status.generation) lines.push(`Worker generation: ${status.generation}`);
  if (status.startedAt) lines.push(`Worker started: ${status.startedAt}`);
  if (status.lastHeartbeat) lines.push(`Worker heartbeat: ${status.lastHeartbeat}`);
  if (status.lastExitReason) lines.push(`Worker last exit: ${status.lastExitReason}`);
  if (status.lastError) lines.push(`Worker last error: ${status.lastError}`);
  return lines;
}

function formatWorkerControlResult(result: { ok: boolean; message: string; status: WorkerStatusFile }): string {
  return [result.message, '', ...formatWorkerStatusLines(result.status)].join('\n');
}

function readStatus(statusPath: string): StatusFile | null {
  try {
    return JSON.parse(fs.readFileSync(statusPath, 'utf-8')) as StatusFile;
  } catch {
    return null;
  }
}

function parseLogLineCount(args: string): number {
  const trimmed = args.trim();
  if (!trimmed) return DEFAULT_LOG_LINES;
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(value) || String(value) !== trimmed || value < 1) {
    return DEFAULT_LOG_LINES;
  }
  return Math.min(value, MAX_LOG_LINES);
}

function formatLogs(ctiHome: string, lineCount: number): string {
  const logPath = path.join(ctiHome, 'logs', 'bridge.log');
  let content: string;
  try {
    content = fs.readFileSync(logPath, 'utf-8');
  } catch {
    return `No log file found at ${logPath}`;
  }

  const lines = content.split(/\r?\n/).filter((line) => line.length > 0).slice(-lineCount);
  const sanitized = lines.map(maskSecrets).join('\n');
  if (sanitized.length <= MAX_LOG_CHARS) return sanitized || '(log file is empty)';
  return `... truncated ...\n${sanitized.slice(-MAX_LOG_CHARS)}`;
}

function scheduleBridgeRestart(skillDir: string, delayMs: number): void {
  if (process.platform === 'win32') {
    const scriptPath = path.join(skillDir, 'scripts', 'daemon.ps1');
    const command = `Start-Sleep -Milliseconds ${delayMs}; & ${quotePowerShell(scriptPath)} restart`;
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return;
  }

  const scriptPath = path.join(skillDir, 'scripts', 'daemon.sh');
  const delaySeconds = Math.max(1, Math.ceil(delayMs / 1000));
  const child = spawn('bash', ['-lc', `sleep ${delaySeconds}; bash ${quoteShell(scriptPath)} restart`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
