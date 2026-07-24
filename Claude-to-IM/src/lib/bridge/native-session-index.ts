import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { BackendName, BridgeSessionTab } from './types.js';

export interface NativeSessionRoots {
  claudeProjectsDir?: string;
  codexSessionsDir?: string;
}

export interface ListBackendSessionSummariesOptions {
  backend: BackendName;
  limit: number;
  roots?: NativeSessionRoots;
  maxSnippetChars?: number;
  includeHelperSessions?: boolean;
}

export interface ListNativeSessionTabsOptions extends ListBackendSessionSummariesOptions {}

export interface FindNativeSessionTranscriptSnippetsOptions {
  backend: BackendName;
  nativeSessionId: string;
  query: string;
  roots?: NativeSessionRoots;
  maxSnippetChars?: number;
  maxSnippets?: number;
}

export interface ReadNativeSessionTranscriptTailOptions {
  backend: BackendName;
  nativeSessionId: string;
  roots?: NativeSessionRoots;
  /** Hard cap on number of recent chat/tool entries returned. */
  maxEntries?: number;
  /** Hard cap on the total characters across returned entries. */
  maxChars?: number;
  /** Per-entry truncation cap. */
  maxEntryChars?: number;
}

export type NativeTranscriptEntryRole = 'user' | 'assistant' | 'tool' | 'other';

export interface NativeTranscriptEntry {
  role: NativeTranscriptEntryRole;
  /** Short display label, e.g. 'user', 'assistant', 'tool:Bash'. */
  label: string;
  text: string;
  at?: string;
}

export interface NativeSessionTranscriptTail {
  entries: NativeTranscriptEntry[];
  workingDirectory: string;
  lastActivityAt?: string;
  /** Total chat/tool events seen before truncation. */
  totalEvents: number;
  /** True when older events were dropped to fit the entry/char budget. */
  truncated: boolean;
}

export interface BackendSessionSummary {
  backend: BackendName;
  source: 'claude' | 'codex';
  nativeSessionId: string;
  identityKey: string;
  workingDirectory: string;
  activityAt: string;
  lastUserQuestion?: string;
  lastAgentOutput?: string;
  isHelperSession: boolean;
}

interface ParsedBackendSessionSummary extends BackendSessionSummary {
  lastUserQuestionAt?: string;
  lastAgentOutputAt?: string;
}

const DEFAULT_SNIPPET_CHARS = 300;
const DEFAULT_TAIL_ENTRIES = 50;
const DEFAULT_TAIL_CHARS = 20_000;
const DEFAULT_TAIL_ENTRY_CHARS = 800;
const SEARCH_HELPER_PROMPT = 'You are selecting the single most relevant existing coding-agent session';

export function listNativeSessionTabs(options: ListNativeSessionTabsOptions): BridgeSessionTab[] {
  return listBackendSessionSummaries(options).map((summary) => nativeSummaryToTab(summary));
}

export function findNativeSessionTranscriptSnippets(options: FindNativeSessionTranscriptSnippetsOptions): string[] {
  const nativeSessionId = options.nativeSessionId.trim();
  const tokens = tokenizeSnippetQuery(options.query);
  if (!nativeSessionId || tokens.length === 0) return [];

  const roots = resolveNativeSessionRoots(options.roots);
  const root = options.backend === 'codex'
    ? roots.codexSessionsDir
    : options.backend === 'claudecode'
      ? roots.claudeProjectsDir
      : '';
  if (!root) return [];

  const files = allJsonlFiles(root).filter((filePath) => nativeSessionPathMatches(filePath, nativeSessionId));
  const snippets: string[] = [];
  for (const filePath of files) {
    for (const row of readJsonlObjects(filePath)) {
      const text = extractTranscriptSearchText(row);
      if (!text) continue;
      const snippet = snippetForTokens(text, tokens, options.maxSnippetChars ?? DEFAULT_SNIPPET_CHARS);
      if (!snippet) continue;
      snippets.push(snippet);
      if (snippets.length >= (options.maxSnippets ?? 3)) return snippets;
    }
  }
  return snippets;
}

/**
 * Read the most recent chat/tool events from a native session transcript.
 *
 * Used by `/peek` to summarize the latest activity in a session WITHOUT
 * loading the full transcript into a prompt. The result is strictly bounded
 * by `maxEntries` and `maxChars` (newest-first while collecting, returned
 * oldest-first) so callers can hand it to a model safely.
 */
export function readNativeSessionTranscriptTail(
  options: ReadNativeSessionTranscriptTailOptions,
): NativeSessionTranscriptTail {
  const empty: NativeSessionTranscriptTail = {
    entries: [],
    workingDirectory: '',
    lastActivityAt: undefined,
    totalEvents: 0,
    truncated: false,
  };

  const nativeSessionId = options.nativeSessionId.trim();
  if (!nativeSessionId) return empty;

  const roots = resolveNativeSessionRoots(options.roots);
  const root = options.backend === 'codex'
    ? roots.codexSessionsDir
    : options.backend === 'claudecode'
      ? roots.claudeProjectsDir
      : '';
  if (!root) return empty;

  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_TAIL_ENTRIES);
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_TAIL_CHARS);
  const maxEntryChars = Math.max(1, options.maxEntryChars ?? DEFAULT_TAIL_ENTRY_CHARS);

  const files = allJsonlFiles(root);
  const all: NativeTranscriptEntry[] = [];
  let workingDirectory = '';
  for (const filePath of files) {
    const rows = readJsonlObjects(filePath);
    if (!transcriptRowsMatchSession(rows, filePath, options.backend, nativeSessionId)) continue;
    for (const row of rows) {
      const cwd = extractTranscriptCwd(row, options.backend);
      if (cwd) workingDirectory = cwd;
      const entry = extractTranscriptEntry(row, options.backend, maxEntryChars);
      if (entry) all.push(entry);
    }
  }

  const totalEvents = all.length;
  // Take the newest `maxEntries`, then trim from the front until under maxChars.
  let selected = all.slice(Math.max(0, all.length - maxEntries));
  let truncated = selected.length < totalEvents;
  let totalLength = selected.reduce((sum, entry) => sum + entry.text.length, 0);
  while (selected.length > 1 && totalLength > maxChars) {
    const dropped = selected.shift()!;
    totalLength -= dropped.text.length;
    truncated = true;
  }

  const lastActivityAt = [...selected].reverse().find((entry) => entry.at)?.at;
  return {
    entries: selected,
    workingDirectory,
    lastActivityAt,
    totalEvents,
    truncated,
  };
}

export function listBackendSessionSummaries(options: ListBackendSessionSummariesOptions): BackendSessionSummary[] {
  const limit = Math.max(0, options.limit);
  if (limit === 0) return [];

  const roots = resolveNativeSessionRoots(options.roots);
  const summaries = options.backend === 'codex'
    ? listCodexNativeSessions(roots.codexSessionsDir, options.maxSnippetChars ?? DEFAULT_SNIPPET_CHARS)
    : options.backend === 'claudecode'
      ? listClaudeNativeSessions(roots.claudeProjectsDir, options.maxSnippetChars ?? DEFAULT_SNIPPET_CHARS)
      : [];

  return summaries
    .filter((summary) => options.includeHelperSessions || !summary.isHelperSession)
    .sort((left, right) => Date.parse(right.activityAt) - Date.parse(left.activityAt))
    .slice(0, limit)
    .map(stripParsedFields);
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

function listClaudeNativeSessions(root: string, maxSnippetChars: number): ParsedBackendSessionSummary[] {
  return mergeBackendSessionSummaries(allJsonlFiles(root)
    .map((filePath) => parseClaudeSessionFile(filePath, maxSnippetChars))
    .filter((summary): summary is ParsedBackendSessionSummary => summary !== null));
}

function listCodexNativeSessions(root: string, maxSnippetChars: number): ParsedBackendSessionSummary[] {
  return mergeBackendSessionSummaries(allJsonlFiles(root)
    .map((filePath) => parseCodexSessionFile(filePath, maxSnippetChars))
    .filter((summary): summary is ParsedBackendSessionSummary => summary !== null));
}

function allJsonlFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
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
        files.push(fullPath);
      }
    }
  }
  return files;
}

function nativeSessionPathMatches(filePath: string, nativeSessionId: string): boolean {
  return path.basename(filePath, '.jsonl') === nativeSessionId
    || filePath.split(path.sep).includes(nativeSessionId);
}

/**
 * Decide whether a transcript file belongs to `nativeSessionId`.
 *
 * Claude names files after the session id, but Codex rollout files are named
 * by timestamp and carry the id inside the `session_meta` payload (or each
 * row's `sessionId`). Match on the path first, then fall back to content.
 */
function transcriptRowsMatchSession(
  rows: unknown[],
  filePath: string,
  backend: BackendName,
  nativeSessionId: string,
): boolean {
  if (nativeSessionPathMatches(filePath, nativeSessionId)) return true;
  for (const row of rows) {
    const record = asRecord(row);
    if (backend === 'codex') {
      if (stringValue(asRecord(record.payload).id) === nativeSessionId) return true;
    } else if (stringValue(record.sessionId) === nativeSessionId) {
      return true;
    }
  }
  return false;
}

function parseClaudeSessionFile(filePath: string, maxSnippetChars: number): ParsedBackendSessionSummary | null {
  const lines = readJsonlObjects(filePath);
  let nativeSessionId = path.basename(filePath, '.jsonl');
  let workingDirectory = '';
  let activityAt = new Date(0).toISOString();
  let lastUserQuestion: string | undefined;
  let lastAgentOutput: string | undefined;
  let lastUserQuestionAt: string | undefined;
  let lastAgentOutputAt: string | undefined;
  let isHelperSession = false;

  for (const row of lines) {
    const record = asRecord(row);
    const sessionId = stringValue(record.sessionId);
    if (sessionId) nativeSessionId = sessionId;
    const cwd = stringValue(record.cwd);
    if (cwd) workingDirectory = cwd;
    const timestamp = stringValue(record.timestamp);

    const message = asRecord(record.message);
    const role = stringValue(message.role) || stringValue(record.type);
    const text = extractContentText(message.content ?? record.content);
    if (text.includes(SEARCH_HELPER_PROMPT)) isHelperSession = true;
    if (!text) continue;
    if (role === 'user') {
      lastUserQuestion = truncateSnippet(text, maxSnippetChars);
      lastUserQuestionAt = timestamp || lastUserQuestionAt;
      if (timestamp) activityAt = maxIsoTimestamp(activityAt, timestamp);
    } else if (role === 'assistant') {
      lastAgentOutput = truncateSnippet(text, maxSnippetChars);
      lastAgentOutputAt = timestamp || lastAgentOutputAt;
      if (timestamp) activityAt = maxIsoTimestamp(activityAt, timestamp);
    }
  }

  if (!nativeSessionId || (!lastUserQuestion && !lastAgentOutput)) return null;
  const backend: BackendName = 'claudecode';
  return {
    backend,
    source: 'claude',
    nativeSessionId,
    identityKey: backendSessionIdentityKey(backend, nativeSessionId),
    workingDirectory,
    activityAt,
    lastUserQuestion,
    lastAgentOutput,
    isHelperSession,
    lastUserQuestionAt,
    lastAgentOutputAt,
  };
}

function parseCodexSessionFile(filePath: string, maxSnippetChars: number): ParsedBackendSessionSummary | null {
  const lines = readJsonlObjects(filePath);
  let nativeSessionId = path.basename(filePath, '.jsonl');
  let workingDirectory = '';
  let activityAt = new Date(0).toISOString();
  let lastUserQuestion: string | undefined;
  let lastAgentOutput: string | undefined;
  let lastUserQuestionAt: string | undefined;
  let lastAgentOutputAt: string | undefined;
  let isHelperSession = false;

  for (const row of lines) {
    const record = asRecord(row);
    const timestamp = stringValue(record.timestamp);
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
    if (text.includes(SEARCH_HELPER_PROMPT)) isHelperSession = true;
    if (!text) continue;
    if (role === 'user' || payloadType === 'user_message') {
      lastUserQuestion = truncateSnippet(text, maxSnippetChars);
      lastUserQuestionAt = timestamp || lastUserQuestionAt;
      if (timestamp) activityAt = maxIsoTimestamp(activityAt, timestamp);
    } else if (role === 'assistant' || payloadType === 'agent_message') {
      lastAgentOutput = truncateSnippet(text, maxSnippetChars);
      lastAgentOutputAt = timestamp || lastAgentOutputAt;
      if (timestamp) activityAt = maxIsoTimestamp(activityAt, timestamp);
    }
  }

  if (!nativeSessionId || (!lastUserQuestion && !lastAgentOutput)) return null;
  const backend: BackendName = 'codex';
  return {
    backend,
    source: 'codex',
    nativeSessionId,
    identityKey: backendSessionIdentityKey(backend, nativeSessionId),
    workingDirectory,
    activityAt,
    lastUserQuestion,
    lastAgentOutput,
    isHelperSession,
    lastUserQuestionAt,
    lastAgentOutputAt,
  };
}

function nativeSummaryToTab(summary: BackendSessionSummary): BridgeSessionTab {
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
    activityAt: summary.activityAt,
    createdAt: summary.activityAt,
    updatedAt: summary.activityAt,
  };
}

function mergeBackendSessionSummaries(summaries: ParsedBackendSessionSummary[]): ParsedBackendSessionSummary[] {
  const byIdentity = new Map<string, ParsedBackendSessionSummary>();
  for (const summary of summaries) {
    const existing = byIdentity.get(summary.identityKey);
    if (!existing) {
      byIdentity.set(summary.identityKey, { ...summary });
      continue;
    }
    existing.workingDirectory = summary.workingDirectory || existing.workingDirectory;
    existing.activityAt = maxIsoTimestamp(existing.activityAt, summary.activityAt);
    existing.isHelperSession = existing.isHelperSession || summary.isHelperSession;
    if (isNewerTimestamp(summary.lastUserQuestionAt, existing.lastUserQuestionAt)) {
      existing.lastUserQuestion = summary.lastUserQuestion;
      existing.lastUserQuestionAt = summary.lastUserQuestionAt;
    }
    if (isNewerTimestamp(summary.lastAgentOutputAt, existing.lastAgentOutputAt)) {
      existing.lastAgentOutput = summary.lastAgentOutput;
      existing.lastAgentOutputAt = summary.lastAgentOutputAt;
    }
  }
  return [...byIdentity.values()];
}

function stripParsedFields(summary: ParsedBackendSessionSummary): BackendSessionSummary {
  return {
    backend: summary.backend,
    source: summary.source,
    nativeSessionId: summary.nativeSessionId,
    identityKey: summary.identityKey,
    workingDirectory: summary.workingDirectory,
    activityAt: summary.activityAt,
    lastUserQuestion: summary.lastUserQuestion,
    lastAgentOutput: summary.lastAgentOutput,
    isHelperSession: summary.isHelperSession,
  };
}

function backendSessionIdentityKey(backend: BackendName, nativeSessionId: string): string {
  return `${backend}:${nativeSessionId}`;
}

function maxIsoTimestamp(left: string, right: string): string {
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function isNewerTimestamp(candidate?: string, current?: string): boolean {
  if (!candidate) return false;
  if (!current) return true;
  return Date.parse(candidate) > Date.parse(current);
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

/** Extract the working directory recorded on a transcript row, if present. */
function extractTranscriptCwd(value: unknown, backend: BackendName): string {
  const record = asRecord(value);
  if (backend === 'codex') {
    return stringValue(asRecord(record.payload).cwd);
  }
  return stringValue(record.cwd);
}

/**
 * Extract one recent chat/tool entry from a transcript row, or null when the
 * row carries no user/assistant/tool content. Text is truncated per entry.
 */
function extractTranscriptEntry(
  value: unknown,
  backend: BackendName,
  maxEntryChars: number,
): NativeTranscriptEntry | null {
  const record = asRecord(value);
  const timestamp = stringValue(record.timestamp) || undefined;

  if (backend === 'codex') {
    const payload = asRecord(record.payload);
    const role = stringValue(payload.role);
    const payloadType = stringValue(payload.type);
    if (payloadType === 'function_call' || payloadType === 'local_shell_call' || payloadType === 'custom_tool_call') {
      const name = stringValue(payload.name) || payloadType;
      const args = normalizeText(extractDeepStringText(payload.arguments ?? payload.action ?? payload.input));
      const text = truncateSnippet(args ? `${name} ${args}` : name, maxEntryChars);
      return { role: 'tool', label: `tool:${name}`, text, at: timestamp };
    }
    if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
      const out = normalizeText(extractDeepStringText(payload.output ?? payload.result));
      if (!out) return null;
      return { role: 'tool', label: 'tool:result', text: truncateSnippet(out, maxEntryChars), at: timestamp };
    }
    const text = extractContentText(payload.content ?? payload.message ?? payload.last_agent_message);
    if (!text) return null;
    if (role === 'user' || payloadType === 'user_message') {
      return { role: 'user', label: 'user', text: truncateSnippet(text, maxEntryChars), at: timestamp };
    }
    if (role === 'assistant' || payloadType === 'agent_message') {
      return { role: 'assistant', label: 'assistant', text: truncateSnippet(text, maxEntryChars), at: timestamp };
    }
    return null;
  }

  // Claude transcripts: role on message.role (fallback record.type).
  const message = asRecord(record.message);
  const role = stringValue(message.role) || stringValue(record.type);
  const content = message.content ?? record.content;
  const text = extractContentText(content);
  const toolNames = extractClaudeToolNames(content);

  if (role === 'assistant') {
    const note = toolNames.length > 0 ? `[tools: ${toolNames.join(', ')}]` : '';
    const combined = [text, note].filter(Boolean).join(' ');
    if (!combined) return null;
    return { role: 'assistant', label: 'assistant', text: truncateSnippet(combined, maxEntryChars), at: timestamp };
  }
  if (role === 'user') {
    if (!text) return null;
    return { role: 'user', label: 'user', text: truncateSnippet(text, maxEntryChars), at: timestamp };
  }
  return null;
}

/** Collect Claude `tool_use` block names from a message content array. */
function extractClaudeToolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (stringValue(record.type) === 'tool_use') {
      const name = stringValue(record.name);
      if (name) names.push(name);
    }
  }
  return [...new Set(names)];
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

function tokenizeSnippetQuery(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2))];
}

function extractTranscriptSearchText(value: unknown): string {
  return normalizeText(extractDeepStringText(value));
}

function extractDeepStringText(value: unknown, depth = 0): string {
  if (depth > 8 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => extractDeepStringText(item, depth + 1)).filter(Boolean).join('\n');
  }
  if (typeof value !== 'object') return '';
  return Object.values(value as Record<string, unknown>)
    .map((item) => extractDeepStringText(item, depth + 1))
    .filter(Boolean)
    .join('\n');
}

function snippetForTokens(text: string, tokens: string[], maxChars: number): string | null {
  const normalized = normalizeText(text);
  const haystack = normalized.toLowerCase();
  const firstMatch = tokens
    .map((token) => haystack.indexOf(token))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (firstMatch === undefined) return null;

  const halfWindow = Math.floor(maxChars / 2);
  const start = Math.max(0, firstMatch - halfWindow);
  const end = Math.min(normalized.length, start + maxChars);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < normalized.length ? '…' : '';
  return `${prefix}${normalized.slice(start, end)}${suffix}`;
}
