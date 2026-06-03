import fs from 'node:fs';
import path from 'node:path';
import { CTI_HOME } from './config.js';

const KEY_VALUE_SECRET_PATTERN =
  /\b(token|secret|password|api[_-]?key|access[_-]?token|refresh[_-]?token)["']?(\s*[:=]\s*["']?)([^\s"',]+)/gi;
const TELEGRAM_BOT_TOKEN_PATTERN = /bot\d+:[A-Za-z0-9_-]{35}/g;
const BEARER_TOKEN_PATTERN = /Bearer\s+([A-Za-z0-9._-]+)/g;
const AUTH_CACHE_PATH_PATTERN = /(?:[A-Za-z]:)?[\\/][^\s"'<>]*(?:\.codex|\.claude|\.lark|\.config[\\/]gh)[\\/][^\s"'<>]*(?:auth|token|credential|cookie)[^\s"'<>]*/gi;

function maskValue(value: string): string {
  if (value.length <= 4) return '****';
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

export function maskSecrets(text: string): string {
  return text
    .replace(KEY_VALUE_SECRET_PATTERN, (_match, key: string, separator: string, value: string) => {
      return `${key}${separator}${maskValue(value)}`;
    })
    .replace(TELEGRAM_BOT_TOKEN_PATTERN, (match) => maskValue(match))
    .replace(BEARER_TOKEN_PATTERN, (_match, value: string) => `Bearer ${maskValue(value)}`)
    .replace(AUTH_CACHE_PATH_PATTERN, '[redacted auth path]');
}

const LOG_DIR = path.join(CTI_HOME, 'logs');
const LOG_PATH = path.join(LOG_DIR, 'bridge.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROTATED = 3;

let logStream: fs.WriteStream | null = null;

function openLogStream(): fs.WriteStream {
  return fs.createWriteStream(LOG_PATH, { flags: 'a' });
}

function rotateIfNeeded(): void {
  try {
    const stat = fs.statSync(LOG_PATH);
    if (stat.size < MAX_LOG_SIZE) return;
  } catch {
    return; // file doesn't exist yet
  }

  // Close current stream
  if (logStream) {
    logStream.end();
    logStream = null;
  }

  // Rotate: delete .3, shift .2→.3, .1→.2, current→.1
  const path3 = `${LOG_PATH}.${MAX_ROTATED}`;
  if (fs.existsSync(path3)) fs.unlinkSync(path3);

  for (let i = MAX_ROTATED - 1; i >= 1; i--) {
    const src = `${LOG_PATH}.${i}`;
    const dst = `${LOG_PATH}.${i + 1}`;
    if (fs.existsSync(src)) fs.renameSync(src, dst);
  }

  fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
  logStream = openLogStream();
}

export function setupLogger(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  logStream = openLogStream();

  const write = (level: string, args: unknown[]) => {
    const timestamp = new Date().toISOString();
    const message = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    const formatted = `[${timestamp}] [${level}] ${message}`;
    const masked = maskSecrets(formatted);

    rotateIfNeeded();
    logStream?.write(masked + '\n');
  };

  console.log = (...args: unknown[]) => write('INFO', args);
  console.error = (...args: unknown[]) => write('ERROR', args);
  console.warn = (...args: unknown[]) => write('WARN', args);
}
