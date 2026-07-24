/**
 * Unit tests for bridge-manager.
 *
 * Tests cover:
 * - Session lock concurrency: same-session serialization
 * - Session lock concurrency: different-session parallelism
 * - Bridge start/stop lifecycle
 * - Auto-start idempotency
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initBridgeContext } from '../../lib/bridge/context';
import { resetDeliveryRateLimiterForTests } from '../../lib/bridge/delivery-layer';
import type { BridgeStore, BridgeSession, LifecycleHooks, LLMProvider, StreamChatParams } from '../../lib/bridge/host';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { BridgeSessionTab, ChannelBinding, OutboundMessage, SendResult } from '../../lib/bridge/types';

function resetBridgeTestState(): void {
  const state = (globalThis as Record<string, any>)['__bridge_manager__'];
  if (state) {
    for (const abort of state.loopAborts?.values?.() ?? []) {
      try { abort.abort(); } catch { /* ignore */ }
    }
    for (const abort of state.activeTasks?.values?.() ?? []) {
      try { abort.abort(); } catch { /* ignore */ }
    }
    state.tabListings?.clear?.();
    state.searchResults?.clear?.();
    state.sessionLocks?.clear?.();
  }
  delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
  delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  resetDeliveryRateLimiterForTests();
}

// ── Test the session lock mechanism directly ────────────────
// We test the processWithSessionLock pattern by extracting its logic.

function createSessionLocks() {
  const locks = new Map<string, Promise<void>>();

  function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const prev = locks.get(sessionId) || Promise.resolve();
    const current = prev.then(fn, fn);
    locks.set(sessionId, current);
    // Suppress unhandled rejection on the cleanup chain — callers handle the error on `current` directly
    current.finally(() => {
      if (locks.get(sessionId) === current) {
        locks.delete(sessionId);
      }
    }).catch(() => {});
    return current;
  }

  return { locks, processWithSessionLock };
}

describe('bridge-manager session locks', () => {
  it('serializes same-session operations', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const order: number[] = [];

    const p1 = processWithSessionLock('session-1', async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push(1);
    });

    const p2 = processWithSessionLock('session-1', async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    assert.deepStrictEqual(order, [1, 2], 'Same-session operations should be serialized');
  });

  it('allows different-session operations to run concurrently', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const started: string[] = [];
    const completed: string[] = [];

    const p1 = processWithSessionLock('session-A', async () => {
      started.push('A');
      await new Promise(r => setTimeout(r, 50));
      completed.push('A');
    });

    const p2 = processWithSessionLock('session-B', async () => {
      started.push('B');
      await new Promise(r => setTimeout(r, 10));
      completed.push('B');
    });

    await Promise.all([p1, p2]);
    // Both should start before either completes (concurrent)
    assert.equal(started.length, 2);
    // B should complete first since it has shorter delay
    assert.equal(completed[0], 'B');
    assert.equal(completed[1], 'A');
  });

  it('continues after errors in locked operations', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const order: number[] = [];

    const p1 = processWithSessionLock('session-1', async () => {
      order.push(1);
      throw new Error('test error');
    });

    const p2 = processWithSessionLock('session-1', async () => {
      order.push(2);
    });

    await p1.catch(() => {});
    await p2;
    assert.deepStrictEqual(order, [1, 2], 'Should continue after error');
  });

  it('cleans up completed locks', async () => {
    const { locks, processWithSessionLock } = createSessionLocks();

    await processWithSessionLock('session-1', async () => {});

    // Allow microtask to complete for finally() cleanup
    await new Promise(r => setTimeout(r, 0));
    assert.equal(locks.size, 0, 'Lock should be cleaned up after completion');
  });
});

// ── Lifecycle tests ─────────────────────────────────────────

describe('bridge-manager lifecycle', () => {
  beforeEach(() => {
    resetBridgeTestState();
  });
  afterEach(resetBridgeTestState);

  it('getStatus returns not running when bridge has not started', async () => {
    const store = createMinimalStore({ remote_bridge_enabled: 'false' });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    // Import dynamically to get fresh module state
    const { getStatus } = await import('../../lib/bridge/bridge-manager');
    const status = getStatus();
    assert.equal(status.running, false);
    assert.equal(status.adapters.length, 0);
  });
});

describe('bridge-manager commands — native session routing', () => {
  beforeEach(() => {
    resetBridgeTestState();
    const nativeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-bridge-native-empty-'));
    process.env.CTI_CLAUDE_PROJECTS_DIR = path.join(nativeRoot, 'claude-projects');
    process.env.CTI_CODEX_SESSIONS_DIR = path.join(nativeRoot, 'codex-sessions');
    fs.mkdirSync(process.env.CTI_CLAUDE_PROJECTS_DIR, { recursive: true });
    fs.mkdirSync(process.env.CTI_CODEX_SESSIONS_DIR, { recursive: true });
  });
  afterEach(resetBridgeTestState);

  it('/status shows full bridge and native session ids', async () => {
    const nativeSessionId = '019e64a9-9be8-7823-a1e6-747e1fb7433b';
    const bridgeSessionId = '0372c636-4840-4160-bc52-0104d69e1378';
    const { store } = createCommandStore({
      codepilotSessionId: bridgeSessionId,
      sdkSessionId: nativeSessionId,
      backend: 'codex',
      backendSdkSessionIds: { codex: nativeSessionId },
    });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent);
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-status',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/status',
      timestamp: Date.now(),
    });

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Backend: <b>codex<\/b>/);
    assert.ok(sent[0].text.includes(`Bridge session: <code>${bridgeSessionId}</code>`));
    assert.ok(sent[0].text.includes(`Native session: <code>${nativeSessionId}</code>`));
    assert.match(sent[0].text, /Feishu history injection: <b>disabled<\/b>/);
  });

  it('/ctl delegates to the host control handler', async () => {
    const { store } = createCommandStore();
    const calls: Array<{
      action: string;
      args: string;
      rawText: string;
      channelType: string;
      chatId: string;
      userId?: string;
      messageId: string;
    }> = [];
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {
        handleControlCommand: async (request) => {
          calls.push(request);
          return { text: 'ctl ok', parseMode: 'plain' };
        },
      },
    });

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent);
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-ctl',
      address: { channelType: 'feishu', chatId: 'chat-1', userId: 'user-1' },
      text: '/ctl logs 20',
      timestamp: Date.now(),
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, 'ctl ok');
    assert.equal(sent[0].parseMode, 'plain');
    assert.deepStrictEqual(calls, [{
      action: 'logs',
      args: '20',
      rawText: '/ctl logs 20',
      channelType: 'feishu',
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'msg-ctl',
    }]);
  });

  it('/resume binds the current backend to the requested native session id', async () => {
    const oldNativeSessionId = '019e64a9-9be8-7823-a1e6-747e1fb7433b';
    const nextNativeSessionId = '019e64ff-1111-7222-8333-abcdefabcdef';
    const bridgeSessionId = '0372c636-4840-4160-bc52-0104d69e1378';
    const { store, binding, sessions } = createCommandStore({
      codepilotSessionId: bridgeSessionId,
      sdkSessionId: oldNativeSessionId,
      backend: 'codex',
      backendSdkSessionIds: {
        codex: oldNativeSessionId,
        claudecode: 'a50476c9-09a0-4299-a0f2-c082cc35c659',
      },
    });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent);
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-resume',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: `/resume ${nextNativeSessionId}`,
      timestamp: Date.now(),
    });

    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes(`Native session resumed: <code>${nextNativeSessionId}</code>`));
    assert.equal(binding.codepilotSessionId, bridgeSessionId);
    assert.equal(binding.sdkSessionId, nextNativeSessionId);
    assert.equal(binding.backendSdkSessionIds?.codex, nextNativeSessionId);
    assert.equal(binding.backendSdkSessionIds?.claudecode, 'a50476c9-09a0-4299-a0f2-c082cc35c659');
    assert.equal(sessions.get(bridgeSessionId)?.sdkSessionId, nextNativeSessionId);
  });

  it('/tabs lists logical sessions instead of falling through to unknown command', async () => {
    const { store } = createCommandStore();
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent);
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-tabs',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/tabs',
      timestamp: Date.now(),
    });

    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0].text, /Unknown command/);
    assert.match(sent[0].text, /Tabs/);
  });

  it('/tabs sends a Feishu choice card when interactive cards are supported', async () => {
    const activeSessionId = '0372c636-4840-4160-bc52-0104d69e1378';
    const { store } = createCommandStore({
      codepilotSessionId: activeSessionId,
      backendSessionIds: { codex: activeSessionId },
      sessionTabs: [createSessionTab(activeSessionId, 'codex', '2026-06-01T00:00:00.000Z')],
      activeSessionTabId: activeSessionId,
    });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const cards: Array<{ cardJson: string; replyToMessageId?: string }> = [];
    const adapter = createCommandAdapter(sent, {
      sendInteractiveCard: async (_address, cardJson, replyToMessageId) => {
        cards.push({ cardJson, replyToMessageId });
        return { ok: true, messageId: 'card-1' };
      },
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-tabs-card',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/tabs',
      timestamp: Date.now(),
    });

    assert.equal(sent.length, 0);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].replyToMessageId, 'msg-tabs-card');
    const card = JSON.parse(cards[0].cardJson);
    assert.equal(card.schema, '2.0');
    assert.match(cards[0].cardJson, /tabs:switch:binding-1:/);
  });

  it('/search uses an ephemeral agent and returns a two-button Feishu result card', async () => {
    const now = Date.now();
    const targetTab = createSessionTab('billing-session', 'codex', new Date(now - 60_000).toISOString());
    const otherTab = createSessionTab('release-session', 'codex', new Date(now - 120_000).toISOString());
    const activeTab = createSessionTab('active-session', 'codex', new Date(now).toISOString());
    const { store, binding, sessions } = createCommandStore({
      codepilotSessionId: 'active-session',
      backendSessionIds: { codex: 'active-session' },
      sessionTabs: [activeTab, targetTab, otherTab],
      activeSessionTabId: 'active-session',
    });
    sessions.set('billing-session', { id: 'billing-session', working_directory: 'C:\\global', model: '' });
    sessions.set('release-session', { id: 'release-session', working_directory: 'C:\\global', model: '' });
    (store as BridgeStore).getMessages = (sessionId: string) => ({
      messages: sessionId === 'billing-session'
        ? [
            { role: 'user', content: 'Please fix the billing webhook regression.' },
            { role: 'assistant', content: 'Billing webhook fix is ready.' },
          ]
        : [{ role: 'user', content: 'Release checklist and notes.' }],
    });

    const calls: StreamChatParams[] = [];
    initBridgeContext({
      store,
      llm: createSearchLlm(calls, () => [
        { type: 'text', data: '{"index":1,"confidence":0.92,"reason":"billing webhook matches"}' },
      ]),
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const cards: Array<{ cardJson: string; replyToMessageId?: string }> = [];
    const adapter = createCommandAdapter(sent, {
      sendInteractiveCard: async (_address, cardJson, replyToMessageId) => {
        cards.push({ cardJson, replyToMessageId });
        return { ok: true, messageId: 'search-card-1' };
      },
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-search-card',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/search billing webhook regression',
      timestamp: Date.now(),
    });

    assert.equal(sent.length, 0);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].replyToMessageId, 'msg-search-card');
    assert.match(cards[0].cardJson, /billing-session/);
    assert.match(cards[0].cardJson, /Last user question: Please fix the billing webhook regression\./);
    assert.match(cards[0].cardJson, /Last agent output: Billing webhook fix is ready\./);
    assert.match(cards[0].cardJson, /tabs:search:confirm:/);
    assert.match(cards[0].cardJson, /tabs:search:again:/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ephemeral, true);
    assert.equal(calls[0].sdkSessionId, undefined);
    assert.equal(calls[0].backendSdkSessionId, undefined);
    assert.equal(calls[0].sandboxLevel, 'ro');
    assert.equal(calls[0].effort, 'medium');
    assert.match(calls[0].prompt, /keywordEvidence/);
    assert.match(calls[0].prompt, /similarityEvidence/);
    assert.equal(binding.codepilotSessionId, 'active-session');
  });

  it('/search HTML fallback omits last user question when the session has none', async () => {
    const now = Date.now();
    const targetTab = createSessionTab('cache-session', 'codex', new Date(now - 60_000).toISOString());
    const activeTab = createSessionTab('active-session', 'codex', new Date(now).toISOString());
    const { store, sessions } = createCommandStore({
      codepilotSessionId: 'active-session',
      backendSessionIds: { codex: 'active-session' },
      sessionTabs: [activeTab, targetTab],
      activeSessionTabId: 'active-session',
    });
    sessions.set('cache-session', { id: 'cache-session', working_directory: 'C:\\global', model: '' });
    (store as BridgeStore).getMessages = (sessionId: string) => ({
      messages: sessionId === 'cache-session'
        ? [{ role: 'assistant', content: 'Discussed cache cleanup details.' }]
        : [],
    });

    const calls: StreamChatParams[] = [];
    initBridgeContext({
      store,
      llm: createSearchLlm(calls, () => [
        { type: 'text', data: '{"index":1,"confidence":0.91,"reason":"cache cleanup matches"}' },
      ]),
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent);
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-search-html',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/search cache cleanup',
      timestamp: Date.now(),
    });

    assert.equal(calls.length, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Reason: 搜索代理匹配：cache cleanup matches/);
    assert.doesNotMatch(sent[0].text, /Last user question:/);
  });

  it('/search can return the current session and labels it as current', async () => {
    const activeTab = createSessionTab('active-session', 'codex', new Date('2026-06-02T00:00:00.000Z').toISOString());
    const { store, binding } = createCommandStore({
      codepilotSessionId: 'active-session',
      backendSessionIds: { codex: 'active-session' },
      sessionTabs: [activeTab],
      activeSessionTabId: 'active-session',
    });
    (store as BridgeStore).getMessages = (sessionId: string) => ({
      messages: sessionId === 'active-session'
        ? [
            { role: 'user', content: 'Investigate the current session search behavior.' },
            { role: 'assistant', content: 'Current session search behavior analysis.' },
          ]
        : [],
    });

    const calls: StreamChatParams[] = [];
    initBridgeContext({
      store,
      llm: createSearchLlm(calls, () => [
        { type: 'text', data: '{"index":1,"confidence":0.93,"reason":"current session matches"}' },
      ]),
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const cards: Array<{ cardJson: string; replyToMessageId?: string }> = [];
    const adapter = createCommandAdapter(sent, {
      sendInteractiveCard: async (_address, cardJson, replyToMessageId) => {
        cards.push({ cardJson, replyToMessageId });
        return { ok: true, messageId: 'search-current-card' };
      },
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-search-current',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/search current session search behavior',
      timestamp: Date.now(),
    });

    assert.equal(sent.length, 0);
    assert.equal(cards.length, 1);
    assert.match(cards[0].cardJson, /active-session/);
    assert.match(cards[0].cardJson, /current session/i);
    assert.equal(binding.codepilotSessionId, 'active-session');
  });

  it('/search accepts a recent-session limit as the final numeric argument', async () => {
    const now = Date.now();
    const tabs: BridgeSessionTab[] = [createSessionTab('active-session', 'codex', new Date(now).toISOString())];
    for (let index = 1; index <= 25; index += 1) {
      tabs.push(createSessionTab(`session-${String(index).padStart(2, '0')}`, 'codex', new Date(now - index * 1000).toISOString()));
    }
    const { store, sessions } = createCommandStore({
      codepilotSessionId: 'active-session',
      backendSessionIds: { codex: 'active-session' },
      sessionTabs: tabs,
      activeSessionTabId: 'active-session',
    });
    for (const tab of tabs) {
      sessions.set(tab.codepilotSessionId, { id: tab.codepilotSessionId, working_directory: 'C:\\global', model: '' });
    }

    const calls: StreamChatParams[] = [];
    initBridgeContext({
      store,
      llm: createSearchLlm(calls, () => [
        { type: 'text', data: '{"index":25,"confidence":0.9,"reason":"explicit limit reached"}' },
      ]),
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const cards: string[] = [];
    const adapter = createCommandAdapter(sent, {
      sendInteractiveCard: async (_address, cardJson) => {
        cards.push(cardJson);
        return { ok: true, messageId: 'search-card-limit' };
      },
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-search-limit',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/search explicit limit 25',
      timestamp: Date.now(),
    });

    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /Candidate 25/);
    assert.doesNotMatch(calls[0].prompt, /Query: explicit limit 25/);
    assert.match(calls[0].prompt, /Query: explicit limit/);
    assert.match(cards[0], /session-25/);
  });

  it('/search can find a native Codex session and materialize it on confirm', async () => {
    const nativeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-bridge-native-fixture-'));
    process.env.CTI_CLAUDE_PROJECTS_DIR = path.join(nativeRoot, 'claude-projects');
    process.env.CTI_CODEX_SESSIONS_DIR = path.join(nativeRoot, 'codex-sessions');
    writeJsonl(path.join(process.env.CTI_CODEX_SESSIONS_DIR, '2026', '06', 'rollout.jsonl'), [
      {
        timestamp: '2026-06-02T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-native-thread', cwd: 'C:\\native' },
      },
      {
        timestamp: '2026-06-02T00:01:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Investigate native search regression' }] },
      },
      {
        timestamp: '2026-06-02T00:02:00.000Z',
        type: 'response_item',
        payload: { type: 'agent_message', role: 'assistant', content: [{ type: 'output_text', text: 'Native search regression summary' }] },
      },
    ]);

    const { store, binding, sessions } = createCommandStore({
      codepilotSessionId: 'active-session',
      backendSessionIds: { codex: 'active-session' },
      sessionTabs: [createSessionTab('active-session', 'codex', new Date('2026-06-03T00:00:00.000Z').toISOString())],
      activeSessionTabId: 'active-session',
    });
    const calls: StreamChatParams[] = [];
    initBridgeContext({
      store,
      llm: createSearchLlm(calls, () => [
        { type: 'text', data: '{"index":1,"confidence":0.9,"reason":"native regression match"}' },
      ]),
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const cards: string[] = [];
    const adapter = createCommandAdapter(sent, {
      sendInteractiveCard: async (_address, cardJson) => {
        cards.push(cardJson);
        return { ok: true, messageId: 'search-card-native' };
      },
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-search-native',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/search native regression',
      timestamp: Date.now(),
    });
    assert.match(cards[0], /codex-native-thread/);
    assert.match(cards[0], /Last user question: Investigate native search regression/);
    assert.match(cards[0], /Last agent output: Native search regression summary/);

    const token = extractSearchToken(cards[0], 'confirm');
    await _testOnly.handleMessage(adapter, {
      messageId: 'search-card-native',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '',
      timestamp: Date.now(),
      callbackData: `tabs:search:confirm:${token}`,
      callbackMessageId: 'search-card-native',
    });

    assert.notEqual(binding.codepilotSessionId, 'codex-native-thread');
    assert.equal(binding.sdkSessionId, 'codex-native-thread');
    assert.equal(binding.workingDirectory, 'C:\\native');
    assert.equal(sessions.get(binding.codepilotSessionId)?.sdkSessionId, 'codex-native-thread');
  });

  it('confirms a /search result callback by switching to that session tab', async () => {
    const now = Date.now();
    const activeTab = createSessionTab('active-session', 'codex', new Date(now).toISOString());
    const targetTab = createSessionTab('billing-session', 'codex', new Date(now - 60_000).toISOString());
    const { store, binding, sessions } = createCommandStore({
      codepilotSessionId: 'active-session',
      backendSessionIds: { codex: 'active-session' },
      sessionTabs: [activeTab, targetTab],
      activeSessionTabId: 'active-session',
    });
    sessions.set('billing-session', { id: 'billing-session', working_directory: 'C:\\global', model: '' });

    const calls: StreamChatParams[] = [];
    initBridgeContext({
      store,
      llm: createSearchLlm(calls, () => [
        { type: 'text', data: '{"index":1,"confidence":0.9,"reason":"billing match"}' },
      ]),
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const cards: string[] = [];
    const adapter = createCommandAdapter(sent, {
      sendInteractiveCard: async (_address, cardJson) => {
        cards.push(cardJson);
        return { ok: true, messageId: 'search-card-1' };
      },
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-search-confirm',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/search billing',
      timestamp: Date.now(),
    });
    const token = extractSearchToken(cards[0], 'confirm');

    await _testOnly.handleMessage(adapter, {
      messageId: 'search-card-1',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '',
      timestamp: Date.now(),
      callbackData: `tabs:search:confirm:${token}`,
      callbackMessageId: 'search-card-1',
    });

    assert.equal(binding.codepilotSessionId, 'billing-session');
    assert.equal((binding as any).activeSessionTabId, 'billing-session');
    assert.ok(sent.some((msg) => msg.text.includes('Switched to tab')));
  });

  it('re-runs /search while excluding the previous result', async () => {
    const now = Date.now();
    const activeTab = createSessionTab('active-session', 'codex', new Date(now).toISOString());
    const firstTab = createSessionTab('billing-session', 'codex', new Date(now - 60_000).toISOString());
    const secondTab = createSessionTab('refund-session', 'codex', new Date(now - 120_000).toISOString());
    const { store, sessions } = createCommandStore({
      codepilotSessionId: 'active-session',
      backendSessionIds: { codex: 'active-session' },
      sessionTabs: [activeTab, firstTab, secondTab],
      activeSessionTabId: 'active-session',
    });
    sessions.set('billing-session', { id: 'billing-session', working_directory: 'C:\\global', model: '' });
    sessions.set('refund-session', { id: 'refund-session', working_directory: 'C:\\global', model: '' });

    const calls: StreamChatParams[] = [];
    initBridgeContext({
      store,
      llm: createSearchLlm(calls, () => [
        { type: 'text', data: '{"index":1,"confidence":0.8,"reason":"best remaining"}' },
      ]),
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const cards: string[] = [];
    const adapter = createCommandAdapter(sent, {
      sendInteractiveCard: async (_address, cardJson) => {
        cards.push(cardJson);
        return { ok: true, messageId: `search-card-${cards.length}` };
      },
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-search-again',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/search billing',
      timestamp: Date.now(),
    });
    assert.match(cards[0], /billing-session/);
    const token = extractSearchToken(cards[0], 'again');

    await _testOnly.handleMessage(adapter, {
      messageId: 'search-card-1',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '',
      timestamp: Date.now(),
      callbackData: `tabs:search:again:${token}`,
      callbackMessageId: 'search-card-1',
    });

    assert.equal(calls.length, 2);
    assert.match(cards[1], /refund-session/);
    assert.doesNotMatch(cards[1], /billing-session/);

    await _testOnly.handleMessage(adapter, {
      messageId: 'search-card-1-old-confirm',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '',
      timestamp: Date.now(),
      callbackData: `tabs:search:confirm:${token}`,
      callbackMessageId: 'search-card-1',
    });

    const binding = store.getChannelBinding('feishu', 'chat-1');
    assert.equal(binding?.codepilotSessionId, 'active-session');
    assert.ok(sent.some((msg) => msg.text.includes('This search result expired')));
  });

  it('/search falls back to local message scoring when the agent fails', async () => {
    const now = Date.now();
    const activeTab = createSessionTab('active-session', 'codex', new Date(now).toISOString());
    const targetTab = createSessionTab('offline-match-session', 'codex', new Date(now - 60_000).toISOString());
    const { store, sessions } = createCommandStore({
      codepilotSessionId: 'active-session',
      backendSessionIds: { codex: 'active-session' },
      sessionTabs: [activeTab, targetTab],
      activeSessionTabId: 'active-session',
    });
    sessions.set('offline-match-session', { id: 'offline-match-session', working_directory: 'C:\\global', model: '' });
    (store as BridgeStore).getMessages = (sessionId: string) => ({
      messages: sessionId === 'offline-match-session'
        ? [
            { role: 'user', content: 'Can you investigate the invoice export timeout?' },
            { role: 'assistant', content: 'Investigated the invoice export timeout.' },
          ]
        : [],
    });

    const calls: StreamChatParams[] = [];
    initBridgeContext({
      store,
      llm: createSearchLlm(calls, () => [{ type: 'error', data: 'agent unavailable' }]),
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const cards: string[] = [];
    const adapter = createCommandAdapter(sent, {
      sendInteractiveCard: async (_address, cardJson) => {
        cards.push(cardJson);
        return { ok: true, messageId: 'search-card-1' };
      },
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-search-fallback',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/search invoice timeout',
      timestamp: Date.now(),
    });

    assert.equal(calls.length, 1);
    assert.equal(cards.length, 1);
    assert.match(cards[0], /offline-match-session/);
    assert.match(cards[0], /本地关键词匹配/);
    assert.match(cards[0], /Last user question: Can you investigate the invoice export timeout\?/);
  });

  it('/search matches older native transcript text beyond latest snippets', async () => {
    const nativeSessionId = '0beb3f1b-8757-4286-b3a4-4734694aa42b';
    writeJsonl(path.join(process.env.CTI_CLAUDE_PROJECTS_DIR!, 'C--Users-hanbangliang', `${nativeSessionId}.jsonl`), [
      {
        timestamp: '2026-06-19T08:16:14.280Z',
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '查找一个 mixgrpo 调研的 Claude session' }] },
        cwd: 'C:\\native',
        sessionId: nativeSessionId,
      },
      {
        timestamp: '2026-06-19T08:22:59.073Z',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'MixGRPO 调研报告已经整理完成。' }] },
        cwd: 'C:\\native',
        sessionId: nativeSessionId,
      },
      {
        timestamp: '2026-06-19T09:54:52.916Z',
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '后续只检查 backend cwd 状态' }] },
        cwd: 'C:\\native',
        sessionId: nativeSessionId,
      },
      {
        timestamp: '2026-06-19T09:55:52.916Z',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '最近输出没有目标关键词。' }] },
        cwd: 'C:\\native',
        sessionId: nativeSessionId,
      },
    ]);

    const activeTab = createSessionTab('active-claude-session', 'claudecode', '2026-06-19T10:00:00.000Z');
    const { store } = createCommandStore({
      codepilotSessionId: 'active-claude-session',
      backend: 'claudecode',
      backendSessionIds: { claudecode: 'active-claude-session' },
      sessionTabs: [activeTab],
      activeSessionTabId: 'active-claude-session',
    });

    const calls: StreamChatParams[] = [];
    initBridgeContext({
      store,
      llm: createSearchLlm(calls, () => [{ type: 'error', data: 'agent unavailable' }]),
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const cards: string[] = [];
    const adapter = createCommandAdapter(sent, {
      sendInteractiveCard: async (_address, cardJson) => {
        cards.push(cardJson);
        return { ok: true, messageId: 'search-card-1' };
      },
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-search-native-transcript',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/search mixgrpo 调研',
      timestamp: Date.now(),
    });

    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /native transcript keyword matches/);
    assert.equal(cards.length, 1);
    assert.match(cards[0], new RegExp(nativeSessionId));
    assert.match(cards[0], /本地关键词匹配/);
    assert.match(cards[0], /mixgrpo/);
  });

  it('invalidates the old /search result when retry finds no replacement', async () => {
    const now = Date.now();
    const activeTab = createSessionTab('active-session', 'codex', new Date(now).toISOString());
    const onlyMatch = createSessionTab('billing-session', 'codex', new Date(now - 60_000).toISOString());
    const { store, binding, sessions } = createCommandStore({
      codepilotSessionId: 'active-session',
      backendSessionIds: { codex: 'active-session' },
      sessionTabs: [activeTab, onlyMatch],
      activeSessionTabId: 'active-session',
    });
    sessions.set('billing-session', { id: 'billing-session', working_directory: 'C:\\global', model: '' });

    const calls: StreamChatParams[] = [];
    initBridgeContext({
      store,
      llm: createSearchLlm(calls, () => [
        { type: 'text', data: '{"index":1,"confidence":0.9,"reason":"only match"}' },
      ]),
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const cards: string[] = [];
    const adapter = createCommandAdapter(sent, {
      sendInteractiveCard: async (_address, cardJson) => {
        cards.push(cardJson);
        return { ok: true, messageId: 'search-card-1' };
      },
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-search-no-retry-result',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/search billing',
      timestamp: Date.now(),
    });
    const token = extractSearchToken(cards[0], 'again');

    await _testOnly.handleMessage(adapter, {
      messageId: 'search-card-1-retry',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '',
      timestamp: Date.now(),
      callbackData: `tabs:search:again:${token}`,
      callbackMessageId: 'search-card-1',
    });
    assert.ok(sent.some((msg) => msg.text.includes('No other matching session found')));

    await _testOnly.handleMessage(adapter, {
      messageId: 'search-card-1-old-confirm-after-empty-retry',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '',
      timestamp: Date.now(),
      callbackData: `tabs:search:confirm:${token}`,
      callbackMessageId: 'search-card-1',
    });

    assert.equal(binding.codepilotSessionId, 'active-session');
    assert.ok(sent.some((msg) => msg.text.includes('This search result expired')));
  });

  it('/tabs filters choices to the current backend before limiting', async () => {
    const now = Date.now();
    const tab = (id: string, backend: 'codex' | 'claudecode', minutesAgo: number) => ({
      id,
      codepilotSessionId: id,
      sdkSessionId: '',
      workingDirectory: 'C:\\work',
      model: '',
      mode: 'code' as const,
      backend,
      backendGeneration: 0,
      backendSessionIds: { [backend]: id },
      backendSdkSessionIds: {},
      status: 'completed' as const,
      bufferedResponseText: '',
      bufferedErrorMessage: '',
      unread: false,
      activityAt: new Date(now - minutesAgo * 60_000).toISOString(),
      createdAt: new Date(now - minutesAgo * 60_000).toISOString(),
      updatedAt: new Date(now - minutesAgo * 60_000).toISOString(),
    });
    const { store, binding, sessions } = createCommandStore({
      codepilotSessionId: 'codex-active-session',
      backend: 'codex',
      backendSessionIds: { codex: 'codex-active-session' },
      sessionTabs: [
        tab('claude-newer-session', 'claudecode', 1),
        tab('codex-active-session', 'codex', 1.5),
        tab('codex-newer-session', 'codex', 2),
        tab('codex-older-session', 'codex', 3),
        tab('claude-older-session', 'claudecode', 4),
      ],
      activeSessionTabId: 'codex-active-session',
    });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const cards: Array<{ cardJson: string }> = [];
    const adapter = createCommandAdapter(sent, {
      sendInteractiveCard: async (_address, cardJson) => {
        cards.push({ cardJson });
        return { ok: true, messageId: 'card-1' };
      },
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-tabs-filtered',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/tabs 2',
      timestamp: Date.now(),
    });

    assert.equal(sent.length, 0);
    assert.equal(cards.length, 1);
    assert.match(cards[0].cardJson, /codex-newer-session/);
    assert.match(cards[0].cardJson, /codex-active-session/);
    assert.doesNotMatch(cards[0].cardJson, /claude-newer-session/);
    assert.doesNotMatch(cards[0].cardJson, /codex-older-session/);
    assert.equal((binding as any).backend, 'codex');
  });

  it('/tabs lists global current-backend sessions before limiting', async () => {
    const now = Date.now();
    const updatedAt = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
    const { store, binding, sessions } = createCommandStore({
      codepilotSessionId: 'codex-current-session',
      backend: 'codex',
      backendSessionIds: { codex: 'codex-current-session' },
      sessionTabs: [createSessionTab('codex-current-session', 'codex', updatedAt(10))],
      activeSessionTabId: 'codex-current-session',
    });
    const otherBinding: ChannelBinding = {
      ...binding,
      id: 'binding-2',
      chatId: 'chat-2',
      codepilotSessionId: 'claude-global-newer-session',
      backend: 'claudecode',
      backendSessionIds: { claudecode: 'claude-global-newer-session' },
      sessionTabs: [
        createSessionTab('claude-global-newer-session', 'claudecode', updatedAt(1)),
        createSessionTab('codex-global-newest-session', 'codex', updatedAt(2)),
        createSessionTab('codex-global-second-session', 'codex', updatedAt(3)),
        createSessionTab('codex-global-third-session', 'codex', updatedAt(4)),
      ],
      activeSessionTabId: 'claude-global-newer-session',
    };
    sessions.set('codex-global-newest-session', { id: 'codex-global-newest-session', working_directory: 'C:\\global', model: '' });
    sessions.set('codex-global-second-session', { id: 'codex-global-second-session', working_directory: 'C:\\global', model: '' });
    sessions.set('codex-global-third-session', { id: 'codex-global-third-session', working_directory: 'C:\\global', model: '' });
    (store as any).listChannelBindings = () => [binding, otherBinding];
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const cards: Array<{ cardJson: string }> = [];
    const adapter = createCommandAdapter(sent, {
      sendInteractiveCard: async (_address, cardJson) => {
        cards.push({ cardJson });
        return { ok: true, messageId: 'card-1' };
      },
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-tabs-global',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/tabs 2',
      timestamp: Date.now(),
    });

    assert.equal(sent.length, 0);
    assert.equal(cards.length, 1);
    assert.match(cards[0].cardJson, /codex-global-newest-session/);
    assert.match(cards[0].cardJson, /codex-global-second-session/);
    assert.doesNotMatch(cards[0].cardJson, /claude-global-newer-session/);
    assert.doesNotMatch(cards[0].cardJson, /codex-global-third-session/);
  });

  it('/tabs lists the 10 most recent chat-active native sessions with full native ids', async () => {
    const nativeIds = Array.from({ length: 12 }, (_, index) =>
      `019edeab-882e-7000-8000-${String(index + 1).padStart(12, '0')}`);
    for (const [index, nativeId] of nativeIds.entries()) {
      writeJsonl(path.join(process.env.CTI_CODEX_SESSIONS_DIR!, '2026', '06', `${nativeId}.jsonl`), [
        {
          timestamp: '2026-06-02T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: nativeId, cwd: `C:\\native\\${index + 1}` },
        },
        {
          timestamp: new Date(Date.UTC(2026, 5, 2, 0, 30 - index, 0)).toISOString(),
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `native chat ${index + 1}` }] },
        },
      ]);
    }
    writeJsonl(path.join(process.env.CTI_CODEX_SESSIONS_DIR!, '2026', '06', 'metadata-only.jsonl'), [
      {
        timestamp: '2026-06-03T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: '019edeab-882e-7000-8000-metadataonly', cwd: 'C:\\native\\metadata' },
      },
    ]);

    const { store } = createCommandStore({
      codepilotSessionId: 'bridge-active-no-chat',
      backend: 'codex',
      backendSessionIds: { codex: 'bridge-active-no-chat' },
      sessionTabs: [],
      activeSessionTabId: 'bridge-active-no-chat',
    });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const cards: Array<{ cardJson: string }> = [];
    const adapter = createCommandAdapter(sent, {
      sendInteractiveCard: async (_address, cardJson) => {
        cards.push({ cardJson });
        return { ok: true, messageId: 'card-1' };
      },
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-tabs-native-recent',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/tabs',
      timestamp: Date.now(),
    });

    assert.equal(sent.length, 0);
    assert.equal(cards.length, 1);
    const card = JSON.parse(cards[0].cardJson);
    const content = card.body.elements[0].content as string;
    assert.equal((content.match(/^\*\*\d+\./gm) ?? []).length, 10);
    for (const nativeId of nativeIds.slice(0, 10)) {
      assert.match(content, new RegExp(nativeId));
    }
    assert.doesNotMatch(content, new RegExp(nativeIds[10]));
    assert.doesNotMatch(content, /metadataonly/);
    assert.doesNotMatch(content, /native:/);
    assert.doesNotMatch(content, /\.\.\./);
    assert.match(content, /codex/);
    assert.match(content, /C:\\native\\1/);
    assert.match(content, /completed/);
  });

  it('/tabs Feishu card shows latest native user and agent snippets truncated to 20 chars', async () => {
    writeJsonl(path.join(process.env.CTI_CODEX_SESSIONS_DIR!, '2026', '06', 'snippets.jsonl'), [
      {
        timestamp: '2026-06-02T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-native-snippet-session', cwd: 'C:\\native\\snippets' },
      },
      {
        timestamp: '2026-06-02T00:01:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '1234567890123456789012345' }] },
      },
      {
        timestamp: '2026-06-02T00:02:00.000Z',
        type: 'response_item',
        payload: { type: 'agent_message', role: 'assistant', content: [{ type: 'output_text', text: 'abcdefghijklmnopqrstuvwxyz' }] },
      },
    ]);

    const { store } = createCommandStore({
      codepilotSessionId: 'bridge-active-no-chat',
      backend: 'codex',
      backendSessionIds: { codex: 'bridge-active-no-chat' },
      sessionTabs: [],
      activeSessionTabId: 'bridge-active-no-chat',
    });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const cards: Array<{ cardJson: string }> = [];
    const adapter = createCommandAdapter(sent, {
      sendInteractiveCard: async (_address, cardJson) => {
        cards.push({ cardJson });
        return { ok: true, messageId: 'card-1' };
      },
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-tabs-snippets-card',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/tabs',
      timestamp: Date.now(),
    });

    assert.equal(sent.length, 0);
    assert.equal(cards.length, 1);
    const card = JSON.parse(cards[0].cardJson);
    const content = card.body.elements[0].content as string;
    assert.match(content, /user: 1234567890123456789…/);
    assert.match(content, /agent: abcdefghijklmnopqrs…/);
    assert.doesNotMatch(content, /12345678901234567890/);
    assert.doesNotMatch(content, /abcdefghijklmnopqrst/);
  });

  it('/tabs text fallback shows latest stored user and agent snippets truncated to 20 chars', async () => {
    const tab = createSessionTab('codex-chat-session', 'codex', '2026-06-02T00:00:00.000Z');
    const { store } = createCommandStore({
      codepilotSessionId: 'codex-chat-session',
      backend: 'codex',
      backendSessionIds: { codex: 'codex-chat-session' },
      sessionTabs: [tab],
      activeSessionTabId: 'codex-chat-session',
    });
    (store as BridgeStore).getMessages = (sessionId: string) => ({
      messages: sessionId === 'codex-chat-session'
        ? [
            { role: 'user', content: 'old user message' },
            { role: 'assistant', content: 'old agent message' },
            { role: 'user', content: '1234567890123456789012345' },
            { role: 'assistant', content: 'abcdefghijklmnopqrstuvwxyz' },
          ]
        : [],
    });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent, { channelType: 'telegram' });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-tabs-snippets-text',
      address: { channelType: 'telegram', chatId: 'chat-1' },
      text: '/tabs',
      timestamp: Date.now(),
    });

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /user=<code>1234567890123456789…<\/code>/);
    assert.match(sent[0].text, /agent=<code>abcdefghijklmnopqrs…<\/code>/);
    assert.doesNotMatch(sent[0].text, /old user message/);
    assert.doesNotMatch(sent[0].text, /old agent message/);
    assert.doesNotMatch(sent[0].text, /12345678901234567890/);
    assert.doesNotMatch(sent[0].text, /abcdefghijklmnopqrst/);
  });

  it('/tabs overlays bridge state onto the matching backend session identity', async () => {
    writeJsonl(path.join(process.env.CTI_CODEX_SESSIONS_DIR!, '2026', '06', 'shared.jsonl'), [
      {
        timestamp: '2026-06-02T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-shared-thread', cwd: 'C:\\native' },
      },
      {
        timestamp: '2026-06-02T00:01:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'shared backend session question' }] },
      },
      {
        timestamp: '2026-06-02T00:02:00.000Z',
        type: 'response_item',
        payload: { type: 'agent_message', role: 'assistant', content: [{ type: 'output_text', text: 'shared backend session answer' }] },
      },
    ]);

    const bridgeTab = createSessionTab('bridge-session', 'codex', '2026-01-01T00:00:00.000Z');
    bridgeTab.sdkSessionId = 'codex-shared-thread';
    bridgeTab.backendSdkSessionIds = { codex: 'codex-shared-thread' };
    const { store, binding, sessions } = createCommandStore({
      codepilotSessionId: 'bridge-session',
      sdkSessionId: 'codex-shared-thread',
      backend: 'codex',
      backendSessionIds: { codex: 'bridge-session' },
      backendSdkSessionIds: { codex: 'codex-shared-thread' },
      sessionTabs: [bridgeTab],
      activeSessionTabId: 'bridge-session',
    });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent);
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-tabs-overlay',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/tabs 10',
      timestamp: Date.now(),
    });

    assert.equal((sent[0].text.match(/^\d+\./gm) ?? []).length, 1);
    assert.match(sent[0].text, /codex-shared-thread/);
    assert.doesNotMatch(sent[0].text, /native:c/);
    assert.equal(binding.codepilotSessionId, 'bridge-session');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-tab-overlay',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/tab 1',
      timestamp: Date.now(),
    });

    assert.equal(binding.codepilotSessionId, 'bridge-session');
    assert.equal(sessions.size, 1);
  });

  it('/tabs does not refresh tab activity timestamps while listing', async () => {
    const originalUpdatedAt = '2026-01-01T00:00:00.000Z';
    const { store, binding } = createCommandStore({
      codepilotSessionId: 'codex-current-session',
      backend: 'codex',
      backendSessionIds: { codex: 'codex-current-session' },
      sessionTabs: [createSessionTab('codex-current-session', 'codex', originalUpdatedAt)],
      activeSessionTabId: 'codex-current-session',
    });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent);
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-tabs-no-touch',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/tabs',
      timestamp: Date.now(),
    });

    assert.equal(binding.sessionTabs?.[0]?.updatedAt, originalUpdatedAt);
  });

  it('/tabs ignores non-chat metadata updates when ordering recent sessions', async () => {
    const activeTab = createSessionTab('codex-active-session', 'codex', '2026-01-01T00:00:00.000Z');
    const recentChatTab = createSessionTab('codex-recent-chat-session', 'codex', '2026-06-01T00:00:00.000Z');
    const { store, binding, sessions } = createCommandStore({
      codepilotSessionId: 'codex-active-session',
      backend: 'codex',
      backendSessionIds: { codex: 'codex-active-session' },
      sessionTabs: [activeTab, recentChatTab],
      activeSessionTabId: 'codex-active-session',
    });
    sessions.set('codex-recent-chat-session', { id: 'codex-recent-chat-session', working_directory: 'C:\\global', model: '' });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent);
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-cwd',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/cwd C:\\changed',
      timestamp: Date.now(),
    });
    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-tabs-after-cwd',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/tabs 2',
      timestamp: Date.now(),
    });

    assert.equal(binding.sessionTabs?.find((tab) => tab.id === 'codex-active-session')?.activityAt, '2026-01-01T00:00:00.000Z');
    assert.match(sent[1].text, /1\. <code>codex-recent-chat-session<\/code> backend=<b>codex<\/b> cwd=<code>C:\\global<\/code> status=<b>completed<\/b>/);
    assert.match(sent[1].text, /2\. <code>codex-active-session<\/code> backend=<b>codex<\/b> cwd=<code>C:\\changed<\/code> status=<b>completed<\/b>/);
  });

  it('/tab switches using the same current-backend recent ordering as /tabs', async () => {
    const now = Date.now();
    const updatedAt = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
    const { store, binding, sessions } = createCommandStore({
      codepilotSessionId: 'codex-current-session',
      backend: 'codex',
      backendSessionIds: { codex: 'codex-current-session' },
      sessionTabs: [
        createSessionTab('claude-current-binding-session', 'claudecode', updatedAt(1)),
        createSessionTab('codex-current-session', 'codex', updatedAt(10)),
      ],
      activeSessionTabId: 'codex-current-session',
    });
    const otherBinding: ChannelBinding = {
      ...binding,
      id: 'binding-2',
      chatId: 'chat-2',
      codepilotSessionId: 'codex-global-newest-session',
      backend: 'codex',
      backendSessionIds: { codex: 'codex-global-newest-session' },
      sessionTabs: [createSessionTab('codex-global-newest-session', 'codex', updatedAt(2))],
      activeSessionTabId: 'codex-global-newest-session',
    };
    sessions.set('codex-global-newest-session', { id: 'codex-global-newest-session', working_directory: 'C:\\global', model: '' });
    (store as any).listChannelBindings = () => [binding, otherBinding];
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent);
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-tab-global',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/tab 1',
      timestamp: Date.now(),
    });

    assert.equal(binding.codepilotSessionId, 'codex-global-newest-session');
    assert.equal(binding.backend, 'codex');
    assert.equal(binding.activeSessionTabId, 'codex-global-newest-session');
    assert.equal(binding.sessionTabs?.some((tab) => tab.id === 'codex-global-newest-session'), true);
    assert.match(sent[0].text, /codex-global-newest-session/);
    assert.doesNotMatch(sent[0].text, /claude-current-binding-session/);
  });

  it('/backend activates the most recent global target-backend chat session', async () => {
    const { store, binding, sessions } = createCommandStore({
      codepilotSessionId: 'claude-active-session',
      backend: 'claudecode',
      backendSessionIds: {
        claudecode: 'claude-active-session',
        codex: 'codex-old-lane-session',
      },
      sessionTabs: [
        createSessionTab('claude-active-session', 'claudecode', '2026-06-01T00:00:00.000Z'),
        createSessionTab('codex-old-lane-session', 'codex', '2026-01-01T00:00:00.000Z'),
      ],
      activeSessionTabId: 'claude-active-session',
    });
    const otherBinding: ChannelBinding = {
      ...binding,
      id: 'binding-2',
      chatId: 'chat-2',
      codepilotSessionId: 'codex-global-recent-session',
      backend: 'codex',
      backendSessionIds: { codex: 'codex-global-recent-session' },
      sessionTabs: [createSessionTab('codex-global-recent-session', 'codex', '2026-06-02T00:00:00.000Z')],
      activeSessionTabId: 'codex-global-recent-session',
    };
    sessions.set('codex-old-lane-session', { id: 'codex-old-lane-session', working_directory: 'C:\\old', model: '' });
    sessions.set('codex-global-recent-session', { id: 'codex-global-recent-session', working_directory: 'C:\\global', model: '' });
    (store as any).listChannelBindings = () => [binding, otherBinding];
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent);
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-backend-codex-global',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/backend codex',
      timestamp: Date.now(),
    });

    assert.equal(binding.backend, 'codex');
    assert.equal(binding.codepilotSessionId, 'codex-global-recent-session');
    assert.equal(binding.activeSessionTabId, 'codex-global-recent-session');
    assert.equal(binding.backendSessionIds?.codex, 'codex-global-recent-session');
    assert.equal(binding.sessionTabs?.some((tab) => tab.id === 'codex-global-recent-session'), true);
    assert.equal(sessions.size, 3);
  });

  it('/backend orders candidates by activityAt instead of non-chat updatedAt', async () => {
    const activeCodexTab = createSessionTab('codex-active-session', 'codex', '2026-01-01T00:00:00.000Z');
    activeCodexTab.updatedAt = '2026-06-03T00:00:00.000Z';
    const recentChatTab = createSessionTab('codex-recent-chat-session', 'codex', '2026-06-01T00:00:00.000Z');
    const { store, binding, sessions } = createCommandStore({
      codepilotSessionId: 'claude-active-session',
      backend: 'claudecode',
      backendSessionIds: {
        claudecode: 'claude-active-session',
        codex: 'codex-active-session',
      },
      sessionTabs: [
        createSessionTab('claude-active-session', 'claudecode', '2026-06-02T00:00:00.000Z'),
        activeCodexTab,
        recentChatTab,
      ],
      activeSessionTabId: 'claude-active-session',
    });
    sessions.set('codex-active-session', { id: 'codex-active-session', working_directory: 'C:\\active', model: '' });
    sessions.set('codex-recent-chat-session', { id: 'codex-recent-chat-session', working_directory: 'C:\\recent', model: '' });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent);
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-backend-codex-activity',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/backend codex',
      timestamp: Date.now(),
    });

    assert.equal(binding.backend, 'codex');
    assert.equal(binding.codepilotSessionId, 'codex-recent-chat-session');
    assert.equal(binding.activeSessionTabId, 'codex-recent-chat-session');
    assert.equal(binding.backendSessionIds?.codex, 'codex-recent-chat-session');
    assert.equal(binding.sessionTabs?.find((tab) => tab.id === 'codex-active-session')?.activityAt, '2026-01-01T00:00:00.000Z');
  });

  it('/backend ignores a newer empty target-backend lane when a chat candidate exists', async () => {
    const emptyCodexLane = createSessionTab('codex-empty-lane', 'codex', '2026-06-05T00:00:00.000Z');
    delete emptyCodexLane.activityAt;
    const chatCodexTab = createSessionTab('codex-chat-session', 'codex', '2026-06-01T00:00:00.000Z');
    const { store, binding, sessions } = createCommandStore({
      codepilotSessionId: 'claude-active-session',
      backend: 'claudecode',
      backendSessionIds: {
        claudecode: 'claude-active-session',
        codex: 'codex-empty-lane',
      },
      sessionTabs: [
        createSessionTab('claude-active-session', 'claudecode', '2026-06-02T00:00:00.000Z'),
        emptyCodexLane,
        chatCodexTab,
      ],
      activeSessionTabId: 'claude-active-session',
    });
    sessions.set('codex-empty-lane', { id: 'codex-empty-lane', working_directory: 'C:\\empty', model: '' });
    sessions.set('codex-chat-session', { id: 'codex-chat-session', working_directory: 'C:\\chat', model: '' });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent);
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-backend-codex-empty-lane',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/backend codex',
      timestamp: Date.now(),
    });

    assert.equal(binding.backend, 'codex');
    assert.equal(binding.codepilotSessionId, 'codex-chat-session');
    assert.equal(binding.activeSessionTabId, 'codex-chat-session');
    assert.equal(binding.backendSessionIds?.codex, 'codex-chat-session');
    assert.equal(binding.sessionTabs?.find((tab) => tab.id === 'codex-empty-lane')?.activityAt, undefined);
  });

  it('/backend materializes and activates the most recent native target-backend session', async () => {
    writeJsonl(path.join(process.env.CTI_CODEX_SESSIONS_DIR!, '2026', '06', 'native-backend.jsonl'), [
      {
        timestamp: '2026-06-04T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-native-backend-thread', cwd: 'C:\\native-backend' },
      },
      {
        timestamp: '2026-06-04T00:01:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'native backend switch question' }] },
      },
    ]);
    const { store, binding, sessions } = createCommandStore({
      codepilotSessionId: 'claude-active-session',
      backend: 'claudecode',
      backendSessionIds: { claudecode: 'claude-active-session' },
      sessionTabs: [createSessionTab('claude-active-session', 'claudecode', '2026-06-01T00:00:00.000Z')],
      activeSessionTabId: 'claude-active-session',
    });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent);
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-backend-codex-native',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/backend codex',
      timestamp: Date.now(),
    });

    assert.equal(binding.backend, 'codex');
    assert.notEqual(binding.codepilotSessionId, 'codex-native-backend-thread');
    assert.equal(binding.sdkSessionId, 'codex-native-backend-thread');
    assert.equal(binding.backendSdkSessionIds?.codex, 'codex-native-backend-thread');
    assert.equal(binding.backendSessionIds?.codex, binding.codepilotSessionId);
    assert.equal(sessions.get(binding.codepilotSessionId)?.sdkSessionId, 'codex-native-backend-thread');
    assert.equal(binding.workingDirectory, 'C:\\native-backend');
  });

  it('/backend creates a new target-backend lane when there are no candidates', async () => {
    const { store, binding, sessions } = createCommandStore({
      codepilotSessionId: 'claude-active-session',
      backend: 'claudecode',
      backendSessionIds: { claudecode: 'claude-active-session' },
      sessionTabs: [createSessionTab('claude-active-session', 'claudecode', '2026-06-01T00:00:00.000Z')],
      activeSessionTabId: 'claude-active-session',
    });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent);
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-backend-codex-new-lane',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/backend codex',
      timestamp: Date.now(),
    });

    assert.equal(binding.backend, 'codex');
    assert.match(binding.codepilotSessionId, /^created-session-/);
    assert.equal(binding.backendSessionIds?.codex, binding.codepilotSessionId);
    assert.equal(binding.backendSdkSessionIds?.codex, undefined);
    assert.equal(sessions.size, 2);
  });

  it('/tab only accepts indexes from the last /tabs listing', async () => {
    const now = Date.now();
    const updatedAt = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
    const { store, binding } = createCommandStore({
      codepilotSessionId: 'codex-current-session',
      backend: 'codex',
      backendSessionIds: { codex: 'codex-current-session' },
      sessionTabs: [
        createSessionTab('codex-current-session', 'codex', updatedAt(4)),
        createSessionTab('codex-second-session', 'codex', updatedAt(2)),
        createSessionTab('codex-third-session', 'codex', updatedAt(3)),
      ],
      activeSessionTabId: 'codex-current-session',
    });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent);
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-tabs-two',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/tabs 2',
      timestamp: Date.now(),
    });
    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-tab-three',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/tab 3',
      timestamp: Date.now(),
    });

    assert.equal(binding.codepilotSessionId, 'codex-current-session');
    assert.match(sent.at(-1)?.text ?? '', /Usage: \/tab &lt;1-2&gt;/);
  });

  it('/new starts a fresh tab without aborting the active background task', async () => {
    const { store, binding } = createCommandStore();
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const oldTask = new AbortController();
    (globalThis as any).__bridge_manager__ = {
      adapters: new Map(),
      adapterMeta: new Map(),
      running: false,
      startedAt: null,
      loopAborts: new Map(),
      activeTasks: new Map([[`${binding.id}:codex`, oldTask]]),
      sessionLocks: new Map(),
      autoStartChecked: false,
    };

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent);
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-new',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/new C:\\work\\next',
      timestamp: Date.now(),
    });

    assert.equal(oldTask.signal.aborted, false);
    assert.match(sent[0].text, /New session created/);
    assert.notEqual(binding.codepilotSessionId, '0372c636-4840-4160-bc52-0104d69e1378');
    assert.equal((binding as any).sessionTabs.length, 2);
  });

  it('/tab switches to a completed background tab and flushes its buffered output', async () => {
    const { store, binding, sessions } = createCommandStore({
      codepilotSessionId: 'new-session',
      backendSessionIds: { codex: 'new-session' },
    });
    const oldTab = {
      id: 'old-session',
      codepilotSessionId: 'old-session',
      sdkSessionId: '',
      workingDirectory: 'C:\\work',
      model: '',
      mode: 'code',
      backend: 'codex',
      backendGeneration: 0,
      backendSessionIds: { codex: 'old-session' },
      backendSdkSessionIds: {},
      outputVerbosity: 'normal',
      sandboxLevel: 'rw',
      status: 'completed',
      bufferedResponseText: 'background result',
      unread: true,
      activityAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const newTab = {
      ...oldTab,
      id: 'new-session',
      codepilotSessionId: 'new-session',
      backendSessionIds: { codex: 'new-session' },
      status: 'idle',
      bufferedResponseText: '',
      unread: false,
    };
    Object.assign(binding, {
      sessionTabs: [oldTab, newTab],
      activeSessionTabId: 'new-session',
    });
    sessions.set('old-session', { id: 'old-session', working_directory: 'C:\\work', model: '' });
    sessions.set('new-session', { id: 'new-session', working_directory: 'C:\\work', model: '' });

    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent);
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-tab',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/tab 1',
      timestamp: Date.now(),
    });

    assert.equal(binding.codepilotSessionId, 'old-session');
    assert.equal((binding as any).activeSessionTabId, 'old-session');
    assert.ok(sent.some((m) => m.text.includes('Switched to tab 1')));
    assert.ok(sent.some((m) => m.text.includes('background result')));
    assert.equal((binding as any).sessionTabs[0].bufferedResponseText, '');
    assert.equal((binding as any).sessionTabs[0].unread, false);
  });

  it('switches tabs from a Feishu tabs choice callback', async () => {
    const { store, binding, sessions } = createCommandStore({
      codepilotSessionId: 'new-session',
      backendSessionIds: { codex: 'new-session' },
    });
    const oldTab = {
      id: 'old-session',
      codepilotSessionId: 'old-session',
      sdkSessionId: '',
      workingDirectory: 'C:\\work',
      model: '',
      mode: 'code',
      backend: 'codex',
      backendGeneration: 0,
      backendSessionIds: { codex: 'old-session' },
      backendSdkSessionIds: {},
      outputVerbosity: 'normal',
      sandboxLevel: 'rw',
      status: 'idle',
      unread: true,
      activityAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const newTab = {
      ...oldTab,
      id: 'new-session',
      codepilotSessionId: 'new-session',
      backendSessionIds: { codex: 'new-session' },
      unread: false,
    };
    Object.assign(binding, {
      sessionTabs: [oldTab, newTab],
      activeSessionTabId: 'new-session',
    });
    sessions.set('old-session', { id: 'old-session', working_directory: 'C:\\work', model: '' });
    sessions.set('new-session', { id: 'new-session', working_directory: 'C:\\work', model: '' });

    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent);
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'card-msg',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '',
      timestamp: Date.now(),
      callbackData: `tabs:switch:${encodeURIComponent('binding-1')}:${encodeURIComponent('old-session')}`,
      callbackMessageId: 'card-msg',
    });

    assert.equal(binding.codepilotSessionId, 'old-session');
    assert.equal((binding as any).activeSessionTabId, 'old-session');
    assert.equal((binding as any).sessionTabs[0].unread, false);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Switched to tab 1/);
    assert.equal(sent[0].replyToMessageId, 'card-msg');
  });

  it('/restart replaces only the current tab and leaves background tabs running', async () => {
    const { store, binding, sessions } = createCommandStore({
      codepilotSessionId: 'active-session',
      backendSessionIds: { codex: 'active-session' },
    });
    const oldActiveTab = {
      id: 'active-session',
      codepilotSessionId: 'active-session',
      sdkSessionId: 'native-active',
      workingDirectory: 'C:\\work',
      model: 'model-a',
      mode: 'plan',
      backend: 'codex',
      backendGeneration: 3,
      backendSessionIds: { codex: 'active-session' },
      backendSdkSessionIds: { codex: 'native-active' },
      outputVerbosity: 'verbose',
      sandboxLevel: 'full',
      status: 'running',
      bufferedResponseText: '',
      unread: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const backgroundTab = {
      ...oldActiveTab,
      id: 'background-session',
      codepilotSessionId: 'background-session',
      sdkSessionId: '',
      backendSessionIds: { codex: 'background-session' },
      backendSdkSessionIds: {},
      status: 'running',
    };
    Object.assign(binding, {
      sdkSessionId: 'native-active',
      workingDirectory: 'C:\\work',
      model: 'model-a',
      mode: 'plan',
      backendGeneration: 3,
      backendSessionIds: { codex: 'active-session' },
      backendSdkSessionIds: { codex: 'native-active' },
      outputVerbosity: 'verbose',
      sandboxLevel: 'full',
      sessionTabs: [oldActiveTab, backgroundTab],
      activeSessionTabId: 'active-session',
    });
    sessions.set('active-session', { id: 'active-session', working_directory: 'C:\\work', model: 'model-a' });
    sessions.set('background-session', { id: 'background-session', working_directory: 'C:\\work', model: 'model-a' });

    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const activeTask = new AbortController();
    const backgroundTask = new AbortController();
    (globalThis as any).__bridge_manager__ = {
      adapters: new Map(),
      adapterMeta: new Map(),
      running: false,
      startedAt: null,
      loopAborts: new Map(),
      activeTasks: new Map([
        [`${binding.id}:codex:active-session`, activeTask],
        [`${binding.id}:codex:background-session`, backgroundTask],
      ]),
      sessionLocks: new Map(),
      autoStartChecked: false,
    };

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent);
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-restart',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/restart',
      timestamp: Date.now(),
    });

    assert.equal(activeTask.signal.aborted, true);
    assert.equal(backgroundTask.signal.aborted, false);
    assert.equal((binding as any).sessionTabs.length, 2);
    assert.equal((binding as any).sessionTabs[1].codepilotSessionId, 'background-session');
    assert.notEqual(binding.codepilotSessionId, 'active-session');
    assert.equal(binding.workingDirectory, 'C:\\work');
    assert.equal(binding.backend, 'codex');
    assert.equal(binding.mode, 'plan');
    assert.equal(binding.outputVerbosity, 'verbose');
    assert.equal(binding.sandboxLevel, 'full');
    assert.equal(binding.sdkSessionId, '');
    assert.equal((binding as any).sessionTabs[0].codepilotSessionId, binding.codepilotSessionId);
    assert.equal((binding as any).activeSessionTabId, binding.codepilotSessionId);
    assert.match(sent[0].text, /Session restarted/);
  });

  it('/reload reloads only the current tab', async () => {
    const { store, binding } = createCommandStore();
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent);
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-reload',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/reload',
      timestamp: Date.now(),
    });

    assert.equal((binding as any).sessionTabs.length, 1);
    assert.notEqual(binding.codepilotSessionId, '0372c636-4840-4160-bc52-0104d69e1378');
    assert.equal((binding as any).activeSessionTabId, binding.codepilotSessionId);
    assert.match(sent[0].text, /Session reloaded/);
  });

  it('sends Feishu final output as a new final card and ignores streaming card hooks', async () => {
    const { store } = createCommandStore({ model: 'gpt-test' });
    initBridgeContext({
      store,
      llm: {
        streamChat: () => createSseStream([
          { type: 'text', data: 'final answer' },
          {
            type: 'result',
            data: {
              usage: {
                input_tokens: 12,
                output_tokens: 7,
                cache_read_input_tokens: 5,
              },
            },
          },
        ]),
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const cards: Array<{ cardJson: string; replyToMessageId?: string }> = [];
    const adapter = createCommandAdapter(sent, {
      sendInteractiveCard: async (_address, cardJson, replyToMessageId) => {
        cards.push({ cardJson, replyToMessageId });
        return { ok: true, messageId: `card-${cards.length}` };
      },
    }) as BaseChannelAdapter & {
      onStreamText?: (_chatId: string, _fullText: string) => void;
      onStreamEnd?: (_chatId: string, _status: string, _responseText: string) => Promise<boolean>;
    };
    let streamTextCalls = 0;
    let streamEndCalls = 0;
    adapter.onStreamText = () => { streamTextCalls += 1; };
    adapter.onStreamEnd = async () => {
      streamEndCalls += 1;
      return true;
    };

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-final',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: 'hello',
      timestamp: Date.now(),
    });

    assert.equal(streamTextCalls, 0);
    assert.equal(streamEndCalls, 0);
    assert.equal(sent.length, 0);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].replyToMessageId, 'msg-final');

    const card = JSON.parse(cards[0].cardJson);
    assert.equal(card.schema, '2.0');
    assert.equal(card.header.title.content, '✅ 最后答复');
    assert.match(card.body.elements[0].content, /final answer/);
    assert.doesNotMatch(JSON.stringify(card), /"tag":"note"/);
    const footer = card.body.elements.at(-1);
    assert.equal(footer.tag, 'markdown');
    assert.match(footer.content, /Tokens: 12 in/);
    assert.match(footer.content, /7 out/);
    assert.match(footer.content, /5 cached/);
    assert.match(footer.content, /Model: gpt-test/);
  });

  it('/peek returns a Feishu Session Peek card with the model summary', async () => {
    const nativeSessionId = 'codex-peek-thread';
    writeJsonl(path.join(process.env.CTI_CODEX_SESSIONS_DIR!, '2026', '06', 'peek.jsonl'), [
      { timestamp: '2026-06-02T00:00:00.000Z', type: 'session_meta', payload: { id: nativeSessionId, cwd: 'C:\\native\\peek' } },
      { timestamp: '2026-06-02T00:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add a /peek command to the bridge.' }] } },
      { timestamp: '2026-06-02T00:02:00.000Z', type: 'response_item', payload: { type: 'function_call', name: 'Edit', arguments: '{"file":"bridge-manager.ts"}' } },
      { timestamp: '2026-06-02T00:03:00.000Z', type: 'response_item', payload: { type: 'agent_message', role: 'assistant', content: [{ type: 'output_text', text: 'Implemented the peek command.' }] } },
    ]);
    const { store, binding } = createCommandStore({
      codepilotSessionId: 'bridge-peek-session',
      backend: 'codex',
      sdkSessionId: nativeSessionId,
      backendSessionIds: { codex: 'bridge-peek-session' },
      backendSdkSessionIds: { codex: nativeSessionId },
      sessionTabs: [createSessionTab('bridge-peek-session', 'codex', '2026-06-02T00:03:00.000Z')],
      activeSessionTabId: 'bridge-peek-session',
    });

    const calls: StreamChatParams[] = [];
    initBridgeContext({
      store,
      llm: createSearchLlm(calls, () => [{ type: 'text', data: 'The agent is wiring up /peek and just edited bridge-manager.ts.' }]),
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const cards: Array<{ cardJson: string; replyToMessageId?: string }> = [];
    const adapter = createCommandAdapter(sent, {
      sendInteractiveCard: async (_address, cardJson, replyToMessageId) => {
        cards.push({ cardJson, replyToMessageId });
        return { ok: true, messageId: 'peek-card-1' };
      },
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-peek-card',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/peek',
      timestamp: Date.now(),
    });

    assert.equal(sent.length, 0);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].replyToMessageId, 'msg-peek-card');
    const card = JSON.parse(cards[0].cardJson);
    assert.equal(card.schema, '2.0');
    assert.equal(card.header.title.content, '会话快照');
    const content = JSON.stringify(card);
    assert.match(content, /The agent is wiring up \/peek/);
    assert.match(content, new RegExp(nativeSessionId));
    assert.match(content, /tool:Edit/);
  });

  it('/peek summarizes with an ephemeral session id that is neither the bridge nor native session', async () => {
    const nativeSessionId = 'codex-peek-ephemeral-thread';
    writeJsonl(path.join(process.env.CTI_CODEX_SESSIONS_DIR!, '2026', '06', 'peek-ephemeral.jsonl'), [
      { timestamp: '2026-06-02T00:00:00.000Z', type: 'session_meta', payload: { id: nativeSessionId, cwd: 'C:\\native\\peek' } },
      { timestamp: '2026-06-02T00:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Investigate the failing test.' }] } },
      { timestamp: '2026-06-02T00:02:00.000Z', type: 'response_item', payload: { type: 'agent_message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking into it now.' }] } },
    ]);
    const { store, binding } = createCommandStore({
      codepilotSessionId: 'bridge-peek-session',
      backend: 'codex',
      sdkSessionId: nativeSessionId,
      backendSessionIds: { codex: 'bridge-peek-session' },
      backendSdkSessionIds: { codex: nativeSessionId },
      sessionTabs: [createSessionTab('bridge-peek-session', 'codex', '2026-06-02T00:02:00.000Z')],
      activeSessionTabId: 'bridge-peek-session',
    });

    const calls: StreamChatParams[] = [];
    initBridgeContext({
      store,
      llm: createSearchLlm(calls, () => [{ type: 'text', data: 'Investigating the failing test.' }]),
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent, {
      sendInteractiveCard: async () => ({ ok: true, messageId: 'peek-card-eph' }),
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-peek-ephemeral',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/peek',
      timestamp: Date.now(),
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].ephemeral, true);
    assert.equal(calls[0].sandboxLevel, 'ro');
    assert.equal(calls[0].permissionMode, 'default');
    assert.equal(calls[0].effort, 'low');
    assert.equal(calls[0].sdkSessionId, undefined);
    assert.equal(calls[0].backendSdkSessionId, undefined);
    assert.match(calls[0].sessionId, /^peek-binding-1-/);
    assert.notEqual(calls[0].sessionId, binding.codepilotSessionId);
    assert.notEqual(calls[0].sessionId, nativeSessionId);
  });

  it('/peek does not change the active session or native binding', async () => {
    const nativeSessionId = 'codex-peek-stable-thread';
    writeJsonl(path.join(process.env.CTI_CODEX_SESSIONS_DIR!, '2026', '06', 'peek-stable.jsonl'), [
      { timestamp: '2026-06-02T00:00:00.000Z', type: 'session_meta', payload: { id: nativeSessionId, cwd: 'C:\\native\\peek' } },
      { timestamp: '2026-06-02T00:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Keep working.' }] } },
      { timestamp: '2026-06-02T00:02:00.000Z', type: 'response_item', payload: { type: 'agent_message', role: 'assistant', content: [{ type: 'output_text', text: 'On it.' }] } },
    ]);
    const { store, binding } = createCommandStore({
      codepilotSessionId: 'bridge-peek-session',
      backend: 'codex',
      sdkSessionId: nativeSessionId,
      backendSessionIds: { codex: 'bridge-peek-session' },
      backendSdkSessionIds: { codex: nativeSessionId },
      sessionTabs: [createSessionTab('bridge-peek-session', 'codex', '2026-06-02T00:02:00.000Z')],
      activeSessionTabId: 'bridge-peek-session',
    });

    initBridgeContext({
      store,
      llm: createSearchLlm([], () => [{ type: 'text', data: 'Still working.' }]),
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent, {
      sendInteractiveCard: async () => ({ ok: true, messageId: 'peek-card-stable' }),
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-peek-stable',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/peek',
      timestamp: Date.now(),
    });

    assert.equal(binding.codepilotSessionId, 'bridge-peek-session');
    assert.equal(binding.activeSessionTabId, 'bridge-peek-session');
    assert.equal(binding.sdkSessionId, nativeSessionId);
    assert.equal(binding.backendSdkSessionIds?.codex, nativeSessionId);
  });

  it('/peek truncates a long transcript before sending it to the summarizer', async () => {
    const nativeSessionId = 'codex-peek-long-thread';
    const rows: unknown[] = [
      { timestamp: '2026-06-02T00:00:00.000Z', type: 'session_meta', payload: { id: nativeSessionId, cwd: 'C:\\native\\peek' } },
    ];
    for (let index = 0; index < 30; index += 1) {
      const marker = index === 0 ? 'OLDEST_MARKER ' : index === 29 ? 'NEWEST_MARKER ' : '';
      rows.push({
        timestamp: new Date(Date.UTC(2026, 5, 2, 0, index, 0)).toISOString(),
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${marker}${'x'.repeat(400)}` }] },
      });
    }
    writeJsonl(path.join(process.env.CTI_CODEX_SESSIONS_DIR!, '2026', '06', 'peek-long.jsonl'), rows);

    const { store } = createCommandStore({
      codepilotSessionId: 'bridge-peek-session',
      backend: 'codex',
      sdkSessionId: nativeSessionId,
      backendSessionIds: { codex: 'bridge-peek-session' },
      backendSdkSessionIds: { codex: nativeSessionId },
      sessionTabs: [createSessionTab('bridge-peek-session', 'codex', '2026-06-02T00:30:00.000Z')],
      activeSessionTabId: 'bridge-peek-session',
    });

    const calls: StreamChatParams[] = [];
    initBridgeContext({
      store,
      llm: createSearchLlm(calls, () => [{ type: 'text', data: 'summary' }]),
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const adapter = createCommandAdapter(sent, {
      sendInteractiveCard: async () => ({ ok: true, messageId: 'peek-card-long' }),
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-peek-long',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/peek',
      timestamp: Date.now(),
    });

    assert.equal(calls.length, 1);
    // Most recent activity is kept; oldest is dropped by the strict char cap.
    assert.match(calls[0].prompt, /NEWEST_MARKER/);
    assert.doesNotMatch(calls[0].prompt, /OLDEST_MARKER/);
    assert.match(calls[0].prompt, /…/);
    // Full transcript is ~12k chars; the truncated prompt must stay well under that.
    assert.ok(calls[0].prompt.length < 7500, `prompt too long: ${calls[0].prompt.length}`);
  });

  it('/peek falls back to a local summary when the summarizer fails', async () => {
    const nativeSessionId = 'codex-peek-fallback-thread';
    writeJsonl(path.join(process.env.CTI_CODEX_SESSIONS_DIR!, '2026', '06', 'peek-fallback.jsonl'), [
      { timestamp: '2026-06-02T00:00:00.000Z', type: 'session_meta', payload: { id: nativeSessionId, cwd: 'C:\\native\\peek' } },
      { timestamp: '2026-06-02T00:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run the failing migration.' }] } },
      { timestamp: '2026-06-02T00:02:00.000Z', type: 'response_item', payload: { type: 'agent_message', role: 'assistant', content: [{ type: 'output_text', text: 'Migration applied successfully.' }] } },
    ]);
    const { store } = createCommandStore({
      codepilotSessionId: 'bridge-peek-session',
      backend: 'codex',
      sdkSessionId: nativeSessionId,
      backendSessionIds: { codex: 'bridge-peek-session' },
      backendSdkSessionIds: { codex: nativeSessionId },
      sessionTabs: [createSessionTab('bridge-peek-session', 'codex', '2026-06-02T00:02:00.000Z')],
      activeSessionTabId: 'bridge-peek-session',
    });

    const calls: StreamChatParams[] = [];
    initBridgeContext({
      store,
      llm: createSearchLlm(calls, () => [{ type: 'error', data: 'summarizer unavailable' }]),
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const cards: string[] = [];
    const adapter = createCommandAdapter(sent, {
      sendInteractiveCard: async (_address, cardJson) => {
        cards.push(cardJson);
        return { ok: true, messageId: 'peek-card-fallback' };
      },
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-peek-fallback',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/peek',
      timestamp: Date.now(),
    });

    assert.equal(calls.length, 1);
    assert.equal(cards.length, 1);
    assert.match(cards[0], /本地兜底/);
    assert.match(cards[0], /Migration applied successfully\./);
  });

  it('/peek reports when there is no native session yet without calling the summarizer', async () => {
    const { store, binding } = createCommandStore({
      codepilotSessionId: 'bridge-peek-fresh',
      backend: 'codex',
      sdkSessionId: '',
      backendSessionIds: { codex: 'bridge-peek-fresh' },
      backendSdkSessionIds: {},
      sessionTabs: [createSessionTab('bridge-peek-fresh', 'codex', '2026-06-02T00:00:00.000Z')],
      activeSessionTabId: 'bridge-peek-fresh',
    });

    const calls: StreamChatParams[] = [];
    initBridgeContext({
      store,
      llm: createSearchLlm(calls, () => [{ type: 'text', data: 'should not be called' }]),
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const sent: OutboundMessage[] = [];
    const cards: string[] = [];
    const adapter = createCommandAdapter(sent, {
      sendInteractiveCard: async (_address, cardJson) => {
        cards.push(cardJson);
        return { ok: true, messageId: 'peek-card-fresh' };
      },
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-peek-fresh',
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '/peek',
      timestamp: Date.now(),
    });

    assert.equal(calls.length, 0);
    assert.equal(cards.length, 1);
    assert.match(cards[0], /尚未建立 native session/);
    assert.equal(binding.codepilotSessionId, 'bridge-peek-fresh');
  });
});

function createMinimalStore(settings: Record<string, string> = {}): BridgeStore {
  return {
    getSetting: (key: string) => settings[key] ?? null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({} as any),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: () => null,
    createSession: () => ({ id: '1', working_directory: '', model: '' }),
    updateSessionProviderId: () => {},
    addMessage: () => {},
    getMessages: () => ({ messages: [] }),
    acquireSessionLock: () => true,
    renewSessionLock: () => {},
    releaseSessionLock: () => {},
    setSessionRuntimeStatus: () => {},
    updateSdkSessionId: () => {},
    updateSessionModel: () => {},
    syncSdkTasks: () => {},
    getProvider: () => undefined,
    getDefaultProviderId: () => null,
    insertAuditLog: () => {},
    checkDedup: () => false,
    insertDedup: () => {},
    cleanupExpiredDedup: () => {},
    insertOutboundRef: () => {},
    insertPermissionLink: () => {},
    getPermissionLink: () => null,
    markPermissionLinkResolved: () => false,
    listPendingPermissionLinksByChat: () => [],
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}

function createCommandAdapter(
  sent: OutboundMessage[],
  options: {
    channelType?: string;
    sendInteractiveCard?: (
      address: { channelType: string; chatId: string; userId?: string; displayName?: string },
      cardJson: string,
      replyToMessageId?: string,
    ) => Promise<SendResult>;
  } = {},
): BaseChannelAdapter {
  return {
    channelType: options.channelType ?? 'feishu',
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    consumeOne: async () => null,
    send: async (msg: OutboundMessage): Promise<SendResult> => {
      sent.push(msg);
      return { ok: true, messageId: `sent-${sent.length}` };
    },
    ...(options.sendInteractiveCard ? { sendInteractiveCard: options.sendInteractiveCard } : {}),
    validateConfig: () => null,
    isAuthorized: () => true,
  } as unknown as BaseChannelAdapter;
}

function createSearchLlm(
  calls: StreamChatParams[],
  eventsForCall: (params: StreamChatParams, callNumber: number) => Array<{ type: string; data: unknown }>,
): LLMProvider {
  return {
    streamChat: (params: StreamChatParams) => {
      calls.push(params);
      return createSseStream(eventsForCall(params, calls.length));
    },
  };
}

function extractSearchToken(cardJson: string, action: 'confirm' | 'again'): string {
  const prefix = `tabs:search:${action}:`;
  const start = cardJson.indexOf(prefix);
  assert.notEqual(start, -1, `missing ${action} callback token`);
  const rest = cardJson.slice(start + prefix.length);
  const end = rest.search(/["\\]/);
  return end >= 0 ? rest.slice(0, end) : rest;
}

function createSseStream(events: Array<{ type: string; data: unknown }>): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(`data: ${JSON.stringify({
          type: event.type,
          data: typeof event.data === 'string' ? event.data : JSON.stringify(event.data),
        })}\n`);
      }
      controller.close();
    },
  });
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n'), 'utf-8');
}

function createSessionTab(
  id: string,
  backend: NonNullable<BridgeSessionTab['backend']>,
  updatedAt: string,
): BridgeSessionTab {
  return {
    id,
    codepilotSessionId: id,
    sdkSessionId: '',
    workingDirectory: backend === 'codex' ? 'C:\\global' : 'C:\\claude',
    model: '',
    mode: 'code',
    backend,
    backendGeneration: 0,
    backendSessionIds: { [backend]: id },
    backendSdkSessionIds: {},
    status: 'completed',
    bufferedResponseText: '',
    bufferedErrorMessage: '',
    unread: false,
    activityAt: updatedAt,
    createdAt: updatedAt,
    updatedAt,
  };
}

function createCommandStore(overrides: Partial<ChannelBinding> = {}): {
  store: BridgeStore;
  binding: ChannelBinding;
  sessions: Map<string, BridgeSession>;
} {
  const binding: ChannelBinding = {
    id: 'binding-1',
    channelType: 'feishu',
    chatId: 'chat-1',
    codepilotSessionId: '0372c636-4840-4160-bc52-0104d69e1378',
    sdkSessionId: '',
    workingDirectory: 'C:\\work',
    model: '',
    mode: 'code',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    backend: 'codex',
    backendGeneration: 0,
    backendSessionIds: { codex: '0372c636-4840-4160-bc52-0104d69e1378' },
    backendSdkSessionIds: {},
    outputVerbosity: 'normal',
    sandboxLevel: 'rw',
    ...overrides,
  };
  const sessions = new Map<string, BridgeSession>();
  sessions.set(binding.codepilotSessionId, {
    id: binding.codepilotSessionId,
    working_directory: binding.workingDirectory,
    model: binding.model,
    ...(binding.sdkSessionId ? { sdkSessionId: binding.sdkSessionId } : {}),
  });

  const store: BridgeStore = {
    getSetting: () => null,
    getChannelBinding: (channelType: string, chatId: string) =>
      channelType === binding.channelType && chatId === binding.chatId ? binding : null,
    upsertChannelBinding: () => binding,
    updateChannelBinding: (_id: string, updates: Partial<ChannelBinding>) => {
      Object.assign(binding, updates);
    },
    listChannelBindings: () => [binding],
    getSession: (id: string) => sessions.get(id) ?? null,
    createSession: (_name: string, model: string, systemPrompt?: string, cwd?: string): BridgeSession => {
      const id = `created-session-${sessions.size + 1}`;
      const session: BridgeSession = {
        id,
        working_directory: cwd || 'C:\\work',
        model,
        ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
      };
      sessions.set(id, session);
      return session;
    },
    updateSessionProviderId: () => {},
    addMessage: () => {},
    getMessages: () => ({ messages: [] }),
    acquireSessionLock: () => true,
    renewSessionLock: () => {},
    releaseSessionLock: () => {},
    setSessionRuntimeStatus: () => {},
    updateSdkSessionId: (sessionId: string, sdkSessionId: string) => {
      const existing = sessions.get(sessionId);
      if (existing) {
        sessions.set(sessionId, { ...existing, sdkSessionId });
      }
    },
    updateSessionModel: () => {},
    syncSdkTasks: () => {},
    getProvider: () => undefined,
    getDefaultProviderId: () => null,
    insertAuditLog: () => {},
    checkDedup: () => false,
    insertDedup: () => {},
    cleanupExpiredDedup: () => {},
    insertOutboundRef: () => {},
    insertPermissionLink: () => {},
    getPermissionLink: () => null,
    markPermissionLinkResolved: () => false,
    listPendingPermissionLinksByChat: () => [],
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };

  return { store, binding, sessions };
}
