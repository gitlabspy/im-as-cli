/**
 * Channel Router — resolves IM addresses to host sessions.
 *
 * When a message arrives from an IM channel, the router finds or creates
 * the corresponding ChannelBinding (and underlying chat_session).
 */

import type { BackendName, ChannelAddress, ChannelBinding, ChannelType } from './types.js';
import { getBridgeContext } from './context.js';

/**
 * Resolve the default backend for a new binding.
 * Reads from store setting `bridge_default_backend` or env `CTI_RUNTIME` (mapped),
 * falling back to 'claudecode'.
 */
function resolveDefaultBackend(): BackendName {
  const { store } = getBridgeContext();
  const raw =
    (store.getSetting('bridge_default_backend') || process.env.CTI_RUNTIME || '').toLowerCase();
  if (raw === 'codex') return 'codex';
  if (raw === 'copilot') return 'copilot';
  if (raw === 'claude' || raw === 'claudecode') return 'claudecode';
  return 'claudecode';
}

/**
 * Resolve an inbound address to a ChannelBinding.
 * If no binding exists, auto-creates a new session and binding.
 */
export function resolve(address: ChannelAddress): ChannelBinding {
  const { store } = getBridgeContext();
  const existing = store.getChannelBinding(address.channelType, address.chatId);
  if (existing) {
    // Verify the linked session still exists; if not, create a new one
    const session = store.getSession(existing.codepilotSessionId);
    if (session) return existing;
    // Session was deleted — recreate
    return createBinding(address);
  }
  return createBinding(address);
}

/**
 * Create a new binding with a fresh host session.
 */
export function createBinding(
  address: ChannelAddress,
  workingDirectory?: string,
): ChannelBinding {
  const { store } = getBridgeContext();
  const defaultCwd = workingDirectory
    || store.getSetting('bridge_default_work_dir')
    || process.env.HOME
    || '';
  const defaultModel = store.getSetting('bridge_default_model') || '';
  const defaultProviderId = store.getSetting('bridge_default_provider_id') || '';

  const displayName = address.displayName || address.chatId;
  const session = store.createSession(
    `Bridge: ${displayName}`,
    defaultModel,
    undefined,
    defaultCwd,
    'code',
  );

  if (defaultProviderId) {
    store.updateSessionProviderId(session.id, defaultProviderId);
  }

  const defaultBackend = resolveDefaultBackend();

  return store.upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    codepilotSessionId: session.id,
    sdkSessionId: '',
    workingDirectory: defaultCwd,
    model: defaultModel,
    mode: 'code',
    backend: defaultBackend,
    backendGeneration: 0,
    backendSessionIds: { [defaultBackend]: session.id } as Partial<Record<BackendName, string>>,
    backendSdkSessionIds: {},
    outputVerbosity: 'normal',
    sandboxLevel: 'rw',
  });
}

/**
 * Bind an IM chat to an existing host session.
 *
 * The target session owns its own `sdkSessionId` (the provider-level resume id).
 * We refresh the binding's cached `sdkSessionId` from the target session so the
 * next message resumes the correct provider session — never the previous
 * chat's stale resume id.
 */
export function bindToSession(
  address: ChannelAddress,
  codepilotSessionId: string,
): ChannelBinding | null {
  const { store } = getBridgeContext();
  const session = store.getSession(codepilotSessionId);
  if (!session) return null;

  return store.upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    codepilotSessionId,
    sdkSessionId: session.sdkSessionId ?? '',
    workingDirectory: session.working_directory,
    model: session.model,
  });
}

/**
 * Update properties of an existing binding.
 */
export function updateBinding(
  id: string,
  updates: Partial<Pick<ChannelBinding,
    | 'sdkSessionId'
    | 'workingDirectory'
    | 'model'
    | 'mode'
    | 'active'
    | 'backend'
    | 'backendGeneration'
    | 'backendSessionIds'
    | 'backendSdkSessionIds'
    | 'outputVerbosity'
    | 'sandboxLevel'
    | 'codepilotSessionId'
    | 'sessionTabs'
    | 'activeSessionTabId'
  >>,
): void {
  getBridgeContext().store.updateChannelBinding(id, updates);
}

/**
 * List all bindings, optionally filtered by channel type.
 */
export function listBindings(channelType?: ChannelType): ChannelBinding[] {
  return getBridgeContext().store.listChannelBindings(channelType);
}
