/**
 * Bridge Manager — singleton orchestrator for the multi-IM bridge system.
 *
 * Manages adapter lifecycles, routes inbound messages through the
 * conversation engine, and coordinates permission handling.
 *
 * Uses globalThis to survive Next.js HMR in development.
 */

import type { BackendName, BridgeSessionTab, BridgeStatus, ChannelBinding, InboundMessage, OutboundMessage, StreamingPreviewState } from './types.js';
import type { TokenUsage } from './host.js';
import { createAdapter, getRegisteredTypes } from './channel-adapter.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
// Side-effect import: triggers self-registration of all adapter factories
import './adapters/index.js';
import * as router from './channel-router.js';
import * as engine from './conversation-engine.js';
import * as broker from './permission-broker.js';
import { deliver, deliverRendered } from './delivery-layer.js';
import { markdownToTelegramChunks } from './markdown/telegram.js';
import { markdownToDiscordChunks } from './markdown/discord.js';
import { splitFinalReply, splitFinalReplyBody } from './markdown/split.js';
import { buildFinalCardJson, buildFinalReplyFooterText, buildPeekCard, buildSearchResultCard, buildTabsChoiceCard, formatElapsed } from './markdown/feishu.js';
import type { FeishuPeekRisk } from './markdown/feishu.js';
import { getBridgeContext } from './context.js';
import { escapeHtml } from './adapters/telegram-utils.js';
import { findNativeSessionTranscriptSnippets, listNativeSessionTabs, readNativeSessionTranscriptTail } from './native-session-index.js';
import type { NativeSessionTranscriptTail } from './native-session-index.js';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './security/validators.js';

const GLOBAL_KEY = '__bridge_manager__';

// ── Streaming preview helpers ──────────────────────────────────

/** Generate a non-zero random 31-bit integer for use as draft_id. */
function generateDraftId(): number {
  return (Math.floor(Math.random() * 0x7FFFFFFE) + 1); // 1 .. 2^31-1
}

interface StreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}

/** Default stream config per channel type. */
const STREAM_DEFAULTS: Record<string, StreamConfig> = {
  telegram: { intervalMs: 700, minDeltaChars: 20, maxChars: 3900 },
  discord: { intervalMs: 1500, minDeltaChars: 40, maxChars: 1900 },
};

function getStreamConfig(channelType = 'telegram'): StreamConfig {
  const { store } = getBridgeContext();
  const defaults = STREAM_DEFAULTS[channelType] || STREAM_DEFAULTS.telegram;
  const prefix = `bridge_${channelType}_stream_`;
  const intervalMs = parseInt(store.getSetting(`${prefix}interval_ms`) || '', 10) || defaults.intervalMs;
  const minDeltaChars = parseInt(store.getSetting(`${prefix}min_delta_chars`) || '', 10) || defaults.minDeltaChars;
  const maxChars = parseInt(store.getSetting(`${prefix}max_chars`) || '', 10) || defaults.maxChars;
  return { intervalMs, minDeltaChars, maxChars };
}

/**
 * Check if a message looks like a numeric permission shortcut (1/2/3) for
 * feishu/qq channels WITH at least one pending permission in that chat.
 *
 * This is used by the adapter loop to route these messages to the inline
 * (non-session-locked) path, avoiding deadlock: the session is blocked
 * waiting for the permission to be resolved, so putting "1" behind the
 * session lock would deadlock.
 */
function isNumericPermissionShortcut(channelType: string, rawText: string, chatId: string): boolean {
  if (channelType !== 'feishu' && channelType !== 'qq' && channelType !== 'weixin') return false;
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!/^[123]$/.test(normalized)) return false;
  const { store } = getBridgeContext();
  const pending = store.listPendingPermissionLinksByChat(chatId);
  return pending.length > 0; // any pending → route to inline path
}

// ── Backend lane helpers ──────────────────────────────────────

/**
 * Compute the per-backend task lane key for a binding.
 *
 * Active-task tracking and session locks key off this string instead of the
 * raw `codepilotSessionId`, so that switching backends via `/backend` swaps
 * to a fresh lane without being blocked by the previous backend's in-flight
 * lock or active task.
 */
function laneKey(binding: ChannelBinding): string {
  return `${binding.id}:${binding.backend ?? 'claudecode'}:${binding.codepilotSessionId}`;
}

function tabLaneKey(bindingId: string, tab: BridgeSessionTab): string {
  return `${bindingId}:${tab.backend ?? 'claudecode'}:${tab.codepilotSessionId}`;
}

const NATIVE_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DEFAULT_TABS_LIMIT = 10;
const MAX_TABS_LIMIT = 50;
const TABS_SNIPPET_CHARS = 20;
const SEARCH_AGENT_MAX_CANDIDATES = MAX_TABS_LIMIT;
const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_AGENT_HISTORY_LIMIT = 6;
const SEARCH_AGENT_CONTEXT_CHARS = 900;
const SEARCH_LAST_USER_QUESTION_CHARS = 300;
const SEARCH_LAST_AGENT_OUTPUT_CHARS = 300;
const SEARCH_NATIVE_TRANSCRIPT_SNIPPET_CHARS = 300;
const SEARCH_NATIVE_TRANSCRIPT_SNIPPETS = 3;
const SEARCH_AGENT_TIMEOUT_MS = 45_000;
const SEARCH_RESULT_TTL_MS = 10 * 60_000;
const SEARCH_AGENT_MIN_CONFIDENCE = 0.2;

// ── /peek constants ───────────────────────────────────────────
const PEEK_TAIL_ENTRIES = 50;
const PEEK_TAIL_CHARS = 20_000;
const PEEK_TAIL_ENTRY_CHARS = 800;
/** Hard cap on the transcript text handed to the summarizer prompt. */
const PEEK_PROMPT_TRANSCRIPT_CHARS = 6_000;
const PEEK_SUMMARY_MAX_CHARS = 1_200;
const PEEK_AGENT_TIMEOUT_MS = 30_000;

function validateNativeSessionId(id: string): boolean {
  return NATIVE_SESSION_ID_PATTERN.test(id.trim());
}

function getActiveBackend(binding: ChannelBinding): BackendName {
  return binding.backend ?? 'claudecode';
}
function parseTabsLimit(args: string): number {
  const trimmed = args.trim();
  if (!trimmed) return DEFAULT_TABS_LIMIT;

  const value = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(value) || String(value) !== trimmed || value < 1) {
    return DEFAULT_TABS_LIMIT;
  }
  return Math.min(value, MAX_TABS_LIMIT);
}

function parseSearchArgs(args: string): { query: string; limit: number } {
  const trimmed = args.trim();
  if (!trimmed) return { query: '', limit: SEARCH_DEFAULT_LIMIT };
  const match = trimmed.match(/^(.*\S)\s+(\d+)$/);
  if (!match) return { query: trimmed, limit: SEARCH_DEFAULT_LIMIT };
  const requested = Number.parseInt(match[2], 10);
  if (!Number.isInteger(requested) || requested < 1) {
    return { query: trimmed, limit: SEARCH_DEFAULT_LIMIT };
  }
  return { query: match[1].trim(), limit: Math.min(requested, MAX_TABS_LIMIT) };
}

function tabBackend(tab: BridgeSessionTab): BackendName {
  return tab.backend ?? 'claudecode';
}

function tabUpdatedAtMs(tab: BridgeSessionTab): number {
  const value = Date.parse(tab.updatedAt);
  return Number.isFinite(value) ? value : 0;
}

function tabActivityAtMs(tab: BridgeSessionTab): number {
  const value = Date.parse(tab.activityAt ?? tab.createdAt);
  return Number.isFinite(value) ? value : 0;
}

function tabHasChatActivity(tab: BridgeSessionTab): boolean {
  const value = Date.parse(tab.activityAt ?? '');
  return Number.isFinite(value);
}

function tabBackendSessionId(tab: BridgeSessionTab): string | undefined {
  const backend = tabBackend(tab);
  return tab.nativeSessionId
    || tab.backendSdkSessionIds?.[backend]
    || tab.sdkSessionId
    || undefined;
}

function currentBackendRecentSessionTabs(
  binding: ChannelBinding,
  tabs: BridgeSessionTab[],
  limit: number,
): BridgeSessionTab[] {
  const backend = getActiveBackend(binding);
  return [...tabs]
    .filter((tab) => tabBackend(tab) === backend)
    .sort((left, right) => {
      const diff = tabActivityAtMs(right) - tabActivityAtMs(left);
      if (diff !== 0) return diff;
      return right.id.localeCompare(left.id);
    })
    .slice(0, limit);
}

function tabIdentityKey(tab: BridgeSessionTab): string {
  const backendSessionId = tabBackendSessionId(tab);
  if (backendSessionId) return `${tabBackend(tab)}:${backendSessionId}`;
  return `${tabBackend(tab)}:bridge:${tab.codepilotSessionId}`;
}

function hasBridgeWrapper(tab: BridgeSessionTab): boolean {
  return !tab.codepilotSessionId.startsWith('native:');
}

function mergeSessionTabsByIdentity(left: BridgeSessionTab, right: BridgeSessionTab): BridgeSessionTab {
  const leftHasWrapper = hasBridgeWrapper(left);
  const rightHasWrapper = hasBridgeWrapper(right);
  if (leftHasWrapper !== rightHasWrapper) {
    const wrapper = leftHasWrapper ? left : right;
    const backendSession = leftHasWrapper ? right : left;
    const activityAt = tabActivityAtMs(wrapper) > tabActivityAtMs(backendSession)
      ? wrapper.activityAt
      : backendSession.activityAt;
    return {
      ...backendSession,
      ...wrapper,
      nativeSessionId: backendSession.nativeSessionId ?? tabBackendSessionId(wrapper),
      nativeSource: backendSession.nativeSource ?? wrapper.nativeSource,
      lastUserQuestion: backendSession.lastUserQuestion ?? wrapper.lastUserQuestion,
      lastAgentOutput: backendSession.lastAgentOutput ?? wrapper.lastAgentOutput,
      activityAt,
      updatedAt: tabUpdatedAtMs(wrapper) > tabUpdatedAtMs(backendSession)
        ? wrapper.updatedAt
        : backendSession.updatedAt,
    };
  }

  return tabUpdatedAtMs(right) > tabUpdatedAtMs(left)
    ? { ...left, ...right }
    : { ...right, ...left };
}

function dedupeSessionTabsByIdentity(tabs: BridgeSessionTab[]): BridgeSessionTab[] {
  const byIdentity = new Map<string, BridgeSessionTab>();
  for (const tab of tabs) {
    const key = tabIdentityKey(tab);
    const existing = byIdentity.get(key);
    if (!existing) {
      byIdentity.set(key, tab);
    } else {
      byIdentity.set(key, mergeSessionTabsByIdentity(existing, tab));
    }
  }
  return [...byIdentity.values()];
}

function mergedSessionTabCandidates(binding: ChannelBinding, nativeLimit: number): BridgeSessionTab[] {
  const { store } = getBridgeContext();
  const allBindings = store.listChannelBindings();
  const bindings = allBindings.some((candidate) => candidate.id === binding.id)
    ? allBindings
    : [...allBindings, binding];
  const bridgeCandidates = bindings.flatMap(readSessionTabsForListing);
  const nativeCandidates = listNativeSessionTabs({
    backend: getActiveBackend(binding),
    limit: Math.min(nativeLimit, MAX_TABS_LIMIT),
    maxSnippetChars: SEARCH_LAST_AGENT_OUTPUT_CHARS,
  });
  return dedupeSessionTabsByIdentity([...bridgeCandidates, ...nativeCandidates]);
}

function mergedCurrentBackendRecentSessionTabs(binding: ChannelBinding, limit: number): BridgeSessionTab[] {
  return currentBackendRecentSessionTabs(
    binding,
    mergedSessionTabCandidates(binding, limit),
    limit,
  );
}

function mergedCurrentBackendRecentChatSessionTabs(binding: ChannelBinding, limit: number): BridgeSessionTab[] {
  return currentBackendRecentSessionTabs(
    binding,
    mergedSessionTabCandidates(binding, MAX_TABS_LIMIT).filter(tabHasChatActivity),
    limit,
  );
}

function readSessionTabsForListing(binding: ChannelBinding): BridgeSessionTab[] {
  const tabs = [...(binding.sessionTabs ?? [])];
  const activeTabId = binding.activeSessionTabId;
  const currentIndex = tabs.findIndex((tab) =>
    tab.id === activeTabId || tab.codepilotSessionId === binding.codepilotSessionId);

  if (currentIndex >= 0) {
    const existing = tabs[currentIndex];
    tabs[currentIndex] = snapshotBindingAsTab(binding, {
      id: existing.id,
      status: existing.status ?? 'idle',
      bufferedResponseText: existing.bufferedResponseText,
      bufferedErrorMessage: existing.bufferedErrorMessage,
      bufferedAt: existing.bufferedAt,
      unread: existing.unread ?? false,
      createdAt: existing.createdAt,
      activityAt: existing.activityAt,
      updatedAt: existing.updatedAt,
    });
  } else {
    tabs.push(snapshotBindingAsTab(binding, {
      id: binding.activeSessionTabId ?? binding.codepilotSessionId,
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt ?? binding.createdAt,
    }));
  }

  return tabs;
}

function listCurrentBackendRecentSessionTabs(binding: ChannelBinding, limit: number): BridgeSessionTab[] {
  return mergedCurrentBackendRecentChatSessionTabs(binding, limit);
}

function tabListingKey(binding: ChannelBinding): string {
  return binding.id;
}

function rememberTabListing(binding: ChannelBinding, tabs: BridgeSessionTab[]): void {
  getState().tabListings.set(tabListingKey(binding), {
    backend: getActiveBackend(binding),
    tabs: [...tabs],
  });
}

function getRememberedTabListing(binding: ChannelBinding): BridgeSessionTab[] | null {
  const entry = getState().tabListings.get(tabListingKey(binding));
  if (!entry || entry.backend !== getActiveBackend(binding)) return null;
  return [...entry.tabs];
}


function getActiveNativeSessionId(binding: ChannelBinding): string {
  const backend = getActiveBackend(binding);
  return binding.backendSdkSessionIds?.[backend] ?? binding.sdkSessionId ?? '';
}

function snapshotBindingAsTab(
  binding: ChannelBinding,
  overrides: Partial<BridgeSessionTab> = {},
): BridgeSessionTab {
  const now = new Date().toISOString();
  const backend = overrides.backend ?? getActiveBackend(binding);
  const codepilotSessionId = overrides.codepilotSessionId ?? binding.codepilotSessionId;
  return {
    id: overrides.id ?? binding.activeSessionTabId ?? codepilotSessionId,
    codepilotSessionId,
    sdkSessionId: overrides.sdkSessionId ?? binding.sdkSessionId ?? '',
    workingDirectory: overrides.workingDirectory ?? binding.workingDirectory,
    model: overrides.model ?? binding.model,
    mode: overrides.mode ?? binding.mode,
    backend,
    backendGeneration: overrides.backendGeneration ?? binding.backendGeneration ?? 0,
    backendSessionIds: overrides.backendSessionIds
      ?? binding.backendSessionIds
      ?? ({ [backend]: codepilotSessionId } as Partial<Record<BackendName, string>>),
    backendSdkSessionIds: overrides.backendSdkSessionIds ?? binding.backendSdkSessionIds ?? {},
    outputVerbosity: overrides.outputVerbosity ?? binding.outputVerbosity ?? 'normal',
    sandboxLevel: overrides.sandboxLevel ?? binding.sandboxLevel ?? 'rw',
    status: overrides.status ?? 'idle',
    bufferedResponseText: overrides.bufferedResponseText ?? '',
    bufferedErrorMessage: overrides.bufferedErrorMessage ?? '',
    bufferedAt: overrides.bufferedAt,
    unread: overrides.unread ?? false,
    createdAt: overrides.createdAt ?? binding.createdAt ?? now,
    activityAt: overrides.activityAt,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function normalizeSessionTabs(binding: ChannelBinding): BridgeSessionTab[] {
  const tabs = [...(binding.sessionTabs ?? [])];
  const activeTabId = binding.activeSessionTabId;
  const currentIndex = tabs.findIndex((tab) =>
    tab.id === activeTabId || tab.codepilotSessionId === binding.codepilotSessionId);

  if (currentIndex >= 0) {
    const existing = tabs[currentIndex];
    tabs[currentIndex] = snapshotBindingAsTab(binding, {
      id: existing.id,
      status: existing.status ?? 'idle',
      bufferedResponseText: existing.bufferedResponseText,
      bufferedErrorMessage: existing.bufferedErrorMessage,
      bufferedAt: existing.bufferedAt,
      unread: existing.unread ?? false,
      createdAt: existing.createdAt,
      activityAt: existing.activityAt,
      updatedAt: existing.updatedAt,
    });
  } else {
    tabs.push(snapshotBindingAsTab(binding, { id: binding.codepilotSessionId }));
  }

  const nextActiveId = activeTabId && tabs.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : tabs.find((tab) => tab.codepilotSessionId === binding.codepilotSessionId)?.id ?? tabs[0]!.id;

  binding.sessionTabs = tabs;
  binding.activeSessionTabId = nextActiveId;
  router.updateBinding(binding.id, { sessionTabs: tabs, activeSessionTabId: nextActiveId });
  return tabs;
}

function upsertSessionTab(
  binding: ChannelBinding,
  tab: BridgeSessionTab,
  activeSessionTabId = binding.activeSessionTabId,
): BridgeSessionTab[] {
  const tabs = normalizeSessionTabs(binding);
  const index = tabs.findIndex((existing) =>
    existing.id === tab.id || existing.codepilotSessionId === tab.codepilotSessionId);
  const nextTab = { ...tab, updatedAt: new Date().toISOString() };
  if (index >= 0) {
    tabs[index] = { ...tabs[index], ...nextTab };
  } else {
    tabs.push(nextTab);
  }
  binding.sessionTabs = tabs;
  binding.activeSessionTabId = activeSessionTabId;
  router.updateBinding(binding.id, { sessionTabs: tabs, activeSessionTabId });
  return tabs;
}

function updateSessionTab(
  binding: ChannelBinding,
  tabId: string,
  updates: Partial<BridgeSessionTab>,
): BridgeSessionTab | null {
  const tabs = normalizeSessionTabs(binding);
  const index = tabs.findIndex((tab) => tab.id === tabId || tab.codepilotSessionId === tabId);
  if (index < 0) return null;
  tabs[index] = { ...tabs[index], ...updates, updatedAt: new Date().toISOString() };
  binding.sessionTabs = tabs;
  router.updateBinding(binding.id, { sessionTabs: tabs, activeSessionTabId: binding.activeSessionTabId });
  return tabs[index];
}

function getCurrentBindingForOutput(binding: ChannelBinding): ChannelBinding | null {
  const { store } = getBridgeContext();
  return store.getChannelBinding(binding.channelType, binding.chatId);
}

function isActiveOutputTarget(binding: ChannelBinding): boolean {
  const current = getCurrentBindingForOutput(binding);
  return current?.codepilotSessionId === binding.codepilotSessionId
    && (current.backend ?? 'claudecode') === (binding.backend ?? 'claudecode');
}

function getTabRuntimeStatus(binding: ChannelBinding, tab: BridgeSessionTab): BridgeSessionTab['status'] {
  const state = getState();
  if (state.activeTasks.has(tabLaneKey(binding.id, tab))) return 'running';
  if (tab.status === 'running') return 'unavailable';
  return tab.status ?? 'idle';
}

function isCurrentSessionTab(binding: ChannelBinding, tab: BridgeSessionTab): boolean {
  const activeId = binding.activeSessionTabId ?? binding.codepilotSessionId;
  return tab.id === activeId || tab.codepilotSessionId === binding.codepilotSessionId;
}

function makeTabSwitchCallbackData(binding: ChannelBinding, tab: BridgeSessionTab): string {
  return `tabs:switch:${encodeURIComponent(binding.id)}:${encodeURIComponent(tab.id)}`;
}

function parseTabSwitchCallbackData(callbackData: string): { bindingId: string; tabId: string } | null {
  const prefix = 'tabs:switch:';
  if (!callbackData.startsWith(prefix)) return null;
  const rest = callbackData.slice(prefix.length);
  const separatorIndex = rest.indexOf(':');
  if (separatorIndex < 0) return { bindingId: '', tabId: '' };
  try {
    return {
      bindingId: decodeURIComponent(rest.slice(0, separatorIndex)),
      tabId: decodeURIComponent(rest.slice(separatorIndex + 1)),
    };
  } catch {
    return { bindingId: '', tabId: '' };
  }
}

function buildTabSnippets(tab: BridgeSessionTab): { lastUserQuestion?: string; lastAgentOutput?: string } {
  const { store } = getBridgeContext();
  const messages = store.getMessages(tab.codepilotSessionId).messages;
  const lastUserQuestion = [...messages]
    .reverse()
    .find((message) => message.role.toLowerCase() === 'user' && extractSearchText(message.content));
  const lastAgentOutput = [...messages]
    .reverse()
    .find((message) => message.role.toLowerCase() === 'assistant' && extractSearchText(message.content));
  const userText = lastUserQuestion
    ? extractSearchText(lastUserQuestion.content)
    : tab.lastUserQuestion;
  const agentText = lastAgentOutput
    ? extractSearchText(lastAgentOutput.content)
    : tab.lastAgentOutput;
  return {
    lastUserQuestion: userText ? truncateSearchText(userText, TABS_SNIPPET_CHARS) : undefined,
    lastAgentOutput: agentText ? truncateSearchText(agentText, TABS_SNIPPET_CHARS) : undefined,
  };
}

function buildTabsText(binding: ChannelBinding, tabs: BridgeSessionTab[]): string {
  const lines = ['<b>Tabs</b>', ''];
  tabs.forEach((tab, index) => {
    const status = getTabRuntimeStatus(binding, tab);
    const backend = tab.backend ?? 'claudecode';
    const sessionId = tabBackendSessionId(tab) ?? tab.codepilotSessionId;
    const snippets = buildTabSnippets(tab);
    const tabLines = [
      `${index + 1}. <code>${escapeHtml(sessionId)}</code> ` +
      `backend=<b>${escapeHtml(backend)}</b> ` +
      `cwd=<code>${escapeHtml(tab.workingDirectory || '~')}</code> ` +
      `status=<b>${escapeHtml(status ?? 'idle')}</b>`,
      snippets.lastUserQuestion ? `   user=<code>${escapeHtml(snippets.lastUserQuestion)}</code>` : '',
      snippets.lastAgentOutput ? `   agent=<code>${escapeHtml(snippets.lastAgentOutput)}</code>` : '',
    ].filter(Boolean);
    lines.push(tabLines.join('\n'));
  });
  lines.push('', 'Use /tab &lt;n&gt; to switch, /pop to show buffered output.');
  return lines.join('\n');
}

async function sendTabsChoiceCard(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  binding: ChannelBinding,
  tabs: BridgeSessionTab[],
): Promise<boolean> {
  if (adapter.channelType !== 'feishu' || !adapter.sendInteractiveCard) return false;
  const activeId = binding.activeSessionTabId;
  const cardJson = buildTabsChoiceCard(tabs.map((tab, index) => ({
    index: index + 1,
    active: tab.id === activeId,
    sessionId: tabBackendSessionId(tab) ?? tab.codepilotSessionId,
    workingDirectory: tab.workingDirectory,
    backend: tab.backend ?? 'claudecode',
    status: getTabRuntimeStatus(binding, tab) ?? 'idle',
    ...buildTabSnippets(tab),
    callbackData: makeTabSwitchCallbackData(binding, tab),
  })));
  const result = await adapter.sendInteractiveCard(msg.address, cardJson, msg.messageId);
  return result.ok;
}

function switchToSessionTab(
  binding: ChannelBinding,
  tabs: BridgeSessionTab[],
  selected: BridgeSessionTab,
): { response: string; selected: BridgeSessionTab; shouldFlushBuffered: boolean } {
  const materialized = materializeNativeSessionTab(binding, selected);
  const requested = tabs.findIndex((tab) => tab.id === selected.id) + 1;
  upsertSessionTab(binding, materialized, materialized.id);
  activateSessionTab(binding, materialized);
  const updatedSelected = updateSessionTab(binding, materialized.id, { unread: false }) ?? materialized;
  const status = getTabRuntimeStatus(binding, updatedSelected);
  const lines = [
    `Switched to tab ${requested}.`,
    `Session: <code>${escapeHtml(updatedSelected.codepilotSessionId)}</code>`,
    `Backend: <b>${escapeHtml(updatedSelected.backend ?? 'claudecode')}</b>`,
    `Status: <b>${escapeHtml(status ?? 'idle')}</b>`,
  ];
  let shouldFlushBuffered = false;
  if (status === 'running') {
    lines.push('Task is still running. I will stay on this tab and send the result here when it finishes.');
  } else if (status === 'unavailable') {
    lines.push('This task is no longer attached to a running daemon. Use /repair or start a new tab if it cannot continue.');
  } else if (updatedSelected.bufferedResponseText || updatedSelected.bufferedErrorMessage) {
    lines.push('Buffered output follows.');
    shouldFlushBuffered = true;
  }
  return { response: lines.join('\n'), selected: updatedSelected, shouldFlushBuffered };
}

function materializeNativeSessionTab(binding: ChannelBinding, tab: BridgeSessionTab): BridgeSessionTab {
  if (!tab.nativeSessionId || hasBridgeWrapper(tab)) return tab;
  const { store } = getBridgeContext();
  const backend = tab.backend ?? getActiveBackend(binding);
  const existing = binding.sessionTabs?.find((candidate) =>
    candidate.nativeSessionId === tab.nativeSessionId && tabBackend(candidate) === backend && !candidate.id.startsWith('native:'));
  if (existing) return existing;
  const session = store.createSession(
    `Native ${backend}: ${tab.nativeSessionId}`,
    tab.model || binding.model || '',
    undefined,
    tab.workingDirectory || binding.workingDirectory,
    tab.mode || binding.mode,
  );
  store.updateSdkSessionId(session.id, tab.nativeSessionId);
  return {
    ...tab,
    id: session.id,
    codepilotSessionId: session.id,
    sdkSessionId: tab.nativeSessionId,
    backend,
    backendSessionIds: { [backend]: session.id } as Partial<Record<BackendName, string>>,
    backendSdkSessionIds: { [backend]: tab.nativeSessionId } as Partial<Record<BackendName, string>>,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

interface SearchCandidate {
  index: number;
  tab: BridgeSessionTab;
  context: string;
  lastUserQuestion?: string;
  lastAgentOutput?: string;
}

interface SearchResultState {
  bindingId: string;
  query: string;
  limit: number;
  selectedTabId: string;
  excludedTabIds: string[];
  createdAt: number;
}

interface SearchPick {
  candidate: SearchCandidate;
  reason: string;
  keywordEvidence?: string;
  similarityEvidence?: string;
}

function searchResultCallbackData(action: 'confirm' | 'again', token: string): string {
  return `tabs:search:${action}:${encodeURIComponent(token)}`;
}

function parseSearchResultCallbackData(callbackData: string): { action: 'confirm' | 'again'; token: string } | null {
  const prefix = 'tabs:search:';
  if (!callbackData.startsWith(prefix)) return null;
  const rest = callbackData.slice(prefix.length);
  const separatorIndex = rest.indexOf(':');
  if (separatorIndex < 0) return null;
  const action = rest.slice(0, separatorIndex);
  if (action !== 'confirm' && action !== 'again') return null;
  try {
    return { action, token: decodeURIComponent(rest.slice(separatorIndex + 1)) };
  } catch {
    return null;
  }
}

function rememberSearchResult(state: Omit<SearchResultState, 'createdAt'>): string {
  const token = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  getState().searchResults.set(token, { ...state, createdAt: Date.now() });
  cleanupExpiredSearchResults();
  return token;
}

function getSearchResult(token: string): SearchResultState | null {
  const entry = getState().searchResults.get(token);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > SEARCH_RESULT_TTL_MS) {
    getState().searchResults.delete(token);
    return null;
  }
  return entry;
}

function cleanupExpiredSearchResults(): void {
  const cutoff = Date.now() - SEARCH_RESULT_TTL_MS;
  for (const [token, entry] of getState().searchResults) {
    if (entry.createdAt < cutoff) {
      getState().searchResults.delete(token);
    }
  }
}

function extractSearchText(content: string): string {
  return content
    .replace(/<!--files:[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateSearchText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function buildSearchCandidates(
  binding: ChannelBinding,
  query: string,
  excludeTabIds: Set<string>,
  limit: number,
): SearchCandidate[] {
  const { store } = getBridgeContext();
  const candidates = listCurrentBackendRecentSessionTabs(binding, Math.min(limit + 1, MAX_TABS_LIMIT))
    .filter((tab) => !excludeTabIds.has(tab.id) && !excludeTabIds.has(tab.codepilotSessionId));
  const otherTabs = candidates.filter((tab) => !isCurrentSessionTab(binding, tab));
  const currentTabs = excludeTabIds.size === 0
    ? candidates.filter((tab) => isCurrentSessionTab(binding, tab)).slice(0, 1)
    : [];
  const tabs = [
    ...otherTabs.slice(0, Math.min(limit, SEARCH_AGENT_MAX_CANDIDATES)),
    ...currentTabs,
  ];

  return tabs.map((tab, index) => {
    const messages = store.getMessages(tab.codepilotSessionId).messages;
    const recentMessages = messages.slice(-SEARCH_AGENT_HISTORY_LIMIT)
      .map((message) => `${message.role}: ${extractSearchText(message.content)}`)
      .filter(Boolean)
      .join('\n')
      .slice(-SEARCH_AGENT_CONTEXT_CHARS);
    const lastUserQuestion = [...messages]
      .reverse()
      .find((message) => message.role.toLowerCase() === 'user' && extractSearchText(message.content));
    const lastUserQuestionText = lastUserQuestion
      ? truncateSearchText(extractSearchText(lastUserQuestion.content), SEARCH_LAST_USER_QUESTION_CHARS)
      : tab.lastUserQuestion;
    const lastAgentOutput = [...messages]
      .reverse()
      .find((message) => message.role.toLowerCase() === 'assistant' && extractSearchText(message.content));
    const lastAgentOutputText = lastAgentOutput
      ? truncateSearchText(extractSearchText(lastAgentOutput.content), SEARCH_LAST_AGENT_OUTPUT_CHARS)
      : tab.lastAgentOutput;
    const summaryLines = [
      lastUserQuestionText ? `last user question: ${lastUserQuestionText}` : '',
      lastAgentOutputText ? `last agent output: ${lastAgentOutputText}` : '',
    ].filter(Boolean).join('\n');
    const nativeTranscriptSnippets = tab.nativeSessionId
      ? findNativeSessionTranscriptSnippets({
          backend: tabBackend(tab),
          nativeSessionId: tab.nativeSessionId,
          query,
          maxSnippetChars: SEARCH_NATIVE_TRANSCRIPT_SNIPPET_CHARS,
          maxSnippets: SEARCH_NATIVE_TRANSCRIPT_SNIPPETS,
        })
      : [];
    const context = [
      `session=${tab.codepilotSessionId}`,
      tab.nativeSessionId ? `nativeSession=${tab.nativeSessionId}` : '',
      `backend=${tab.backend ?? 'claudecode'}`,
      `cwd=${tab.workingDirectory || '~'}`,
      `status=${getTabRuntimeStatus(binding, tab) ?? 'idle'}`,
      nativeTranscriptSnippets.length > 0 ? `native transcript keyword matches:\n${nativeTranscriptSnippets.map((snippet) => `- ${snippet}`).join('\n')}` : '',
      recentMessages ? `recent messages:\n${recentMessages}` : summaryLines || 'recent messages: none',
    ].filter(Boolean).join('\n');
    return { index: index + 1, tab, context, lastUserQuestion: lastUserQuestionText, lastAgentOutput: lastAgentOutputText };
  });
}

function buildSearchPrompt(query: string, candidates: SearchCandidate[]): string {
  const candidateText = candidates.map((candidate) => [
    `Candidate ${candidate.index}`,
    candidate.context,
  ].join('\n')).join('\n\n---\n\n');
  return [
    'You are selecting the single most relevant existing coding-agent session for a user search query.',
    'Use only the candidate summaries below. Do not call tools. Return only compact JSON.',
    'Schema: {"index": number, "confidence": number, "keywordEvidence": string, "similarityEvidence": string, "reason": string}',
    'keywordEvidence must cite matching words or phrases from the query/candidate.',
    'similarityEvidence must explain semantic similarity from the candidate content.',
    'The reason must be short Chinese text explaining why this session matches.',
    'If no candidate is relevant, return {"index":0,"confidence":0,"keywordEvidence":"","similarityEvidence":"","reason":"no relevant session"}.',
    '',
    `Query: ${query}`,
    '',
    candidateText,
  ].join('\n');
}

async function readLlmText(stream: ReadableStream<string>): Promise<{ text: string; error: string | null }> {
  const reader = stream.getReader();
  let text = '';
  let error: string | null = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of value.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice('data: '.length)) as { type?: string; data?: string };
          if (event.type === 'text' && typeof event.data === 'string') {
            text += event.data;
          } else if (event.type === 'error') {
            error = typeof event.data === 'string' ? event.data : 'search agent error';
          }
        } catch {
          // Ignore malformed SSE frames from provider implementations.
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return { text, error };
}

function parseSearchAgentPick(text: string, candidates: SearchCandidate[]): SearchPick | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as {
      index?: unknown;
      confidence?: unknown;
      keywordEvidence?: unknown;
      similarityEvidence?: unknown;
      reason?: unknown;
    };
    const index = typeof parsed.index === 'number' ? parsed.index : Number.parseInt(String(parsed.index ?? ''), 10);
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : Number.parseFloat(String(parsed.confidence ?? '0'));
    if (!Number.isInteger(index) || index < 1 || index > candidates.length) return null;
    if (!Number.isFinite(confidence) || confidence < SEARCH_AGENT_MIN_CONFIDENCE) return null;
    const keywordEvidence = typeof parsed.keywordEvidence === 'string'
      ? parsed.keywordEvidence.trim().slice(0, 180)
      : '';
    const similarityEvidence = typeof parsed.similarityEvidence === 'string'
      ? parsed.similarityEvidence.trim().slice(0, 180)
      : '';
    const evidenceReason = [
      keywordEvidence ? `关键词证据：${keywordEvidence}` : '',
      similarityEvidence ? `内容相似度证据：${similarityEvidence}` : '',
    ].filter(Boolean).join('；');
    return {
      candidate: candidates[index - 1],
      reason: typeof parsed.reason === 'string' && parsed.reason.trim()
        ? formatChineseSearchReason(parsed.reason.trim().slice(0, 180), '搜索代理匹配')
        : evidenceReason || '搜索代理匹配',
      keywordEvidence,
      similarityEvidence,
    };
  } catch {
    return null;
  }
}

function formatChineseSearchReason(reason: string, prefix: string): string {
  return /[\u3400-\u9fff]/.test(reason) ? reason : `${prefix}：${reason}`;
}

function tokenizeSearchQuery(query: string): string[] {
  return query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2);
}

function localSearchPick(query: string, candidates: SearchCandidate[]): SearchPick | null {
  const tokens = tokenizeSearchQuery(query);
  if (tokens.length === 0) return null;
  let best: { candidate: SearchCandidate; score: number } | null = null;
  for (const candidate of candidates) {
    const haystack = candidate.context.toLowerCase();
    const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
    if (score > 0 && (!best || score > best.score)) {
      best = { candidate, score };
    }
  }
  if (!best) return null;
  return {
    candidate: best.candidate,
    reason: '本地关键词匹配',
    keywordEvidence: tokens.filter((token) => best.candidate.context.toLowerCase().includes(token)).join(', '),
    similarityEvidence: '候选上下文包含查询关键词',
  };
}

async function searchBestSessionTab(
  binding: ChannelBinding,
  query: string,
  excludeTabIds: Set<string>,
  limit: number,
): Promise<SearchPick | null> {
  const { llm } = getBridgeContext();
  const candidates = buildSearchCandidates(binding, query, excludeTabIds, limit);
  if (candidates.length === 0) return null;

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), SEARCH_AGENT_TIMEOUT_MS);
  timer.unref?.();
  try {
    const stream = llm.streamChat({
      prompt: buildSearchPrompt(query, candidates),
      sessionId: `search-${binding.id}-${Date.now()}`,
      workingDirectory: binding.workingDirectory,
      model: binding.model,
      effort: 'medium',
      backend: binding.backend,
      permissionMode: 'default',
      sandboxLevel: 'ro',
      abortController,
      ephemeral: true,
    });
    const result = await readLlmText(stream);
    const agentPick = result.error ? null : parseSearchAgentPick(result.text, candidates);
    return agentPick ?? localSearchPick(query, candidates);
  } catch {
    return localSearchPick(query, candidates);
  } finally {
    clearTimeout(timer);
  }
}

function buildSearchResultText(
  binding: ChannelBinding,
  query: string,
  pick: SearchPick,
  confirmCallbackData: string,
  retryCallbackData: string,
): string {
  const tab = pick.candidate.tab;
  const isCurrent = isCurrentSessionTab(binding, tab);
  const lines = [
    '<b>Search result</b>',
    `Query: <code>${escapeHtml(query)}</code>`,
    '',
    `Session: <code>${escapeHtml(tab.codepilotSessionId)}</code>`,
    isCurrent ? 'Note: This is the current session.' : '',
    `Backend: <b>${escapeHtml(tab.backend ?? 'claudecode')}</b>`,
    `Status: <b>${escapeHtml(getTabRuntimeStatus(binding, tab) ?? tab.status ?? 'idle')}</b>`,
    `CWD: <code>${escapeHtml(tab.workingDirectory || '~')}</code>`,
    `Reason: ${escapeHtml(pick.reason)}`,
  ].filter(Boolean);
  if (pick.keywordEvidence) {
    lines.push(`Keyword evidence: ${escapeHtml(pick.keywordEvidence)}`);
  }
  if (pick.similarityEvidence) {
    lines.push(`Similarity evidence: ${escapeHtml(pick.similarityEvidence)}`);
  }
  if (pick.candidate.lastUserQuestion) {
    lines.push(`Last user question: ${escapeHtml(pick.candidate.lastUserQuestion)}`);
  }
  if (pick.candidate.lastAgentOutput) {
    lines.push(`Last agent output: ${escapeHtml(pick.candidate.lastAgentOutput)}`);
  }
  lines.push(
    '',
    'Use the buttons below, or send /tab after /tabs.',
    `Confirm callback: ${confirmCallbackData}`,
    `Retry callback: ${retryCallbackData}`,
  );
  return lines.join('\n');
}

async function sendSearchResult(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  binding: ChannelBinding,
  query: string,
  pick: SearchPick,
  limit: number,
  excludedTabIds: string[],
): Promise<void> {
  const token = rememberSearchResult({
    bindingId: binding.id,
    query,
    limit,
    selectedTabId: pick.candidate.tab.id,
    excludedTabIds,
  });
  const confirmCallbackData = searchResultCallbackData('confirm', token);
  const retryCallbackData = searchResultCallbackData('again', token);
  const status = getTabRuntimeStatus(binding, pick.candidate.tab) ?? 'idle';
  const displayReason = [
    pick.reason,
    pick.keywordEvidence ? `关键词证据：${pick.keywordEvidence}` : '',
    pick.similarityEvidence ? `内容相似度证据：${pick.similarityEvidence}` : '',
  ].filter(Boolean).join('\n');

  if (adapter.channelType === 'feishu' && adapter.sendInteractiveCard) {
    const result = await adapter.sendInteractiveCard(
      msg.address,
      buildSearchResultCard({
        query,
        codepilotSessionId: pick.candidate.tab.codepilotSessionId,
        workingDirectory: pick.candidate.tab.workingDirectory,
        backend: pick.candidate.tab.backend ?? 'claudecode',
        status,
        isCurrentSession: isCurrentSessionTab(binding, pick.candidate.tab),
        reason: displayReason,
        lastUserQuestion: pick.candidate.lastUserQuestion,
        lastAgentOutput: pick.candidate.lastAgentOutput,
        confirmCallbackData,
        retryCallbackData,
      }),
      msg.callbackMessageId ?? msg.messageId,
    );
    if (result.ok) return;
  }

  await deliver(adapter, {
    address: msg.address,
    text: buildSearchResultText(binding, query, pick, confirmCallbackData, retryCallbackData),
    parseMode: 'HTML',
    replyToMessageId: msg.callbackMessageId ?? msg.messageId,
    inlineButtons: [[
      { text: '确认', callbackData: confirmCallbackData },
      { text: '重新搜索', callbackData: retryCallbackData },
    ]],
  });
}

// ── /peek: low-noise session progress snapshot ────────────────

interface PeekData {
  status: BridgeSessionTab['status'];
  risk: FeishuPeekRisk;
  backend: BackendName;
  workingDirectory: string;
  bridgeSessionId: string;
  nativeSessionId: string;
  model: string;
  lastActivityAt?: string;
  elapsed?: string;
  recentAction?: string;
  summary: string;
  summarySource: 'model' | 'local';
  truncated: boolean;
  hasNativeSession: boolean;
}

function classifyPeekRisk(
  status: BridgeSessionTab['status'],
  hasPendingPermission: boolean,
): FeishuPeekRisk {
  if (hasPendingPermission) return 'waiting';
  if (status === 'running') return 'running';
  if (status === 'error') return 'error';
  if (status === 'unavailable') return 'error';
  if (status === 'idle') return 'idle';
  return 'normal';
}

function peekRiskLabelZh(risk: FeishuPeekRisk): string {
  switch (risk) {
    case 'running': return '运行中';
    case 'idle': return '空闲';
    case 'waiting': return '等待授权';
    case 'error': return '出错';
    default: return '正常';
  }
}

function formatPeekActivityElapsed(lastActivityAt?: string): string | undefined {
  if (!lastActivityAt) return undefined;
  const parsed = Date.parse(lastActivityAt);
  if (!Number.isFinite(parsed)) return undefined;
  const delta = Date.now() - parsed;
  if (delta < 0) return undefined;
  return formatElapsed(delta);
}

/** Build the most recent tool/action label from transcript entries. */
function peekRecentAction(tail: NativeSessionTranscriptTail): string | undefined {
  const lastTool = [...tail.entries].reverse().find((entry) => entry.role === 'tool');
  if (lastTool) return truncateSearchText(`${lastTool.label} ${lastTool.text}`.trim(), 160);
  const lastAny = tail.entries.at(-1);
  if (lastAny) return truncateSearchText(`${lastAny.label}: ${lastAny.text}`, 160);
  return undefined;
}

function buildPeekTranscriptText(tail: NativeSessionTranscriptTail): string {
  const lines = tail.entries.map((entry) => `${entry.label}: ${entry.text}`);
  let text = lines.join('\n');
  if (text.length > PEEK_PROMPT_TRANSCRIPT_CHARS) {
    // Keep the most recent tail — truncate from the front.
    text = `…\n${text.slice(text.length - PEEK_PROMPT_TRANSCRIPT_CHARS)}`;
  }
  return text;
}

function buildPeekPrompt(transcriptText: string): string {
  return [
    '你正在为一次状态检查总结某个 coding-agent 会话的近期活动。',
    '只能使用下面的 transcript 片段，不要调用任何工具，也不要反问。',
    '用简洁的中文纯文本输出（不要 markdown 标题）。',
    '需要覆盖：当前在做什么、最近一次具体动作，以及它看起来是在推进、空闲、',
    '在等待用户输入/授权，还是卡在某个错误上。',
    `控制在 ${Math.floor(PEEK_SUMMARY_MAX_CHARS / 6)} 字以内。`,
    '',
    'Transcript 片段（最近的活动）：',
    transcriptText,
  ].join('\n');
}

function buildPeekLocalSummary(tail: NativeSessionTranscriptTail): string {
  if (tail.entries.length === 0) return '';
  const recent = tail.entries.slice(-6).map((entry) => `• ${entry.label}: ${entry.text}`);
  return truncateSearchText(recent.join('\n'), PEEK_SUMMARY_MAX_CHARS);
}

async function summarizePeekTranscript(
  binding: ChannelBinding,
  tail: NativeSessionTranscriptTail,
): Promise<{ summary: string; source: 'model' | 'local' }> {
  const localSummary = buildPeekLocalSummary(tail);
  if (tail.entries.length === 0) {
    return { summary: '', source: 'local' };
  }

  const { llm } = getBridgeContext();
  const transcriptText = buildPeekTranscriptText(tail);
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), PEEK_AGENT_TIMEOUT_MS);
  timer.unref?.();
  try {
    const stream = llm.streamChat({
      prompt: buildPeekPrompt(transcriptText),
      // Ephemeral, stateless session id — never the active coding-agent session.
      sessionId: `peek-${binding.id}-${Date.now()}`,
      workingDirectory: binding.workingDirectory,
      model: binding.model,
      effort: 'low',
      backend: binding.backend,
      permissionMode: 'default',
      sandboxLevel: 'ro',
      abortController,
      ephemeral: true,
    });
    const result = await readLlmText(stream);
    const text = result.error ? '' : result.text.trim();
    if (text) {
      return { summary: truncateSearchText(text, PEEK_SUMMARY_MAX_CHARS), source: 'model' };
    }
    return { summary: localSummary, source: 'local' };
  } catch {
    return { summary: localSummary, source: 'local' };
  } finally {
    clearTimeout(timer);
  }
}

async function collectPeekData(binding: ChannelBinding): Promise<PeekData> {
  const { store } = getBridgeContext();
  const backend = getActiveBackend(binding);
  const nativeSessionId = getActiveNativeSessionId(binding);
  const tabs = normalizeSessionTabs(binding);
  const activeId = binding.activeSessionTabId ?? binding.codepilotSessionId;
  const activeTab = tabs.find((tab) => tab.id === activeId || tab.codepilotSessionId === binding.codepilotSessionId)
    ?? snapshotBindingAsTab(binding);
  const status = getTabRuntimeStatus(binding, activeTab);
  const hasPendingPermission = store.listPendingPermissionLinksByChat(binding.chatId).length > 0;
  const risk = classifyPeekRisk(status, hasPendingPermission);
  const model = binding.model || store.getSession(binding.codepilotSessionId)?.model || '';

  if (!nativeSessionId) {
    return {
      status,
      risk,
      backend,
      workingDirectory: binding.workingDirectory,
      bridgeSessionId: binding.codepilotSessionId,
      nativeSessionId: '',
      model,
      lastActivityAt: activeTab.activityAt,
      elapsed: formatPeekActivityElapsed(activeTab.activityAt),
      recentAction: undefined,
      summary: '',
      summarySource: 'local',
      truncated: false,
      hasNativeSession: false,
    };
  }

  const tail = readNativeSessionTranscriptTail({
    backend,
    nativeSessionId,
    maxEntries: PEEK_TAIL_ENTRIES,
    maxChars: PEEK_TAIL_CHARS,
    maxEntryChars: PEEK_TAIL_ENTRY_CHARS,
  });
  const { summary, source } = await summarizePeekTranscript(binding, tail);
  const lastActivityAt = tail.lastActivityAt ?? activeTab.activityAt;

  return {
    status,
    risk,
    backend,
    workingDirectory: tail.workingDirectory || binding.workingDirectory,
    bridgeSessionId: binding.codepilotSessionId,
    nativeSessionId,
    model,
    lastActivityAt,
    elapsed: formatPeekActivityElapsed(lastActivityAt),
    recentAction: peekRecentAction(tail),
    summary,
    summarySource: source,
    truncated: tail.truncated,
    hasNativeSession: true,
  };
}

function peekStatusLabel(status: BridgeSessionTab['status']): string {
  return status ?? 'idle';
}

function buildPeekText(data: PeekData): string {
  const summaryHeading = data.summarySource === 'model' ? '摘要' : '摘要（本地兜底）';
  const summaryBody = data.hasNativeSession
    ? (data.summary || '暂无可总结的近期活动。')
    : '尚未建立 native session。发送一条消息即可开始。';
  const lines = [
    '<b>会话快照</b>',
    '',
    `状态：<b>${escapeHtml(peekStatusLabel(data.status))}</b>`,
    `风险：<b>${escapeHtml(peekRiskLabelZh(data.risk))}</b>`,
    `后端：<b>${escapeHtml(data.backend)}</b>`,
    `工作目录：<code>${escapeHtml(data.workingDirectory || '~')}</code>`,
    data.lastActivityAt ? `最近活动：${escapeHtml(data.lastActivityAt)}` : '',
    data.elapsed ? `距上次活动：${escapeHtml(data.elapsed)}` : '',
    `Bridge 会话：<code>${escapeHtml(data.bridgeSessionId)}</code>`,
    `Native 会话：<code>${escapeHtml(data.nativeSessionId || '无（全新）')}</code>`,
    data.model ? `模型：<code>${escapeHtml(data.model)}</code>` : '',
    data.recentAction ? `最近动作：${escapeHtml(data.recentAction)}` : '',
    '',
    `<b>${summaryHeading}</b>`,
    escapeHtml(summaryBody),
    data.truncated ? '已截断为最近的活动。' : '',
  ].filter(Boolean);
  return lines.join('\n');
}

async function sendPeekResult(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  data: PeekData,
): Promise<void> {
  if (adapter.channelType === 'feishu' && adapter.sendInteractiveCard) {
    const cardJson = buildPeekCard({
      status: peekStatusLabel(data.status),
      risk: data.risk,
      backend: data.backend,
      workingDirectory: data.workingDirectory,
      bridgeSessionId: data.bridgeSessionId,
      nativeSessionId: data.nativeSessionId || undefined,
      model: data.model || undefined,
      lastActivity: data.lastActivityAt,
      elapsed: data.elapsed,
      recentAction: data.recentAction,
      summary: data.hasNativeSession
        ? data.summary
        : '尚未建立 native session。发送一条消息即可开始。',
      summarySource: data.summarySource,
      truncated: data.truncated,
    });
    const result = await adapter.sendInteractiveCard(msg.address, cardJson, msg.messageId);
    if (result.ok) return;
  }

  await deliver(adapter, {
    address: msg.address,
    text: buildPeekText(data),
    parseMode: 'HTML',
    replyToMessageId: msg.messageId,
  });
}

function markActiveTabStarted(binding: ChannelBinding): void {
  const tabs = normalizeSessionTabs(binding);
  const activeId = binding.activeSessionTabId ?? binding.codepilotSessionId;
  const activeTab = tabs.find((tab) => tab.id === activeId || tab.codepilotSessionId === binding.codepilotSessionId)
    ?? snapshotBindingAsTab(binding);
  const activityAt = new Date().toISOString();
  upsertSessionTab(binding, {
    ...activeTab,
    ...snapshotBindingAsTab(binding, {
      id: activeTab.id,
      status: 'running',
      bufferedResponseText: '',
      bufferedErrorMessage: '',
      bufferedAt: undefined,
      unread: false,
      activityAt,
    }),
  }, activeTab.id);
}

function recordTabResult(
  binding: ChannelBinding,
  result: {
    responseText?: string;
    hasError?: boolean;
    errorMessage?: string;
    sdkSessionId?: string | null;
  },
  delivered: boolean,
): void {
  const current = getCurrentBindingForOutput(binding) ?? binding;
  const tabs = normalizeSessionTabs(current);
  const tabIndex = tabs.findIndex((tab) => tab.codepilotSessionId === binding.codepilotSessionId);
  if (tabIndex < 0) return;

  const tab = tabs[tabIndex];
  const backend = binding.backend ?? tab.backend ?? 'claudecode';
  const backendSdkSessionIds = {
    ...(tab.backendSdkSessionIds ?? {}),
  } as Partial<Record<BackendName, string>>;
  if (result.sdkSessionId && !result.hasError) {
    backendSdkSessionIds[backend] = result.sdkSessionId;
  } else if (result.hasError) {
    backendSdkSessionIds[backend] = '';
  }

  tabs[tabIndex] = {
    ...tab,
    sdkSessionId: result.sdkSessionId && !result.hasError ? result.sdkSessionId : result.hasError ? '' : tab.sdkSessionId,
    backendSdkSessionIds,
    status: result.hasError ? 'error' : 'completed',
    bufferedResponseText: delivered ? '' : result.responseText ?? '',
    bufferedErrorMessage: delivered ? '' : result.errorMessage ?? '',
    bufferedAt: delivered ? undefined : new Date().toISOString(),
    unread: !delivered,
    activityAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  current.sessionTabs = tabs;
  const updates: Partial<ChannelBinding> = {
    sessionTabs: tabs,
    activeSessionTabId: current.activeSessionTabId,
  };
  if (current.codepilotSessionId === binding.codepilotSessionId) {
    updates.sdkSessionId = tabs[tabIndex].sdkSessionId;
    updates.backendSdkSessionIds = backendSdkSessionIds;
  }
  router.updateBinding(current.id, updates);
}

/**
 * Check whether a snapshotted `(bindingId, generation)` pair is still
 * the current generation for that binding. Stale output from old
 * generations is dropped silently.
 */
export function isCurrentGeneration(bindingId: string, generation: number): boolean {
  const { store } = getBridgeContext();
  const all = store.listChannelBindings();
  for (const b of all) {
    if (b.id === bindingId) {
      return (b.backendGeneration ?? 0) === generation;
    }
  }
  return false;
}

/** Fire-and-forget: send a preview draft. Only degrades on permanent failure. */
function flushPreview(
  adapter: BaseChannelAdapter,
  state: StreamingPreviewState,
  config: StreamConfig,
): void {
  if (state.degraded || !adapter.sendPreview) return;

  const text = state.pendingText.length > config.maxChars
    ? state.pendingText.slice(0, config.maxChars) + '...'
    : state.pendingText;

  state.lastSentText = text;
  state.lastSentAt = Date.now();

  adapter.sendPreview(state.chatId, text, state.draftId).then(result => {
    if (result === 'degrade') state.degraded = true;
    // 'skip' — transient failure, next flush will retry naturally
  }).catch(() => {
    // Network error — transient, don't degrade
  });
}

// ── Channel-aware rendering dispatch ──────────────────────────

import type { ChannelAddress, SendResult } from './types.js';

const FEISHU_FINAL_CARD_MAX_CHARS = 3500;

interface FinalReplyFooter {
  tokenUsage?: TokenUsage | null;
  model?: string | null;
  elapsedMs?: number;
  status?: 'completed' | 'interrupted' | 'error';
}

type CardCapableAdapter = BaseChannelAdapter & {
  sendInteractiveCard: NonNullable<BaseChannelAdapter['sendInteractiveCard']>;
};

function finalStatusLabel(status: FinalReplyFooter['status']): string {
  if (status === 'error') return '❌ Error';
  if (status === 'interrupted') return '⚠️ Interrupted';
  return '✅ Completed';
}

async function deliverFeishuFinalCards(
  adapter: CardCapableAdapter,
  address: ChannelAddress,
  responseText: string,
  replyToMessageId: string | undefined,
  finalFooter: FinalReplyFooter,
): Promise<SendResult> {
  const chunks = splitFinalReplyBody(responseText, { maxChars: FEISHU_FINAL_CARD_MAX_CHARS });
  let lastResult: SendResult = { ok: true };
  for (let i = 0; i < chunks.length; i++) {
    const cardJson = buildFinalCardJson(chunks[i], [], {
      status: finalStatusLabel(finalFooter.status),
      elapsed: formatElapsed(finalFooter.elapsedMs ?? 0),
      tokenUsage: finalFooter.tokenUsage ?? null,
      model: finalFooter.model ?? null,
      isFinal: true,
      isContinuation: i > 0,
    });
    const result = await adapter.sendInteractiveCard(address, cardJson, replyToMessageId);
    if (!result.ok) return result;
    lastResult = result;
  }
  return lastResult;
}

/**
 * Render response text and deliver via the appropriate channel format.
 * Telegram: Markdown → HTML chunks via deliverRendered.
 * Other channels: plain text via deliver (no HTML).
 */
async function deliverResponse(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
  replyToMessageId?: string,
  finalFooter?: FinalReplyFooter,
): Promise<SendResult> {
  const responseTextWithFooter = finalFooter
    ? responseText + buildFinalReplyFooterText(finalFooter.tokenUsage, finalFooter.model)
    : responseText;
  if (adapter.channelType === 'telegram') {
    const chunks = markdownToTelegramChunks(responseTextWithFooter, 4096);
    if (chunks.length > 0) {
      return deliverRendered(adapter, address, chunks, { sessionId, replyToMessageId });
    }
    return { ok: true };
  }
  if (adapter.channelType === 'discord') {
    // Discord: native markdown, chunk at 2000 chars with fence repair
    const chunks = markdownToDiscordChunks(responseTextWithFooter, 2000);
    for (let i = 0; i < chunks.length; i++) {
      const result = await deliver(adapter, {
        address,
        text: chunks[i].text,
        parseMode: 'Markdown',
        replyToMessageId,
      }, { sessionId });
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  if (adapter.channelType === 'feishu') {
    if (finalFooter && adapter.sendInteractiveCard) {
      const cardResult = await deliverFeishuFinalCards(
        adapter as CardCapableAdapter,
        address,
        responseText,
        replyToMessageId,
        finalFooter,
      );
      if (cardResult.ok) return cardResult;
      console.warn('[bridge-manager] Feishu final card send failed, falling back to text:', cardResult.error);
    }

    // Feishu: pass markdown through for adapter to format as post/card.
    // For long replies, split into chunks with "最终回复 ✔" markers so they
    // remain renderable within Feishu's per-message limits.
    if (responseTextWithFooter.length > 3500) {
      const chunks = splitFinalReply(responseTextWithFooter);
      for (let i = 0; i < chunks.length; i++) {
        const result = await deliver(adapter, {
          address,
          text: chunks[i],
          parseMode: 'Markdown',
          // Only thread the first chunk; subsequent chunks chain naturally.
          replyToMessageId: i === 0 ? replyToMessageId : undefined,
        }, { sessionId });
        if (!result.ok) return result;
      }
      return { ok: true };
    }
    return deliver(adapter, {
      address,
      text: responseTextWithFooter,
      parseMode: 'Markdown',
      replyToMessageId,
    }, { sessionId });
  }
  // Generic fallback: deliver as plain text (deliver() handles chunking internally)
  return deliver(adapter, {
    address,
    text: responseTextWithFooter,
    parseMode: 'plain',
    replyToMessageId,
  }, { sessionId });
}

interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
}

interface TabListingState {
  backend: BackendName;
  tabs: BridgeSessionTab[];
}

interface BridgeManagerState {
  adapters: Map<string, BaseChannelAdapter>;
  adapterMeta: Map<string, AdapterMeta>;
  running: boolean;
  startedAt: string | null;
  loopAborts: Map<string, AbortController>;
  activeTasks: Map<string, AbortController>;
  tabListings: Map<string, TabListingState>;
  searchResults: Map<string, SearchResultState>;
  /** Per-session processing chains for concurrency control */
  sessionLocks: Map<string, Promise<void>>;
  autoStartChecked: boolean;
}

function getState(): BridgeManagerState {
  const g = globalThis as unknown as Record<string, BridgeManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      adapters: new Map(),
      adapterMeta: new Map(),
      running: false,
      startedAt: null,
      loopAborts: new Map(),
      activeTasks: new Map(),
      tabListings: new Map(),
      searchResults: new Map(),
      sessionLocks: new Map(),
      autoStartChecked: false,
    };
  }
  if (!g[GLOBAL_KEY].tabListings) {
    g[GLOBAL_KEY].tabListings = new Map();
  }
  if (!g[GLOBAL_KEY].searchResults) {
    g[GLOBAL_KEY].searchResults = new Map();
  }
  // Backfill sessionLocks for states created before this field existed
  if (!g[GLOBAL_KEY].sessionLocks) {
    g[GLOBAL_KEY].sessionLocks = new Map();
  }
  return g[GLOBAL_KEY];
}

/**
 * Process a function with per-session serialization.
 * Different sessions run concurrently; same-session requests are serialized.
 */
function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const state = getState();
  const prev = state.sessionLocks.get(sessionId) || Promise.resolve();
  const current = prev.then(fn, fn);
  state.sessionLocks.set(sessionId, current);
  // Cleanup when the chain completes.
  // Suppress rejection on the cleanup chain — callers handle errors on `current` directly.
  current.finally(() => {
    if (state.sessionLocks.get(sessionId) === current) {
      state.sessionLocks.delete(sessionId);
    }
  }).catch(() => {});
  return current;
}

/**
 * Start the bridge system.
 * Checks feature flags, registers enabled adapters, starts polling loops.
 */
export async function start(): Promise<void> {
  const state = getState();
  if (state.running) return;

  const { store, lifecycle } = getBridgeContext();

  const bridgeEnabled = store.getSetting('remote_bridge_enabled') === 'true';
  if (!bridgeEnabled) {
    console.log('[bridge-manager] Bridge not enabled (remote_bridge_enabled != true)');
    return;
  }

  // Iterate all registered adapter types and create those that are enabled
  for (const channelType of getRegisteredTypes()) {
    const settingKey = `bridge_${channelType}_enabled`;
    if (store.getSetting(settingKey) !== 'true') continue;

    const adapter = createAdapter(channelType);
    if (!adapter) continue;

    const configError = adapter.validateConfig();
    if (!configError) {
      registerAdapter(adapter);
    } else {
      console.warn(`[bridge-manager] ${channelType} adapter not valid:`, configError);
    }
  }

  // Start all registered adapters, track how many succeeded
  let startedCount = 0;
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.start();
      console.log(`[bridge-manager] Started adapter: ${type}`);
      startedCount++;
    } catch (err) {
      console.error(`[bridge-manager] Failed to start adapter ${type}:`, err);
    }
  }

  // Only mark as running if at least one adapter started successfully
  if (startedCount === 0) {
    console.warn('[bridge-manager] No adapters started successfully, bridge not activated');
    state.adapters.clear();
    state.adapterMeta.clear();
    return;
  }

  // Mark running BEFORE starting consumer loops — runAdapterLoop checks
  // state.running in its while-condition, so it must be true first.
  state.running = true;
  state.startedAt = new Date().toISOString();

  // Notify host that bridge is starting (e.g., suppress competing polling)
  lifecycle.onBridgeStart?.();

  // Now start the consumer loops (state.running is already true)
  for (const [, adapter] of state.adapters) {
    if (adapter.isRunning()) {
      runAdapterLoop(adapter);
    }
  }

  console.log(`[bridge-manager] Bridge started with ${startedCount} adapter(s)`);
}

/**
 * Stop the bridge system gracefully.
 */
export async function stop(): Promise<void> {
  const state = getState();
  if (!state.running) return;

  const { lifecycle } = getBridgeContext();

  state.running = false;

  // Abort all event loops
  for (const [, abort] of state.loopAborts) {
    abort.abort();
  }
  state.loopAborts.clear();

  // Stop all adapters
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.stop();
      console.log(`[bridge-manager] Stopped adapter: ${type}`);
    } catch (err) {
      console.error(`[bridge-manager] Error stopping adapter ${type}:`, err);
    }
  }

  state.adapters.clear();
  state.adapterMeta.clear();
  state.startedAt = null;

  // Notify host that bridge stopped
  lifecycle.onBridgeStop?.();

  console.log('[bridge-manager] Bridge stopped');
}

/**
 * Lazy auto-start: checks bridge_auto_start setting once and starts if enabled.
 * Called from POST /api/bridge with action 'auto-start' (triggered by Electron on startup).
 */
export function tryAutoStart(): void {
  const state = getState();
  if (state.autoStartChecked) return;
  state.autoStartChecked = true;

  if (state.running) return;

  const { store } = getBridgeContext();
  const autoStart = store.getSetting('bridge_auto_start');
  if (autoStart !== 'true') return;

  start().catch(err => {
    console.error('[bridge-manager] Auto-start failed:', err);
  });
}

/**
 * Get the current bridge status.
 */
export function getStatus(): BridgeStatus {
  const state = getState();
  return {
    running: state.running,
    startedAt: state.startedAt,
    adapters: Array.from(state.adapters.entries()).map(([type, adapter]) => {
      const meta = state.adapterMeta.get(type);
      return {
        channelType: adapter.channelType,
        running: adapter.isRunning(),
        connectedAt: state.startedAt,
        lastMessageAt: meta?.lastMessageAt ?? null,
        error: meta?.lastError ?? null,
      };
    }),
  };
}

/**
 * Register a channel adapter.
 */
export function registerAdapter(adapter: BaseChannelAdapter): void {
  const state = getState();
  state.adapters.set(adapter.channelType, adapter);
}

/**
 * Run the event loop for a single adapter.
 * Messages for different sessions are dispatched concurrently;
 * messages for the same session are serialized via session locks.
 */
function runAdapterLoop(adapter: BaseChannelAdapter): void {
  const state = getState();
  const abort = new AbortController();
  state.loopAborts.set(adapter.channelType, abort);

  (async () => {
    while (state.running && adapter.isRunning()) {
      try {
        const msg = await adapter.consumeOne();
        if (!msg) continue; // Adapter stopped

        // Callback queries, commands, and numeric permission shortcuts are
        // lightweight — process inline (outside session lock).
        // Regular messages use per-session locking for concurrency.
        //
        // IMPORTANT: numeric shortcuts (1/2/3) for feishu/qq MUST run outside
        // the session lock. The current session is blocked waiting for the
        // permission to be resolved; if "1" enters the session lock queue it
        // deadlocks (permission waits for "1", "1" waits for lock release).
        if (
          msg.callbackData ||
          msg.text.trim().startsWith('/') ||
          isNumericPermissionShortcut(adapter.channelType, msg.text.trim(), msg.address.chatId)
        ) {
          await handleMessage(adapter, msg);
        } else {
          const binding = router.resolve(msg.address);
          // Fire-and-forget into session lock — loop continues to accept
          // messages for other sessions immediately. Key off per-backend
          // lane so a new `/backend` lane isn't blocked by an old lock.
          const lane = laneKey(binding);
          processWithSessionLock(lane, () =>
            handleMessage(adapter, msg),
          ).catch(err => {
            console.error(`[bridge-manager] Session ${lane} error:`, err);
          });
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[bridge-manager] Error in ${adapter.channelType} loop:`, err);
        // Track last error per adapter
        const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
        meta.lastError = errMsg;
        state.adapterMeta.set(adapter.channelType, meta);
        // Brief delay to prevent tight error loops
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  })().catch(err => {
    if (!abort.signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[bridge-manager] ${adapter.channelType} loop crashed:`, err);
      const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
      meta.lastError = errMsg;
      state.adapterMeta.set(adapter.channelType, meta);
    }
  });
}

/**
 * Handle a single inbound message.
 */
async function handleMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
): Promise<void> {
  const { store } = getBridgeContext();

  // Update lastMessageAt for this adapter
  const adapterState = getState();
  const meta = adapterState.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
  meta.lastMessageAt = new Date().toISOString();
  adapterState.adapterMeta.set(adapter.channelType, meta);

  // Acknowledge the update offset after processing completes (or fails).
  // This ensures the adapter only advances its committed offset once the
  // message has been fully handled, preventing message loss on crash.
  const ack = () => {
    if (msg.updateId != null && adapter.acknowledgeUpdate) {
      adapter.acknowledgeUpdate(msg.updateId);
    }
  };

  // Handle callback queries (interactive card buttons)
  if (msg.callbackData) {
    const searchCallback = parseSearchResultCallbackData(msg.callbackData);
    if (searchCallback) {
      const searchState = getSearchResult(searchCallback.token);
      const binding = store.getChannelBinding(msg.address.channelType, msg.address.chatId);
      if (!searchState || !binding || binding.id !== searchState.bindingId) {
        await deliver(adapter, {
          address: msg.address,
          text: 'This search result expired. Send /search again.',
          parseMode: 'plain',
          replyToMessageId: msg.callbackMessageId ?? msg.messageId,
        });
        ack();
        return;
      }

      if (searchCallback.action === 'confirm') {
        const tabs = listCurrentBackendRecentSessionTabs(binding, MAX_TABS_LIMIT);
        const selected = tabs.find((tab) => tab.id === searchState.selectedTabId || tab.codepilotSessionId === searchState.selectedTabId);
        if (!selected) {
          await deliver(adapter, {
            address: msg.address,
            text: 'That session is no longer available. Send /search again.',
            parseMode: 'plain',
            replyToMessageId: msg.callbackMessageId ?? msg.messageId,
          });
          ack();
          return;
        }
        const result = switchToSessionTab(binding, tabs, selected);
        await deliver(adapter, {
          address: msg.address,
          text: result.response,
          parseMode: 'HTML',
          replyToMessageId: msg.callbackMessageId ?? msg.messageId,
        });
        if (result.shouldFlushBuffered) {
          await flushBufferedTabOutput(adapter, msg, binding, result.selected);
        }
        getState().searchResults.delete(searchCallback.token);
        ack();
        return;
      }

      const excluded = Array.from(new Set([...searchState.excludedTabIds, searchState.selectedTabId]));
      getState().searchResults.delete(searchCallback.token);
      const pick = await searchBestSessionTab(binding, searchState.query, new Set(excluded), searchState.limit);
      if (!pick) {
        await deliver(adapter, {
          address: msg.address,
          text: 'No other matching session found. Try a more specific /search query, or use /tabs to choose manually.',
          parseMode: 'plain',
          replyToMessageId: msg.callbackMessageId ?? msg.messageId,
        });
        ack();
        return;
      }
      await sendSearchResult(adapter, msg, binding, searchState.query, pick, searchState.limit, excluded);
      ack();
      return;
    }

    const tabSwitch = parseTabSwitchCallbackData(msg.callbackData);
    if (tabSwitch) {
      const binding = store.getChannelBinding(msg.address.channelType, msg.address.chatId);
      if (!binding || binding.id !== tabSwitch.bindingId) {
        await deliver(adapter, {
          address: msg.address,
          text: 'This tabs card is stale. Send /tabs again.',
          parseMode: 'plain',
          replyToMessageId: msg.callbackMessageId ?? msg.messageId,
        });
        ack();
        return;
      }
      const tabs = listCurrentBackendRecentSessionTabs(binding, MAX_TABS_LIMIT);
      const selected = tabs.find((tab) => tab.id === tabSwitch.tabId || tab.codepilotSessionId === tabSwitch.tabId);
      if (!selected) {
        await deliver(adapter, {
          address: msg.address,
          text: 'That tab no longer exists. Send /tabs again.',
          parseMode: 'plain',
          replyToMessageId: msg.callbackMessageId ?? msg.messageId,
        });
        ack();
        return;
      }
      const result = switchToSessionTab(binding, tabs, selected);
      await deliver(adapter, {
        address: msg.address,
        text: result.response,
        parseMode: 'HTML',
        replyToMessageId: msg.callbackMessageId ?? msg.messageId,
      });
      if (result.shouldFlushBuffered) {
        await flushBufferedTabOutput(adapter, msg, binding, result.selected);
      }
      ack();
      return;
    }

    const handled = await broker.handlePermissionCallback(msg.callbackData, msg.address.chatId, msg.callbackMessageId);
    if (handled) {
      // Send confirmation
      const confirmMsg: OutboundMessage = {
        address: msg.address,
        text: 'Permission response recorded.',
        parseMode: 'plain',
      };
      await deliver(adapter, confirmMsg);
    }
    ack();
    return;
  }

  const rawText = msg.text.trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  // Handle attachment-only download failures — surface error to user instead of silently dropping
  if (!rawText && !hasAttachments) {
    const rawData = msg.raw as {
      imageDownloadFailed?: boolean;
      attachmentDownloadFailed?: boolean;
      failedCount?: number;
      failedLabel?: string;
      userVisibleError?: string;
    } | undefined;
    if (rawData?.userVisibleError) {
      await deliver(adapter, {
        address: msg.address,
        text: rawData.userVisibleError,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
    } else if (rawData?.imageDownloadFailed || rawData?.attachmentDownloadFailed) {
      const failureLabel = rawData.failedLabel || (rawData.imageDownloadFailed ? 'image(s)' : 'attachment(s)');
      await deliver(adapter, {
        address: msg.address,
        text: `Failed to download ${rawData.failedCount ?? 1} ${failureLabel}. Please try sending again.`,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
    }
    ack();
    return;
  }

  // ── Numeric shortcut for permission replies (feishu/qq/weixin only) ──
  // On mobile, typing `/perm allow <uuid>` is painful.
  // If the user sends "1", "2", or "3" and there is exactly one pending
  // permission for this chat, map it: 1→allow, 2→allow_session, 3→deny.
  //
  // Input normalization: mobile keyboards / IM clients may send fullwidth
  // digits (１２３), digits with zero-width joiners, or other Unicode
  // variants. NFKC normalization folds them all to ASCII 1/2/3.
  if (
    adapter.channelType === 'feishu'
    || adapter.channelType === 'qq'
    || adapter.channelType === 'weixin'
  ) {
    // eslint-disable-next-line no-control-regex
    const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    // For a single pending QUESTION, accept any 1..N option index. Ordinary
    // permissions keep the legacy 1/2/3 \u2192 allow/allow_session/deny mapping.
    const pendingForChat = store.listPendingPermissionLinksByChat(msg.address.chatId);
    const pendingQuestion = pendingForChat.length === 1 && pendingForChat[0].kind === 'question'
      ? pendingForChat[0]
      : null;
    if (pendingQuestion && /^[1-9][0-9]*$/.test(normalized)) {
      const index = Number.parseInt(normalized, 10);
      const callbackData = `perm:choice:${index}:${pendingQuestion.permissionRequestId}`;
      const handled = await broker.handlePermissionCallback(callbackData, msg.address.chatId);
      await deliver(adapter, {
        address: msg.address,
        text: handled ? `\u5DF2\u9009\u62E9\u7B2C ${index} \u9879\u3002` : '\u9009\u9879\u65E0\u6548\u6216\u95EE\u9898\u5DF2\u5931\u6548\u3002',
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
      ack();
      return;
    }
    if (/^[123]$/.test(normalized)) {
      const pendingLinks = store.listPendingPermissionLinksByChat(msg.address.chatId);
      if (pendingLinks.length === 1) {
        const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
        const action = actionMap[normalized];
        const permId = pendingLinks[0].permissionRequestId;
        const callbackData = `perm:${action}:${permId}`;
        const handled = await broker.handlePermissionCallback(callbackData, msg.address.chatId);
        const label = normalized === '1' ? 'Allow' : normalized === '2' ? 'Allow Session' : 'Deny';
        if (handled) {
          await deliver(adapter, {
            address: msg.address,
            text: `${label}: recorded.`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        } else {
          await deliver(adapter, {
            address: msg.address,
            text: `Permission not found or already resolved.`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        }
        ack();
        return;
      }
      if (pendingLinks.length > 1) {
        // Multiple pending permissions — numeric shortcut is ambiguous.
        await deliver(adapter, {
          address: msg.address,
          text: `Multiple pending permissions (${pendingLinks.length}). Please use the full command:\n/perm allow|allow_session|deny <id>`,
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
        });
        ack();
        return;
      }
      // pendingLinks.length === 0: no pending permissions, fall through as normal message
    } else if (rawText !== normalized && /^[123]$/.test(rawText) === false) {
      // Log when normalization changed the text — helps diagnose encoding issues
      const codePoints = [...rawText].map(c => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
      console.log(`[bridge-manager] Shortcut candidate raw codepoints: ${codePoints.join(' ')} → normalized: "${normalized}"`);
    }
  }

  // Check for IM commands (before sanitization — commands are validated individually)
  if (rawText.startsWith('/')) {
    await handleCommand(adapter, msg, rawText);
    ack();
    return;
  }

  // Sanitize general message text before routing to conversation engine
  const { text, truncated } = sanitizeInput(rawText);
  if (truncated) {
    console.warn(`[bridge-manager] Input truncated from ${rawText.length} to ${text.length} chars for chat ${msg.address.chatId}`);
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[TRUNCATED] Input truncated from ${rawText.length} chars`,
    });
  }

  if (!text && !hasAttachments) { ack(); return; }

  // Regular message — route to conversation engine
  const binding = router.resolve(msg.address);

  // Notify adapter that message processing is starting (e.g., typing indicator)
  adapter.onMessageStart?.(msg.address.chatId);

  // Create an AbortController so /stop can cancel this task externally.
  // Keyed by per-backend lane so a `/backend` switch doesn't accidentally
  // abort tasks belonging to the new backend.
  const taskAbort = new AbortController();
  const state = getState();
  const taskLane = laneKey(binding);
  state.activeTasks.set(taskLane, taskAbort);
  markActiveTabStarted(binding);

  // ── Streaming preview setup ──────────────────────────────────
  let previewState: StreamingPreviewState | null = null;
  const caps = adapter.getPreviewCapabilities?.(msg.address.chatId) ?? null;
  if (caps?.supported) {
    previewState = {
      draftId: generateDraftId(),
      chatId: msg.address.chatId,
      lastSentText: '',
      lastSentAt: 0,
      degraded: false,
      throttleTimer: null,
      pendingText: '',
    };
  }

  const streamCfg = previewState ? getStreamConfig(adapter.channelType) : null;

  // Build the preview onPartialText callback (or undefined if preview not supported)
  const previewOnPartialText = (previewState && streamCfg) ? (fullText: string) => {
    if (!isActiveOutputTarget(binding)) return;
    const ps = previewState!;
    const cfg = streamCfg!;
    if (ps.degraded) return;

    // Truncate to maxChars + ellipsis
    ps.pendingText = fullText.length > cfg.maxChars
      ? fullText.slice(0, cfg.maxChars) + '...'
      : fullText;

    const delta = ps.pendingText.length - ps.lastSentText.length;
    const elapsed = Date.now() - ps.lastSentAt;

    if (delta < cfg.minDeltaChars && ps.lastSentAt > 0) {
      // Not enough new content — schedule trailing-edge timer if not already set
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs);
      }
      return;
    }

    if (elapsed < cfg.intervalMs && ps.lastSentAt > 0) {
      // Too soon — schedule trailing-edge timer to ensure latest text is sent
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs - elapsed);
      }
      return;
    }

    // Clear any pending trailing-edge timer and flush immediately
    if (ps.throttleTimer) {
      clearTimeout(ps.throttleTimer);
      ps.throttleTimer = null;
    }
    flushPreview(adapter, ps, cfg);
  } : undefined;

  const onPartialText = previewOnPartialText;

  // ── Relay event throttle (Phase 4) ────────────────────────────
  // Per-binding intermediate status/tool/task messages, gated by
  // `outputVerbosity`:
  //   - quiet:   drop all intermediate events; only `final`/`error` reach IM
  //   - normal:  up to 8 intermediate messages per turn
  //   - verbose: up to 20 intermediate messages per turn
  // Final/error events are always delivered through the normal response path;
  // this aggregator only emits *intermediate* progress.
  const verbosity = binding.outputVerbosity ?? 'normal';
  const maxIntermediate = verbosity === 'quiet' ? 0 : verbosity === 'verbose' ? 20 : 8;
  const startGeneration = binding.backendGeneration ?? 0;
  let intermediateSent = 0;
  let lastEmittedSummary = '';

  const emitIntermediate = (text: string) => {
    if (!text || intermediateSent >= maxIntermediate) return;
    if (text === lastEmittedSummary) return;
    if (!isCurrentGeneration(binding.id, startGeneration)) return;
    if (!isActiveOutputTarget(binding)) return;
    lastEmittedSummary = text;
    intermediateSent += 1;
    // Fire-and-forget — adapter delivery shouldn't block stream consumption.
    deliver(adapter, {
      address: msg.address,
      text,
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    }, { sessionId: binding.codepilotSessionId }).catch(() => { /* non-critical */ });
  };

  const onRelayEvent = maxIntermediate > 0 ? (event: import('./host.js').RelayEvent) => {
    switch (event.kind) {
      case 'status':
        emitIntermediate(`⏳ ${event.text}`);
        break;
      case 'task':
        emitIntermediate(`📋 ${event.text}`);
        break;
      case 'process':
        emitIntermediate(event.text);
        break;
      case 'tool':
        if (verbosity === 'verbose' && event.status === 'running' && event.name) {
          emitIntermediate(`🛠 ${event.name}`);
        }
        break;
      // 'final' / 'error' are delivered by the main response path.
      default:
        break;
    }
  } : undefined;

  try {
    // Pass permission callback so requests are forwarded to IM immediately
    // during streaming (the stream blocks until permission is resolved).
    // Use text or empty string for image-only messages (prompt is still required by streamClaude)
    const promptText = text || (hasAttachments ? 'Describe this image.' : '');
    const responseStartedAt = Date.now();

    let result: Awaited<ReturnType<typeof engine.processMessage>>;
    try {
      result = await engine.processMessage(binding, promptText, async (perm) => {
        await broker.forwardPermissionRequest(
          adapter,
          msg.address,
          perm.permissionRequestId,
          perm.toolName,
          perm.toolInput,
          binding.codepilotSessionId,
          perm.suggestions,
          msg.messageId,
          perm.kind === 'question' && perm.choices && perm.questionText
            ? { kind: 'question', questionText: perm.questionText, choices: perm.choices }
            : undefined,
        );
      }, taskAbort.signal, hasAttachments ? msg.attachments : undefined, onPartialText, undefined, onRelayEvent);
    } catch (err) {
      result = {
        responseText: '',
        tokenUsage: null,
        hasError: true,
        errorMessage: err instanceof Error ? err.message : String(err),
        permissionRequests: [],
        sdkSessionId: null,
      };
    }

    const activeForOutput = isActiveOutputTarget(binding);

    // Send response text — render via channel-appropriate format.
    if (result.responseText) {
      if (activeForOutput) {
        const effectiveModel =
          binding.model || store.getSession(binding.codepilotSessionId)?.model || null;
        await deliverResponse(
          adapter,
          msg.address,
          result.responseText,
          binding.codepilotSessionId,
          msg.messageId,
          {
            tokenUsage: result.tokenUsage,
            model: effectiveModel,
            elapsedMs: Date.now() - responseStartedAt,
            status: result.hasError ? 'error' : 'completed',
          },
        );
      }
    } else if (result.hasError) {
      if (activeForOutput) {
        const errorResponse: OutboundMessage = {
          address: msg.address,
          text: `<b>Error:</b> ${escapeHtml(result.errorMessage)}`,
          parseMode: 'HTML',
          replyToMessageId: msg.messageId,
        };
        await deliver(adapter, errorResponse);
      }
    }

    // Persist the actual SDK session ID for future resume.
    // If the result has an error and no session ID was captured, clear the
    // stale ID so the next message starts fresh instead of retrying a broken resume.
    if (binding.id) {
      try {
        const update = computeSdkSessionUpdate(result.sdkSessionId, result.hasError);
        if (update !== null) {
          store.updateSdkSessionId(binding.codepilotSessionId, update);
        }
      } catch { /* best effort */ }
    }
    recordTabResult(binding, result, activeForOutput);
  } finally {
    // Clean up preview state
    if (previewState) {
      if (previewState.throttleTimer) {
        clearTimeout(previewState.throttleTimer);
        previewState.throttleTimer = null;
      }
      adapter.endPreview?.(msg.address.chatId, previewState.draftId);
    }

    state.activeTasks.delete(taskLane);
    // Notify adapter that message processing ended
    adapter.onMessageEnd?.(msg.address.chatId);
    // Commit the offset only after full processing (success or failure)
    ack();
  }
}

async function flushBufferedTabOutput(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  binding: ChannelBinding,
  tab: BridgeSessionTab,
): Promise<boolean> {
  const bufferedResponse = tab.bufferedResponseText ?? '';
  const bufferedError = tab.bufferedErrorMessage ?? '';
  if (!bufferedResponse && !bufferedError) return false;

  if (bufferedResponse) {
    await deliverResponse(adapter, msg.address, bufferedResponse, tab.codepilotSessionId, msg.messageId, {
      tokenUsage: null,
      model: tab.model || null,
    });
  } else {
    await deliver(adapter, {
      address: msg.address,
      text: `<b>Error:</b> ${escapeHtml(bufferedError)}`,
      parseMode: 'HTML',
      replyToMessageId: msg.messageId,
    }, { sessionId: tab.codepilotSessionId });
  }

  updateSessionTab(binding, tab.id, {
    bufferedResponseText: '',
    bufferedErrorMessage: '',
    bufferedAt: undefined,
    unread: false,
  });
  return true;
}

function activateSessionTab(binding: ChannelBinding, tab: BridgeSessionTab): void {
  const backend = tab.backend ?? binding.backend ?? 'claudecode';
  const backendSessionIds = tab.backendSessionIds
    ?? ({ [backend]: tab.codepilotSessionId } as Partial<Record<BackendName, string>>);
  router.updateBinding(binding.id, {
    codepilotSessionId: tab.codepilotSessionId,
    sdkSessionId: tab.sdkSessionId ?? '',
    workingDirectory: tab.workingDirectory,
    model: tab.model,
    mode: tab.mode,
    backend,
    backendGeneration: tab.backendGeneration ?? binding.backendGeneration ?? 0,
    backendSessionIds,
    backendSdkSessionIds: tab.backendSdkSessionIds ?? {},
    outputVerbosity: tab.outputVerbosity ?? binding.outputVerbosity,
    sandboxLevel: tab.sandboxLevel ?? binding.sandboxLevel,
    activeSessionTabId: tab.id,
    sessionTabs: binding.sessionTabs,
  });
  Object.assign(binding, {
    codepilotSessionId: tab.codepilotSessionId,
    sdkSessionId: tab.sdkSessionId ?? '',
    workingDirectory: tab.workingDirectory,
    model: tab.model,
    mode: tab.mode,
    backend,
    backendGeneration: tab.backendGeneration ?? binding.backendGeneration ?? 0,
    backendSessionIds,
    backendSdkSessionIds: tab.backendSdkSessionIds ?? {},
    outputVerbosity: tab.outputVerbosity ?? binding.outputVerbosity,
    sandboxLevel: tab.sandboxLevel ?? binding.sandboxLevel,
    activeSessionTabId: tab.id,
  });
}

/**
 * Handle IM slash commands.
 */
async function handleCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
): Promise<void> {
  const { store, lifecycle } = getBridgeContext();

  // Extract command and args (handle /command@botname format)
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  // Run dangerous-input detection on the full command text
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[BLOCKED] Dangerous input detected: ${dangerCheck.reason}`,
    });
    console.warn(`[bridge-manager] Blocked dangerous command input from chat ${msg.address.chatId}: ${dangerCheck.reason}`);
    await deliver(adapter, {
      address: msg.address,
      text: `Command rejected: invalid input detected.`,
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return;
  }

  let response = '';
  let responseParseMode: OutboundMessage['parseMode'] = 'HTML';
  let afterResponse: (() => Promise<void>) | undefined;

  switch (command) {
    case '/ctl': {
      const match = args.match(/^(\S+)(?:\s+([\s\S]*))?$/);
      const action = (match?.[1] ?? '').toLowerCase();
      const controlArgs = (match?.[2] ?? '').trim();
      if (!action) {
        response = 'Usage: /ctl status|health|logs [N]|worker status|worker start|worker stop|worker restart';
        responseParseMode = 'plain';
        break;
      }
      if (!lifecycle.handleControlCommand) {
        response = 'Control commands are not available in this host.';
        responseParseMode = 'plain';
        break;
      }
      try {
        const result = await lifecycle.handleControlCommand({
          action,
          args: controlArgs,
          rawText: text,
          channelType: adapter.channelType,
          chatId: msg.address.chatId,
          userId: msg.address.userId,
          messageId: msg.messageId,
        });
        response = result.text;
        responseParseMode = result.parseMode ?? 'plain';
      } catch (err) {
        response = `Control command failed: ${err instanceof Error ? err.message : String(err)}`;
        responseParseMode = 'plain';
      }
      break;
    }

    case '/start':
      response = [
        '<b>Remote Agent Control Bridge</b>',
        '',
        'Send any message to interact with Claude.',
        '',
        '<b>Commands:</b>',
        '/new [path] - Start new session',
        '/restart - Restart current session',
        '/reload - Reload current session',
        '/tabs [n] - List recent current-backend bridge/native sessions',
        '/tab &lt;n&gt; - Switch logical session',
        '/search &lt;description&gt; [n] - Search recent current-backend sessions',
        '/pop - Show buffered output for current session',
        '/peek - Summarize current session progress (read-only)',
        '/resume &lt;native_session_id&gt; - Resume current backend native session',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd /path - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/status - Show current status',
        '/sessions - List recent sessions',
        '/stop - Stop current session',
        '/backend codex|claude|copilot - Switch backend',
        '/verbose quiet|normal|verbose - Set output verbosity',
        '/sandbox ro|rw|full - Set tool capability cap',
        '/repair - Reset in-flight state (keep backend)',
        '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission',
        '/ctl status|health|logs [N]|worker status|worker start|worker stop|worker restart - Control plane',
        '/help - Show this help',
      ].join('\n');
      break;

    case '/new': {
      const oldBinding = router.resolve(msg.address);
      const tabs = normalizeSessionTabs(oldBinding);
      const oldActiveId = oldBinding.activeSessionTabId ?? oldBinding.codepilotSessionId;
      const oldActiveTab = tabs.find((tab) => tab.id === oldActiveId)
        ?? snapshotBindingAsTab(oldBinding, { id: oldActiveId });
      updateSessionTab(oldBinding, oldActiveTab.id, {
        ...snapshotBindingAsTab(oldBinding, {
          id: oldActiveTab.id,
          status: getState().activeTasks.has(laneKey(oldBinding)) ? 'running' : oldActiveTab.status ?? 'idle',
          bufferedResponseText: oldActiveTab.bufferedResponseText,
          bufferedErrorMessage: oldActiveTab.bufferedErrorMessage,
          bufferedAt: oldActiveTab.bufferedAt,
          unread: oldActiveTab.unread ?? false,
          createdAt: oldActiveTab.createdAt,
        }),
      });

      let workDir: string | undefined;
      if (args) {
        const validated = validateWorkingDirectory(args);
        if (!validated) {
          response = 'Invalid path. Must be an absolute path without traversal sequences.';
          break;
        }
        workDir = validated;
      }
      const nextCwd = workDir || oldBinding.workingDirectory || store.getSetting('bridge_default_work_dir') || '';
      const session = store.createSession(
        `Bridge: ${msg.address.displayName || msg.address.chatId}`,
        oldBinding.model || '',
        undefined,
        nextCwd,
        oldBinding.mode,
      );
      const defaultProviderId = store.getDefaultProviderId();
      if (defaultProviderId) {
        store.updateSessionProviderId(session.id, defaultProviderId);
      }

      const backend = getActiveBackend(oldBinding);
      const now = new Date().toISOString();
      const newTab = snapshotBindingAsTab(oldBinding, {
        id: session.id,
        codepilotSessionId: session.id,
        sdkSessionId: '',
        workingDirectory: session.working_directory,
        model: session.model,
        mode: oldBinding.mode,
        backend,
        backendGeneration: oldBinding.backendGeneration ?? 0,
        backendSessionIds: { [backend]: session.id } as Partial<Record<BackendName, string>>,
        backendSdkSessionIds: {},
        status: 'idle',
        bufferedResponseText: '',
        bufferedErrorMessage: '',
        unread: false,
        createdAt: now,
        updatedAt: now,
      });
      upsertSessionTab(oldBinding, newTab, newTab.id);
      activateSessionTab(oldBinding, newTab);

      response = [
        'New session created.',
        `Tab: <b>${normalizeSessionTabs(oldBinding).findIndex((tab) => tab.id === newTab.id) + 1}</b>`,
        `Session: <code>${newTab.codepilotSessionId.slice(0, 8)}...</code>`,
        `CWD: <code>${escapeHtml(newTab.workingDirectory || '~')}</code>`,
        'Previous task, if still running, remains in the background.',
      ].join('\n');
      break;
    }

    case '/restart':
    case '/reload': {
      if (args) {
        response = `Usage: ${command}`;
        break;
      }
      const isReload = command === '/reload';

      const binding = router.resolve(msg.address);
      const tabs = normalizeSessionTabs(binding);
      const activeId = binding.activeSessionTabId ?? binding.codepilotSessionId;
      const activeIndex = tabs.findIndex((tab) =>
        tab.id === activeId || tab.codepilotSessionId === binding.codepilotSessionId);
      if (activeIndex < 0) {
        response = 'No active session found. Use /new to start one.';
        break;
      }

      const oldTab = tabs[activeIndex];
      const state = getState();
      const currentTask = state.activeTasks.get(laneKey(binding));
      if (currentTask) {
        try { currentTask.abort(); } catch { /* best effort */ }
        state.activeTasks.delete(laneKey(binding));
      }

      const backend = oldTab.backend ?? getActiveBackend(binding);
      const nextGen = Math.max(oldTab.backendGeneration ?? 0, binding.backendGeneration ?? 0) + 1;
      const session = store.createSession(
        `Bridge: ${msg.address.displayName || msg.address.chatId} [restart]`,
        oldTab.model || binding.model || '',
        undefined,
        oldTab.workingDirectory || binding.workingDirectory,
        oldTab.mode || binding.mode,
      );
      const defaultProviderId = store.getDefaultProviderId();
      if (defaultProviderId) {
        store.updateSessionProviderId(session.id, defaultProviderId);
      }

      const now = new Date().toISOString();
      const restartedTab = snapshotBindingAsTab(binding, {
        id: session.id,
        codepilotSessionId: session.id,
        sdkSessionId: '',
        workingDirectory: session.working_directory,
        model: session.model,
        mode: oldTab.mode || binding.mode,
        backend,
        backendGeneration: nextGen,
        backendSessionIds: { [backend]: session.id } as Partial<Record<BackendName, string>>,
        backendSdkSessionIds: {},
        outputVerbosity: oldTab.outputVerbosity ?? binding.outputVerbosity ?? 'normal',
        sandboxLevel: oldTab.sandboxLevel ?? binding.sandboxLevel ?? 'rw',
        status: 'idle',
        bufferedResponseText: '',
        bufferedErrorMessage: '',
        bufferedAt: undefined,
        unread: false,
        createdAt: now,
        updatedAt: now,
      });

      tabs[activeIndex] = restartedTab;
      binding.sessionTabs = tabs;
      binding.activeSessionTabId = restartedTab.id;
      router.updateBinding(binding.id, {
        sessionTabs: tabs,
        activeSessionTabId: restartedTab.id,
      });
      activateSessionTab(binding, restartedTab);

      response = [
        isReload ? 'Session reloaded.' : 'Session restarted.',
        `Tab: <b>${activeIndex + 1}</b>`,
        `Session: <code>${restartedTab.codepilotSessionId.slice(0, 8)}...</code>`,
        `Backend: <b>${escapeHtml(backend)}</b>`,
        `CWD: <code>${escapeHtml(restartedTab.workingDirectory || '~')}</code>`,
        currentTask
          ? 'Current task was stopped. Other tabs were not touched.'
          : 'Only the current tab was replaced. Other tabs were not touched.',
        'New skills/MCP tools should be visible in this fresh session.',
      ].join('\n');
      break;
    }

    case '/tabs': {
      const binding = router.resolve(msg.address);
      const limit = parseTabsLimit(args);
      const tabs = listCurrentBackendRecentSessionTabs(binding, limit);
      rememberTabListing(binding, tabs);
      if (await sendTabsChoiceCard(adapter, msg, binding, tabs)) {
        return;
      }
      response = buildTabsText(binding, tabs);
      break;
    }

    case '/tab':
    case '/session': {
      const binding = router.resolve(msg.address);
      const tabs = getRememberedTabListing(binding)
        ?? listCurrentBackendRecentSessionTabs(binding, DEFAULT_TABS_LIMIT);
      const requested = Number.parseInt(args, 10);
      if (!Number.isInteger(requested) || requested < 1 || requested > tabs.length) {
        response = `Usage: /tab &lt;1-${tabs.length}&gt;`;
        break;
      }

      const selected = tabs[requested - 1];
      const result = switchToSessionTab(binding, tabs, selected);
      if (result.shouldFlushBuffered) {
        afterResponse = async () => { await flushBufferedTabOutput(adapter, msg, binding, result.selected); };
      }
      response = result.response;
      break;
    }

    case '/search': {
      const { query, limit } = parseSearchArgs(args);
      if (!query) {
        response = 'Usage: /search &lt;session description&gt; [recent_session_count]';
        break;
      }
      const binding = router.resolve(msg.address);
      const pick = await searchBestSessionTab(binding, query, new Set(), limit);
      if (!pick) {
        response = 'No matching session found. Try a more specific description, or use /tabs to choose manually.';
        break;
      }
      await sendSearchResult(adapter, msg, binding, query, pick, limit, []);
      return;
    }

    case '/pop': {
      const binding = router.resolve(msg.address);
      const tabs = normalizeSessionTabs(binding);
      const activeId = binding.activeSessionTabId;
      const activeTab = tabs.find((tab) => tab.id === activeId)
        ?? tabs.find((tab) => tab.codepilotSessionId === binding.codepilotSessionId);
      if (!activeTab) {
        response = 'No active tab found. Use /new to start a session.';
        break;
      }

      const status = getTabRuntimeStatus(binding, activeTab);
      if (activeTab.bufferedResponseText || activeTab.bufferedErrorMessage) {
        response = `Popping buffered output for current tab.`;
        afterResponse = async () => { await flushBufferedTabOutput(adapter, msg, binding, activeTab); };
      } else if (status === 'running') {
        response = 'Task is still running. I will keep this tab active and send the result here when it finishes.';
      } else if (status === 'unavailable') {
        response = 'This task is no longer attached to a running daemon. Use /repair or start a new tab if it cannot continue.';
      } else {
        response = 'No buffered output for current tab.';
      }
      break;
    }

    case '/peek': {
      const binding = router.resolve(msg.address);
      const data = await collectPeekData(binding);
      await sendPeekResult(adapter, msg, data);
      return;
    }

    case '/resume': {
      if (!args) {
        response = 'Usage: /resume &lt;native_session_id&gt;';
        break;
      }
      if (!validateNativeSessionId(args)) {
        response = 'Invalid native session ID format.';
        break;
      }

      const nativeSessionId = args.trim();
      const binding = router.resolve(msg.address);
      const backend = getActiveBackend(binding);
      const nextBackendSdkSessionIds = {
        ...(binding.backendSdkSessionIds ?? {}),
        [backend]: nativeSessionId,
      } as Partial<Record<BackendName, string>>;

      try {
        store.updateSdkSessionId(binding.codepilotSessionId, nativeSessionId);
      } catch { /* best effort; binding update below is authoritative for routing */ }

      router.updateBinding(binding.id, {
        sdkSessionId: nativeSessionId,
        backendSdkSessionIds: nextBackendSdkSessionIds,
      });
      updateSessionTab(binding, binding.activeSessionTabId ?? binding.codepilotSessionId, {
        sdkSessionId: nativeSessionId,
        backendSdkSessionIds: nextBackendSdkSessionIds,
      });

      response = [
        `Native session resumed: <code>${escapeHtml(nativeSessionId)}</code>`,
        `Backend: <b>${escapeHtml(backend)}</b>`,
        `Bridge session: <code>${escapeHtml(binding.codepilotSessionId)}</code>`,
      ].join('\n');
      break;
    }

    case '/bind': {
      if (!args) {
        response = 'Usage: /bind &lt;session_id&gt;';
        break;
      }
      if (!validateSessionId(args)) {
        response = 'Invalid session ID format. Expected a 32-64 character hex/UUID string.';
        break;
      }
      const binding = router.bindToSession(msg.address, args);
      if (binding) {
        response = `Bound to session <code>${args.slice(0, 8)}...</code>`;
      } else {
        response = 'Session not found.';
      }
      break;
    }

    case '/cwd': {
      if (!args) {
        response = 'Usage: /cwd /path/to/directory';
        break;
      }
      const validatedPath = validateWorkingDirectory(args);
      if (!validatedPath) {
        response = 'Invalid path. Must be an absolute path without traversal sequences or special characters.';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { workingDirectory: validatedPath });
      updateSessionTab(binding, binding.activeSessionTabId ?? binding.codepilotSessionId, {
        workingDirectory: validatedPath,
      });
      response = `Working directory set to <code>${escapeHtml(validatedPath)}</code>`;
      break;
    }

    case '/mode': {
      if (!validateMode(args)) {
        response = 'Usage: /mode plan|code|ask';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { mode: args });
      updateSessionTab(binding, binding.activeSessionTabId ?? binding.codepilotSessionId, {
        mode: args,
      });
      response = `Mode set to <b>${args}</b>`;
      break;
    }

    case '/status': {
      const binding = router.resolve(msg.address);
      const backend = getActiveBackend(binding);
      const nativeSessionId = getActiveNativeSessionId(binding);
      response = [
        '<b>Bridge Status</b>',
        '',
        `Backend: <b>${escapeHtml(backend)}</b>`,
        `Bridge session: <code>${escapeHtml(binding.codepilotSessionId)}</code>`,
        `Native session: <code>${escapeHtml(nativeSessionId || 'none (fresh)')}</code>`,
        `CWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`,
        `Mode: <b>${binding.mode}</b>`,
        `Model: <code>${binding.model || 'default'}</code>`,
        `Output: <b>${escapeHtml(binding.outputVerbosity ?? 'normal')}</b>`,
        `Sandbox: <b>${escapeHtml(binding.sandboxLevel ?? 'rw')}</b>`,
        `Feishu history injection: <b>disabled</b>`,
      ].join('\n');
      break;
    }

    case '/sessions': {
      const bindings = router.listBindings(adapter.channelType);
      if (bindings.length === 0) {
        response = 'No sessions found.';
      } else {
        const lines = ['<b>Sessions:</b>', ''];
        for (const b of bindings.slice(0, 10)) {
          const active = b.active ? 'active' : 'inactive';
          lines.push(`<code>${b.codepilotSessionId.slice(0, 8)}...</code> [${active}] ${escapeHtml(b.workingDirectory || '~')}`);
        }
        response = lines.join('\n');
      }
      break;
    }

    case '/stop': {
      const binding = router.resolve(msg.address);
      const st = getState();
      const lane = laneKey(binding);
      const taskAbort = st.activeTasks.get(lane);
      if (taskAbort) {
        taskAbort.abort();
        st.activeTasks.delete(lane);
        response = 'Stopping current task...';
      } else {
        response = 'No task is currently running.';
      }
      break;
    }

    case '/backend':
    {
      // /backend                  → show current backend
      // /backend codex|claude|claudecode|copilot → switch
      const requested = args.trim().toLowerCase();
      const binding = router.resolve(msg.address);
      const current = binding.backend ?? 'claudecode';
      if (!requested) {
        response = `Current backend: <b>${escapeHtml(current)}</b>\nUsage: /backend codex|claude|copilot`;
        break;
      }
      // Map alias
      const target: BackendName | null =
        requested === 'claude' || requested === 'claudecode' ? 'claudecode'
        : requested === 'codex' ? 'codex'
        : requested === 'copilot' ? 'copilot'
        : null;
      if (!target) {
        response = `Unknown backend "${escapeHtml(requested)}". Use one of: codex, claude, copilot.`;
        break;
      }
      if (target === current) {
        response = `Already on backend <b>${escapeHtml(target)}</b>.`;
        break;
      }

      const tabs = normalizeSessionTabs(binding);
      const activeId = binding.activeSessionTabId ?? binding.codepilotSessionId;
      const activeTab = tabs.find((tab) => tab.id === activeId)
        ?? snapshotBindingAsTab(binding, { id: activeId });
      updateSessionTab(binding, activeTab.id, {
        ...snapshotBindingAsTab(binding, {
          id: activeTab.id,
          status: getState().activeTasks.has(laneKey(binding)) ? 'running' : activeTab.status ?? 'idle',
          bufferedResponseText: activeTab.bufferedResponseText,
          bufferedErrorMessage: activeTab.bufferedErrorMessage,
          bufferedAt: activeTab.bufferedAt,
          unread: activeTab.unread ?? false,
          createdAt: activeTab.createdAt,
          activityAt: activeTab.activityAt,
        }),
      });

      const nextGen = (binding.backendGeneration ?? 0) + 1;
      const targetBinding = { ...binding, backend: target };
      const recentTargetTab = mergedCurrentBackendRecentChatSessionTabs(targetBinding, 1)[0];
      if (recentTargetTab) {
        const materialized = materializeNativeSessionTab(targetBinding, recentTargetTab);
        const targetSdkSessionId = materialized.backendSdkSessionIds?.[target]
          ?? materialized.sdkSessionId
          ?? materialized.nativeSessionId
          ?? '';
        const nextBackendSessionIds: Partial<Record<BackendName, string>> = {
          ...(binding.backendSessionIds ?? {}),
          ...(materialized.backendSessionIds ?? {}),
          [target]: materialized.codepilotSessionId,
        };
        const nextBackendSdkSessionIds: Partial<Record<BackendName, string>> = {
          ...(binding.backendSdkSessionIds ?? {}),
          ...(materialized.backendSdkSessionIds ?? {}),
        };
        if (targetSdkSessionId) {
          nextBackendSdkSessionIds[target] = targetSdkSessionId;
        } else {
          delete nextBackendSdkSessionIds[target];
        }
        const nextTab: BridgeSessionTab = {
          ...materialized,
          sdkSessionId: targetSdkSessionId,
          backend: target,
          backendGeneration: nextGen,
          backendSessionIds: nextBackendSessionIds,
          backendSdkSessionIds: nextBackendSdkSessionIds,
        };
        upsertSessionTab(binding, nextTab, nextTab.id);
        activateSessionTab(binding, nextTab);

        response = [
          `Backend switched: <b>${escapeHtml(current)}</b> → <b>${escapeHtml(target)}</b>`,
          `Selected session: <code>${escapeHtml(nextTab.codepilotSessionId.slice(0, 8))}...</code>`,
          `Generation: ${nextGen}`,
          'Previous task, if still running, remains in the background.',
        ].join('\n');
        break;
      }

      // Resolve (or lazily create) the per-backend session lane id.
      const existingLaneIds: Partial<Record<BackendName, string>> = { ...(binding.backendSessionIds ?? {}) };
      let laneSessionId = existingLaneIds[target];
      if (!laneSessionId) {
        const newSession = store.createSession(
          `Bridge: ${msg.address.displayName || msg.address.chatId} [${target}]`,
          binding.model || '',
          undefined,
          binding.workingDirectory,
          binding.mode,
        );
        laneSessionId = newSession.id;
        existingLaneIds[target] = laneSessionId;
      }

      // Read the lane session's authoritative sdkSessionId so resume actually
      // continues the right provider session. Fall back to the per-binding
      // cache (legacy bindings) and finally to ''.
      const laneSession = store.getSession(laneSessionId);
      const laneSdkId =
        laneSession?.sdkSessionId
        ?? (binding.backendSdkSessionIds ?? {})[target]
        ?? '';

      const targetTab = tabs.find((tab) => tab.codepilotSessionId === laneSessionId && tab.backend === target)
        ?? snapshotBindingAsTab(binding, {
          id: laneSessionId,
          codepilotSessionId: laneSessionId,
          sdkSessionId: laneSdkId,
          backend: target,
          backendGeneration: nextGen,
          backendSessionIds: existingLaneIds,
          backendSdkSessionIds: binding.backendSdkSessionIds ?? {},
          status: 'idle',
          bufferedResponseText: '',
          bufferedErrorMessage: '',
          unread: false,
          createdAt: laneSession?.id ? new Date().toISOString() : binding.createdAt,
        });
      const nextTab = {
        ...targetTab,
        sdkSessionId: laneSdkId,
        backend: target,
        backendGeneration: nextGen,
        backendSessionIds: existingLaneIds,
      };
      upsertSessionTab(binding, nextTab, nextTab.id);
      activateSessionTab(binding, nextTab);

      response = [
        `Backend switched: <b>${escapeHtml(current)}</b> → <b>${escapeHtml(target)}</b>`,
        `New session lane: <code>${escapeHtml(laneSessionId.slice(0, 8))}...</code>`,
        `Generation: ${nextGen}`,
        'Previous task, if still running, remains in the background.',
      ].join('\n');
      break;
    }

    case '/repair': {
      // Bump generation so any in-flight task's output is silenced,
      // drop the active-task entry (the underlying task may keep
      // running but its emissions are gated), and reset adapter UI.
      const binding = router.resolve(msg.address);
      const st = getState();
      const oldLane = laneKey(binding);
      const oldTask = st.activeTasks.get(oldLane);
      if (oldTask) {
        try { oldTask.abort(); } catch { /* best effort */ }
        st.activeTasks.delete(oldLane);
      }
      const nextGen = (binding.backendGeneration ?? 0) + 1;
      router.updateBinding(binding.id, { backendGeneration: nextGen });

      // Tell adapter to clear any chat-local UI bookkeeping.
      try {
        const a = adapter as unknown as { resetChatState?: (chatId: string) => void };
        a.resetChatState?.(msg.address.chatId);
      } catch { /* non-critical */ }

      response = [
        '<b>Repair complete.</b>',
        `Backend: <b>${escapeHtml(binding.backend ?? 'claudecode')}</b>`,
        `Generation: ${nextGen}`,
        'Any in-flight responses will be discarded.',
      ].join('\n');
      break;
    }

    case '/verbose': {
      const binding = router.resolve(msg.address);
      const requested = args.trim().toLowerCase();
      if (!requested) {
        response = `Current verbosity: <b>${escapeHtml(binding.outputVerbosity ?? 'normal')}</b>\nUsage: /verbose quiet|normal|verbose`;
        break;
      }
      if (requested !== 'quiet' && requested !== 'normal' && requested !== 'verbose') {
        response = 'Usage: /verbose quiet|normal|verbose';
        break;
      }
      router.updateBinding(binding.id, { outputVerbosity: requested as 'quiet' | 'normal' | 'verbose' });
      updateSessionTab(binding, binding.activeSessionTabId ?? binding.codepilotSessionId, {
        outputVerbosity: requested as 'quiet' | 'normal' | 'verbose',
      });
      response = `Verbosity set to <b>${escapeHtml(requested)}</b>`;
      break;
    }

    case '/sandbox': {
      // Per-binding tool capability cap. Does NOT rebuild session / thread / SDK ids.
      const binding = router.resolve(msg.address);
      const raw = args.trim().toLowerCase();
      const describe = (lvl: 'ro' | 'rw' | 'full') =>
        lvl === 'ro' ? 'ro (read-only)'
        : lvl === 'full' ? 'full (danger-full-access)'
        : 'rw (workspace-write)';
      if (!raw) {
        const current = binding.sandboxLevel ?? 'rw';
        response = [
          `Current sandbox: <b>${escapeHtml(describe(current))}</b>`,
          'Usage: /sandbox ro|rw|full',
          '  ro   — 只读 (aliases: read, readonly)',
          '  rw   — 读写工作目录 (aliases: write, workspace)',
          '  full — 完全权限，跳过审批 (aliases: admin, danger) ⚠',
        ].join('\n');
        break;
      }
      let level: 'ro' | 'rw' | 'full' | null = null;
      if (raw === 'ro' || raw === 'read' || raw === 'readonly') level = 'ro';
      else if (raw === 'rw' || raw === 'write' || raw === 'workspace') level = 'rw';
      else if (raw === 'full' || raw === 'admin' || raw === 'danger') level = 'full';
      if (!level) {
        response = 'Usage: /sandbox ro|rw|full';
        break;
      }
      router.updateBinding(binding.id, { sandboxLevel: level });
      updateSessionTab(binding, binding.activeSessionTabId ?? binding.codepilotSessionId, {
        sandboxLevel: level,
      });
      const warn = level === 'full'
        ? '\n⚠ <b>full</b> 模式会跳过所有审批，请仅在受信任的环境中使用。'
        : '';
      response = `沙箱权限已设为：<b>${escapeHtml(describe(level))}</b>${warn}`;
      break;
    }

    case '/perm': {
      // Text-based permission approval fallback (for channels without inline buttons)
      // Usage: /perm allow <id> | /perm allow_session <id> | /perm deny <id>
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        response = 'Usage: /perm allow|allow_session|deny &lt;permission_id&gt;';
        break;
      }
      const callbackData = `perm:${permAction}:${permId}`;
      const handled = await broker.handlePermissionCallback(callbackData, msg.address.chatId);
      if (handled) {
        response = `Permission ${permAction}: recorded.`;
      } else {
        response = `Permission not found or already resolved.`;
      }
      break;
    }

    case '/help':
      response = [
        '<b>Remote Agent Control Bridge Commands</b>',
        '',
        '/new [path] - Start new session',
        '/restart - Restart current session',
        '/reload - Reload current session',
        '/tabs [n] - List recent current-backend bridge/native sessions',
        '/tab &lt;n&gt; - Switch logical session',
        '/search &lt;description&gt; [n] - Search recent current-backend sessions',
        '/pop - Show buffered output for current session',
        '/peek - Summarize current session progress (read-only)',
        '/resume &lt;native_session_id&gt; - Resume current backend native session',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd /path - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/status - Show current status',
        '/sessions - List recent sessions',
        '/stop - Stop current session',
        '/backend codex|claude|copilot - Switch backend (per-binding)',
        '/verbose quiet|normal|verbose - Set output verbosity',
        '/sandbox ro|rw|full - Set tool capability cap (read-only/workspace-write/full)',
        '/repair - Reset in-flight state (keep backend)',
        '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission request',
        '/ctl status|health|logs [N]|worker status|worker start|worker stop|worker restart - Control plane',
        '1/2/3 - Quick permission reply (Feishu/QQ/WeChat, single pending)',
        '/help - Show this help',
      ].join('\n');
      break;

    default:
      response = `Unknown command: ${escapeHtml(command)}\nType /help for available commands.`;
  }

  if (response) {
    await deliver(adapter, {
      address: msg.address,
      text: response,
      parseMode: responseParseMode,
      replyToMessageId: msg.messageId,
    });
  }
  if (afterResponse) {
    await afterResponse();
  }
}

// ── SDK Session Update Logic ─────────────────────────────────

/**
 * Compute the sdkSessionId value to persist after a conversation result.
 * Returns the new value to write, or null if no update is needed.
 *
 * Rules:
 * - If result has sdkSessionId AND no error → save the new ID
 * - If result has error (regardless of sdkSessionId) → clear to empty string
 * - Otherwise → no update needed
 */
export function computeSdkSessionUpdate(
  sdkSessionId: string | null | undefined,
  hasError: boolean,
): string | null {
  if (sdkSessionId && !hasError) {
    return sdkSessionId;
  }
  if (hasError) {
    return '';
  }
  return null;
}

// ── Test-only export ─────────────────────────────────────────
// Exposed so integration tests can exercise handleMessage directly
// without wiring up the full adapter loop.
/** @internal */
export const _testOnly = { handleMessage };
