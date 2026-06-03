/**
 * Regression test for the Feishu↔agent session boundary fix.
 *
 * Bug: conversation-engine.ts was loading the bridge's local message log via
 * store.getMessages() and passing it as `conversationHistory` to streamChat.
 * The provider's own resume mechanism (sdkSessionId) is the single source of
 * truth — re-injecting the bridge log contaminates the backend session.
 *
 * This test verifies the LLM provider receives `conversationHistory: undefined`
 * regardless of what's in the bridge store's message log.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import { processMessage } from '../../lib/bridge/conversation-engine';
import type {
  BridgeStore,
  LLMProvider,
  PermissionGateway,
  LifecycleHooks,
  StreamChatParams,
} from '../../lib/bridge/host';
import type { ChannelBinding } from '../../lib/bridge/types';

// ── Minimal mock store ──

function createStore(): BridgeStore {
  const messages = new Map<string, Array<{ role: string; content: string }>>();
  const sessions = new Map<string, {
    id: string;
    working_directory: string;
    model: string;
    sdkSessionId?: string;
  }>();
  sessions.set('s1', { id: 's1', working_directory: '/w', model: 'm' });
  // Seed bridge log with old IM history — must NOT leak into the prompt.
  messages.set('s1', [
    { role: 'user', content: 'feishu-old-1' },
    { role: 'assistant', content: 'feishu-old-2' },
    { role: 'user', content: 'feishu-old-3' },
  ]);

  return {
    getSetting: () => null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({} as ChannelBinding),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: (id) => sessions.get(id) ?? null,
    createSession: () => ({ id: 'new', working_directory: '', model: '' }),
    updateSessionProviderId: () => {},
    addMessage: (sid, role, content) => {
      const arr = messages.get(sid) ?? [];
      arr.push({ role, content });
      messages.set(sid, arr);
    },
    getMessages: (sid) => ({ messages: [...(messages.get(sid) ?? [])] }),
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

function makeBinding(): ChannelBinding {
  return {
    id: 'b1',
    channelType: 'telegram',
    chatId: 'c1',
    codepilotSessionId: 's1',
    sdkSessionId: '',
    workingDirectory: '/w',
    model: 'm',
    mode: 'code',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    backend: 'claudecode',
    backendGeneration: 0,
    backendSessionIds: { claudecode: 's1' },
    backendSdkSessionIds: {},
    outputVerbosity: 'normal',
  };
}

describe('conversation-engine — Feishu history must not leak into prompt', () => {
  let capturedParams: StreamChatParams | null = null;

  beforeEach(() => {
    capturedParams = null;
    const llm: LLMProvider = {
      streamChat: (params) => {
        capturedParams = params;
        // Emit a single done event so consumeStream resolves promptly.
        return new ReadableStream<string>({
          start(controller) {
            controller.enqueue('event: done\ndata: {}\n\n');
            controller.close();
          },
        });
      },
    };
    const perms: PermissionGateway = { resolvePendingPermission: () => false };
    const lifecycle: LifecycleHooks = {};
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
    initBridgeContext({ store: createStore(), llm, permissions: perms, lifecycle });
  });

  it('does not pass conversationHistory to streamChat', async () => {
    await processMessage(makeBinding(), 'new-message');
    assert.ok(capturedParams, 'streamChat was not called');
    assert.equal(
      (capturedParams as StreamChatParams).conversationHistory,
      undefined,
      'conversationHistory must be undefined — backend owns its own context via resume',
    );
  });
});
