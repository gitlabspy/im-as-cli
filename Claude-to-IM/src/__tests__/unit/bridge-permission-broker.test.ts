/**
 * Unit tests for bridge permission-broker.
 *
 * Tests cover:
 * - handlePermissionCallback: action parsing, chat validation, dedup
 * - Permission resolution via PermissionGateway
 * - Callback data parsing with colons in permId
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import { forwardPermissionRequest, handlePermissionCallback } from '../../lib/bridge/permission-broker';
import type { BridgeStore, PermissionGateway, PermissionResolution } from '../../lib/bridge/host';

// ── Mock Store ──────────────────────────────────────────────

function createMockStore() {
  const links = new Map<string, { chatId: string; messageId: string; resolved: boolean; suggestions: string }>();

  return {
    links,
    getSetting: () => null,
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
    insertPermissionLink: (link: { permissionRequestId: string; chatId: string; messageId: string; suggestions: string; kind?: string; choices?: string }) => {
      links.set(link.permissionRequestId, {
        chatId: link.chatId,
        messageId: link.messageId,
        resolved: false,
        suggestions: link.suggestions,
        ...(link.kind ? { kind: link.kind } : {}),
        ...(link.choices ? { choices: link.choices } : {}),
      } as any);
    },
    getPermissionLink: (id: string) => {
      return links.get(id) ?? null;
    },
    markPermissionLinkResolved: (id: string) => {
      const link = links.get(id);
      if (!link || link.resolved) return false;
      link.resolved = true;
      return true;
    },
    listPendingPermissionLinksByChat: (chatId: string) => {
      return [...links.values()].filter(l => l.chatId === chatId && !l.resolved);
    },
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}

// ── Mock Permission Gateway ─────────────────────────────────

function createMockGateway() {
  const resolved: Array<{ id: string; resolution: PermissionResolution }> = [];
  return {
    resolved,
    resolvePendingPermission(id: string, resolution: PermissionResolution) {
      resolved.push({ id, resolution });
      return true;
    },
  };
}

type MockStore = ReturnType<typeof createMockStore>;
type MockGateway = ReturnType<typeof createMockGateway>;

function setupContext(store: MockStore, gateway: MockGateway) {
  delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  initBridgeContext({
    store: store as unknown as BridgeStore,
    llm: { streamChat: () => new ReadableStream() },
    permissions: gateway,
    lifecycle: {},
  });
}

// ── Tests ───────────────────────────────────────────────────

describe('permission-broker', () => {
  let store: MockStore;
  let gateway: MockGateway;

  beforeEach(() => {
    store = createMockStore();
    gateway = createMockGateway();
    setupContext(store, gateway);
  });

  it('returns false for non-perm callback data', async () => {
    assert.equal(await handlePermissionCallback('other:data', '123'), false);
  });

  it('returns false when permission link not found', async () => {
    assert.equal(await handlePermissionCallback('perm:allow:unknown-id', '123'), false);
  });

  it('returns false when chatId does not match', async () => {
    store.links.set('perm-1', {
      chatId: '999',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });

    assert.equal(await handlePermissionCallback('perm:allow:perm-1', '123'), false);
  });

  it('returns false when messageId does not match', async () => {
    store.links.set('perm-1', {
      chatId: '123',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });

    assert.equal(await handlePermissionCallback('perm:allow:perm-1', '123', 'wrong-msg'), false);
  });

  it('resolves allow action correctly', async () => {
    store.links.set('perm-1', {
      chatId: '123',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });

    const result = await handlePermissionCallback('perm:allow:perm-1', '123');
    assert.ok(result);
    assert.equal(gateway.resolved.length, 1);
    assert.equal(gateway.resolved[0].resolution.behavior, 'allow');
  });

  it('resolves deny action correctly', async () => {
    store.links.set('perm-2', {
      chatId: '456',
      messageId: 'msg-2',
      resolved: false,
      suggestions: '',
    });

    const result = await handlePermissionCallback('perm:deny:perm-2', '456');
    assert.ok(result);
    assert.equal(gateway.resolved[0].resolution.behavior, 'deny');
    assert.equal(gateway.resolved[0].resolution.message, 'Denied via IM bridge');
  });

  it('prevents duplicate resolution', async () => {
    store.links.set('perm-3', {
      chatId: '123',
      messageId: 'msg-3',
      resolved: false,
      suggestions: '',
    });

    const first = await handlePermissionCallback('perm:allow:perm-3', '123');
    assert.ok(first);

    const second = await handlePermissionCallback('perm:allow:perm-3', '123');
    assert.equal(second, false);
    assert.equal(gateway.resolved.length, 1);
  });

  it('handles permId with colons', async () => {
    store.links.set('perm:with:colons', {
      chatId: '123',
      messageId: 'msg-4',
      resolved: false,
      suggestions: '',
    });

    const result = await handlePermissionCallback('perm:allow:perm:with:colons', '123');
    assert.ok(result);
    assert.equal(gateway.resolved[0].id, 'perm:with:colons');
  });

  it('allow_session passes suggestions as updatedPermissions', async () => {
    const suggestions = JSON.stringify([{ type: 'allow', toolName: 'Bash' }]);
    store.links.set('perm-4', {
      chatId: '123',
      messageId: 'msg-5',
      resolved: false,
      suggestions,
    });

    const result = await handlePermissionCallback('perm:allow_session:perm-4', '123');
    assert.ok(result);
    assert.equal(gateway.resolved[0].resolution.behavior, 'allow');
    assert.ok((gateway.resolved[0].resolution as any).updatedPermissions);
  });

  it('resolves an AskUserQuestion choice with the selected label as the answer', async () => {
    store.links.set('q-1', {
      chatId: '123',
      messageId: 'msg-q1',
      resolved: false,
      suggestions: '',
      kind: 'question',
      choices: JSON.stringify([
        { index: 1, label: 'Use PostgreSQL' },
        { index: 2, label: 'Use SQLite' },
      ]),
    } as any);

    const result = await handlePermissionCallback('perm:choice:2:q-1', '123');
    assert.ok(result);
    assert.equal(gateway.resolved.length, 1);
    assert.equal(gateway.resolved[0].id, 'q-1');
    assert.equal(gateway.resolved[0].resolution.behavior, 'deny');
    assert.equal(gateway.resolved[0].resolution.message, 'User selected: Use SQLite');
  });

  it('rejects an out-of-range choice index without resolving', async () => {
    store.links.set('q-2', {
      chatId: '123',
      messageId: 'msg-q2',
      resolved: false,
      suggestions: '',
      kind: 'question',
      choices: JSON.stringify([{ index: 1, label: 'Only option' }]),
    } as any);

    const result = await handlePermissionCallback('perm:choice:5:q-2', '123');
    assert.equal(result, false);
    assert.equal(gateway.resolved.length, 0);
    // The link must stay unresolved so the user can retry.
    assert.equal(store.links.get('q-2')!.resolved, false);
  });

  it('acknowledges choice_other without resolving the pending question', async () => {
    store.links.set('q-3', {
      chatId: '123',
      messageId: 'msg-q3',
      resolved: false,
      suggestions: '',
      kind: 'question',
      choices: JSON.stringify([{ index: 1, label: 'A' }, { index: 2, label: 'B' }]),
    } as any);

    const result = await handlePermissionCallback('perm:choice_other:q-3', '123');
    assert.ok(result);
    // No resolution yet — the question stays open for the user's free-form text.
    assert.equal(gateway.resolved.length, 0);
    assert.equal(store.links.get('q-3')!.resolved, false);
  });
});

describe('permission-broker forwardPermissionRequest (AskUserQuestion)', () => {
  let store: MockStore;
  let gateway: MockGateway;

  beforeEach(() => {
    store = createMockStore();
    gateway = createMockGateway();
    setupContext(store, gateway);
  });

  it('renders an AskUserQuestion as a Feishu option-button card and stores choices', async () => {
    const cards: Array<{ cardJson: string; replyToMessageId?: string }> = [];
    const adapter = {
      channelType: 'feishu',
      send: async () => ({ ok: true, messageId: 'sent-1' }),
      sendInteractiveCard: async (_address: unknown, cardJson: string, replyToMessageId?: string) => {
        cards.push({ cardJson, replyToMessageId });
        return { ok: true, messageId: 'q-card-1' };
      },
    } as any;

    await forwardPermissionRequest(
      adapter,
      { channelType: 'feishu', chatId: 'chat-1' },
      'q-perm-1',
      'AskUserQuestion',
      { questions: [{ question: 'Which database?', options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }] }] },
      'session-1',
      [],
      'msg-1',
      {
        kind: 'question',
        questionText: 'Which database?',
        choices: [
          { index: 1, label: 'PostgreSQL' },
          { index: 2, label: 'SQLite' },
        ],
      },
    );

    assert.equal(cards.length, 1);
    assert.equal(cards[0].replyToMessageId, 'msg-1');
    assert.match(cards[0].cardJson, /Which database\?/);
    assert.match(cards[0].cardJson, /perm:choice:1:q-perm-1/);
    assert.match(cards[0].cardJson, /perm:choice:2:q-perm-1/);
    assert.match(cards[0].cardJson, /perm:choice_other:q-perm-1/);
    // 其他（自定义回复）custom-reply button present
    assert.match(cards[0].cardJson, /自定义回复/);

    // Link stored with kind=question and serialized choices for later callbacks.
    const link = store.links.get('q-perm-1') as any;
    assert.ok(link);
    assert.equal(link.kind, 'question');
    assert.match(link.choices, /PostgreSQL/);
  });

  it('renders an AskUserQuestion as numbered text on QQ/WeChat (no buttons)', async () => {
    const sent: Array<{ text: string }> = [];
    const adapter = {
      channelType: 'qq',
      send: async (msg: { text: string }) => {
        sent.push({ text: msg.text });
        return { ok: true, messageId: 'qq-1' };
      },
    } as any;

    await forwardPermissionRequest(
      adapter,
      { channelType: 'qq', chatId: 'chat-1' },
      'q-perm-2',
      'AskUserQuestion',
      {},
      'session-1',
      [],
      'msg-1',
      {
        kind: 'question',
        questionText: 'Pick one',
        choices: [
          { index: 1, label: 'Alpha' },
          { index: 2, label: 'Beta' },
        ],
      },
    );

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Pick one/);
    assert.match(sent[0].text, /1 - Alpha/);
    assert.match(sent[0].text, /2 - Beta/);
  });
});

