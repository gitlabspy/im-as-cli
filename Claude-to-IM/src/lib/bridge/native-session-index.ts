import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { BackendName, BridgeSessionTab } from './types.js';

export interface NativeSessionRoots {
  claudeProjectsDir?: string;
  codexSessionsDir?: string;
}

export interface ListNativeSessionTabsOptions {
  backend: BackendName;
  limit: number;
  roots?: NativeSessionRoots;
  maxSnippetChars?: number;
}

interface NativeSessionSummary {
  backend: BackendName;
  source: 'claude' | 'codex';
  nativeSessionId: string;
  workingDirectory: string;
  updatedAt: string;
  lastUserQuestion?: string;
  lastAgentOutput?: string;
}

const DEFAULT_SNIPPET_CHARS = 300;
const MAX_FILES_TO_SCAN = 200;

export function listNativeSessionTabs(options: ListNativeSessionTabsOptions): BridgeSessionTab[] {
  const limit = Math.max(0, options.limit);
  if (limit === 0) return [];

  const roots = resolveNativeSessionRoots(options.roots);
  const summaries = options.backend === 'codex'
    ? listCodexNativeSessions(roots.codexSessionsDir, limit, options.maxSnippetChars ?? DEFAULT_SNIPPET_CHARS)
    : options.backend === 'claudecode'
      ? listClaudeNativeSessions(roots.claudeProjectsDir, limit, options.maxSnippetChars ?? DEFAULT_SNIPPET_CHARS)
      : [];

  return summaries.map((summary) => nativeSummaryToTab(summary));
}

function resolveNativeSessionRoots(roots?: NativeSessionRoots): Required<NativeSessionRoots> {
  const home = os.homedir();
  return {
    claudeProjectsDir: roots?.claudeProjectsDir
      ?? process.env.CTI_CLAUDE_PROJECTS_DIR
      ?? path.join(home, '.claude', 'projects'),
    codexSessionsDir: roots?.codexSessionsDir
      ?? process.env.CTI_CODEX_SESSIONS_DIR
      ?? path.join(home, '.codex', 'sessions'),
  };
}

function listClaudeNativeSessions(root: string, limit: number, maxSnippetChars: number): NativeSessionSummary[] {
  return recentJsonlFiles(root, Math.min(MAX_FILES_TO_SCAN, Math.max(limit * 4, limit)))
    .map((filePath) => parseClaudeSessionFile(filePath, maxSnippetChars))
    .filter((summary): summary is NativeSessionSummary => summary !== null)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, limit);
}

function listCodexNativeSessions(root: string, limit: number, maxSnippetChars: number): NativeSessionSummary[] {
  return recentJsonlFiles(root, Math.min(MAX_FILES_TO_SCAN, Math.max(limit * 4, limit)))
    .map((filePath) => parseCodexSessionFile(filePath, maxSnippetChars))
    .filter((summary): summary is NativeSessionSummary => summary !== null)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, limit);
}

function recentJsonlFiles(root: string, limit: number): string[] {
  if (!fs.existsSync(root)) return [];
  const files: Array<{ filePath: string; mtimeMs: number }> = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          files.push({ filePath: fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs });
        } catch {
          continue;
        }
      }
    }
  }
  return files
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit)
    .map((file) => file.filePath);
}

function parseClaudeSessionFile(filePath: string, maxSnippetChars: number): NativeSessionSummary | null {
  const lines = readJsonlObjects(filePath);
  let nativeSessionId = path.basename(filePath, '.jsonl');
  let workingDirectory = '';
  let updatedAt = fileMtimeIso(filePath);
  let lastUserQuestion: string | undefined;
  let lastAgentOutput: string | undefined;

  for (const row of lines) {
    const record = asRecord(row);
    const sessionId = stringValue(record.sessionId);
    if (sessionId) nativeSessionId = sessionId;
    const cwd = stringValue(record.cwd);
    if (cwd) workingDirectory = cwd;
    const timestamp = stringValue(record.timestamp);
    if (timestamp) updatedAt = timestamp;

    const message = asRecord(record.message);
    const role = stringValue(message.role) || stringValue(record.type);
    const text = extractContentText(message.content ?? record.content);
    if (!text) continue;
    if (role === 'user') {
      lastUserQuestion = truncateSnippet(text, maxSnippetChars);
    } else if (role === 'assistant') {
      lastAgentOutput = truncateSnippet(text, maxSnippetChars);
    }
  }

  if (!nativeSessionId) return null;
  return {
    backend: 'claudecode',
    source: 'claude',
    nativeSessionId,
    workingDirectory,
    updatedAt,
    lastUserQuestion,
    lastAgentOutput,
  };
}

function parseCodexSessionFile(filePath: string, maxSnippetChars: number): NativeSessionSummary | null {
  const lines = readJsonlObjects(filePath);
  let nativeSessionId = path.basename(filePath, '.jsonl');
  let workingDirectory = '';
  let updatedAt = fileMtimeIso(filePath);
  let lastUserQuestion: string | undefined;
  let lastAgentOutput: string | undefined;

  for (const row of lines) {
    const record = asRecord(row);
    const timestamp = stringValue(record.timestamp);
    if (timestamp) updatedAt = timestamp;
    const payload = asRecord(record.payload);
    const payloadId = stringValue(payload.id);
    if (payloadId && (record.type === 'session_meta' || !nativeSessionId)) {
      nativeSessionId = payloadId;
    }
    const cwd = stringValue(payload.cwd);
    if (cwd) workingDirectory = cwd;
    const role = stringValue(payload.role);
    const payloadType = stringValue(payload.type);
    const text = extractContentText(payload.content ?? payload.message ?? payload.last_agent_message);
    if (!text) continue;
    if (role === 'user' || payloadType === 'user_message') {
      lastUserQuestion = truncateSnippet(text, maxSnippetChars);
    } else if (role === 'assistant' || payloadType === 'agent_message') {
      lastAgentOutput = truncateSnippet(text, maxSnippetChars);
    }
  }

  if (!nativeSessionId) return null;
  return {
    backend: 'codex',
    source: 'codex',
    nativeSessionId,
    workingDirectory,
    updatedAt,
    lastUserQuestion,
    lastAgentOutput,
  };
}

function nativeSummaryToTab(summary: NativeSessionSummary): BridgeSessionTab {
  const id = `native:${summary.backend}:${summary.nativeSessionId}`;
  return {
    id,
    codepilotSessionId: id,
    sdkSessionId: summary.nativeSessionId,
    workingDirectory: summary.workingDirectory,
    model: '',
    mode: 'code',
    backend: summary.backend,
    backendGeneration: 0,
    backendSessionIds: { [summary.backend]: id },
    backendSdkSessionIds: { [summary.backend]: summary.nativeSessionId },
    status: 'completed',
    unread: false,
    nativeSessionId: summary.nativeSessionId,
    nativeSource: summary.source,
    lastUserQuestion: summary.lastUserQuestion,
    lastAgentOutput: summary.lastAgentOutput,
    createdAt: summary.updatedAt,
    updatedAt: summary.updatedAt,
  };
}

function readJsonlObjects(filePath: string): unknown[] {
  try {
    return fs.readFileSync(filePath, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return null;
        }
      })
      .filter((item): item is unknown => item !== null);
  } catch {
    return [];
  }
}

function extractContentText(value: unknown): string {
  if (typeof value === 'string') return normalizeText(value);
  if (Array.isArray(value)) {
    return normalizeText(value.map((item) => extractContentText(item)).filter(Boolean).join('\n'));
  }
  const record = asRecord(value);
  const text = stringValue(record.text) || stringValue(record.content) || stringValue(record.output);
  return normalizeText(text);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateSnippet(text: string, maxChars: number): string {
  const normalized = normalizeText(text);
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized;
}

function fileMtimeIso(filePath: string): string {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}
