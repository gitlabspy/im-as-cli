/**
 * Bridge system types — shared across all bridge modules.
 *
 * The bridge connects external IM channels (Telegram, Discord, Slack)
 * to host chat sessions, allowing users to interact with Claude
 * from their preferred messaging platform.
 */

// Re-export bridge-local types from host.ts so consumers can import from one place
export type { FileAttachment } from './host.js';

// ── Channel Types ──────────────────────────────────────────────

/**
 * Channel type identifier.
 * Extensible — any string is valid so new adapters can register without
 * modifying this definition. Well-known values: 'telegram', 'discord', 'slack'.
 */
export type ChannelType = string;

/** Unique address of a user within a channel */
export interface ChannelAddress {
  channelType: ChannelType;
  chatId: string;        // Platform-specific chat/channel identifier
  userId?: string;       // Platform-specific user identifier (optional for group chats)
  displayName?: string;  // Human-readable name for audit logs
}

/** Composite key for routing: channelType + chatId */
export interface SessionKey {
  channelType: ChannelType;
  chatId: string;
}

// ── Messages ───────────────────────────────────────────────────

/** Inbound message from an IM channel */
export interface InboundMessage {
  /** Platform-specific message ID (for dedup and reference) */
  messageId: string;
  /** Address of the sender */
  address: ChannelAddress;
  /** Plain text content of the message */
  text: string;
  /** Timestamp of the message (ISO string or unix epoch ms) */
  timestamp: number;
  /** If this is a callback query (inline button press), the callback data */
  callbackData?: string;
  /** For callback queries: the message ID of the original message that triggered the callback */
  callbackMessageId?: string;
  /** Platform-specific raw update object (for adapter-specific handling) */
  raw?: unknown;
  /** Adapter-specific update ID for deferred offset acknowledgement */
  updateId?: number;
  /** File attachments (images, documents) from the IM channel */
  attachments?: import('./host.js').FileAttachment[];
}

/** Outbound message to send to an IM channel */
export interface OutboundMessage {
  /** Target address */
  address: ChannelAddress;
  /** Message text (may contain HTML for Telegram) */
  text: string;
  /** Parse mode for the text */
  parseMode?: 'HTML' | 'Markdown' | 'plain';
  /** Inline keyboard buttons */
  inlineButtons?: InlineButton[][];
  /** If replying to a specific message */
  replyToMessageId?: string;
}

/** Inline keyboard button for permission prompts */
export interface InlineButton {
  text: string;
  callbackData: string;
}

/** Result of sending a message via an adapter */
export interface SendResult {
  ok: boolean;
  /** Platform-specific message ID of the sent message */
  messageId?: string;
  error?: string;
}

// ── Bindings ───────────────────────────────────────────────────

/**
 * Backend identifier — selects which LLM CLI/SDK provider handles the chat.
 *
 * Per-binding (not global): users switch via `/backend` slash command, and
 * each backend has its own session lane so an old backend's lock can't block
 * the new backend.
 */
export type BackendName = 'codex' | 'claudecode' | 'copilot';

/** Output verbosity for relayed process/tool/status messages. */
export type OutputVerbosity = 'quiet' | 'normal' | 'verbose';

/**
 * Sandbox permission level — caps what tools the backend can actually execute.
 * Orthogonal to `mode` (which controls approval behavior).
 * - 'ro'   → read-only (Codex: read-only, CC: plan, Copilot: --no-tools)
 * - 'rw'   → workspace-write (default; Codex: workspace-write, CC: per-mode, Copilot: env-driven)
 * - 'full' → danger-full-access (Codex: danger-full-access, CC: bypassPermissions, Copilot: force-enable tools)
 */
export type SandboxLevel = 'ro' | 'rw' | 'full';

export type ChatMode = 'code' | 'plan' | 'ask';

/** Runtime state for a logical session tab inside one IM chat. */
export type BridgeSessionTabStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'error'
  | 'unavailable';

/**
 * A logical session tab owned by one IM chat.
 *
 * The active tab is mirrored onto ChannelBinding's legacy top-level fields so
 * existing routing code can keep using ChannelBinding directly.
 */
export interface BridgeSessionTab {
  id: string;
  codepilotSessionId: string;
  sdkSessionId: string;
  workingDirectory: string;
  model: string;
  mode: ChatMode;
  backend?: BackendName;
  backendGeneration?: number;
  backendSessionIds?: Partial<Record<BackendName, string>>;
  backendSdkSessionIds?: Partial<Record<BackendName, string>>;
  outputVerbosity?: OutputVerbosity;
  sandboxLevel?: SandboxLevel;
  status?: BridgeSessionTabStatus;
  bufferedResponseText?: string;
  bufferedErrorMessage?: string;
  bufferedAt?: string;
  unread?: boolean;
  nativeSessionId?: string;
  nativeSource?: 'claude' | 'codex';
  lastUserQuestion?: string;
  lastAgentOutput?: string;
  createdAt: string;
  updatedAt: string;
}

/** Links an IM chat to a host session */
export interface ChannelBinding {
  id: string;
  channelType: ChannelType;
  chatId: string;
  /** Host session ID this chat is bound to */
  codepilotSessionId: string;
  /** SDK session ID for resume (cached from last conversation) */
  sdkSessionId: string;
  /** Working directory for this binding */
  workingDirectory: string;
  /** Model override for this binding */
  model: string;
  /** Chat mode */
  mode: ChatMode;
  /** Whether this binding is currently active */
  active: boolean;
  createdAt: string;
  updatedAt: string;
  // ── Backend switching (Phase 1: per-binding backend lane) ──
  /** Currently active backend for this binding. Defaults to the daemon's CTI_RUNTIME at first use. */
  backend?: BackendName;
  /**
   * Monotonically increasing counter bumped on every `/backend` or `/repair`.
   * Output from tasks captured under an older generation is silently dropped.
   */
  backendGeneration?: number;
  /** Per-backend host session ID lane (so old backend's lock cannot block new backend). */
  backendSessionIds?: Partial<Record<BackendName, string>>;
  /** Per-backend native SDK/CLI session ID for resume across turns. */
  backendSdkSessionIds?: Partial<Record<BackendName, string>>;
  /** Verbosity for relayed process/tool/status messages. Defaults to 'normal'. */
  outputVerbosity?: OutputVerbosity;
  /** Sandbox permission level — caps tool capability per backend. Defaults to 'rw'. */
  sandboxLevel?: SandboxLevel;
  /** Logical sessions for this IM chat. */
  sessionTabs?: BridgeSessionTab[];
  /** Active logical session tab id. */
  activeSessionTabId?: string;
}

// ── Bridge Status ──────────────────────────────────────────────

/** Overall bridge system status */
export interface BridgeStatus {
  running: boolean;
  startedAt: string | null;
  adapters: AdapterStatus[];
}

/** Status of a single channel adapter */
export interface AdapterStatus {
  channelType: ChannelType;
  running: boolean;
  connectedAt: string | null;
  lastMessageAt: string | null;
  error: string | null;
}

// ── Audit & Dedup ──────────────────────────────────────────────

/** Audit log entry */
export interface AuditLogEntry {
  id: string;
  channelType: ChannelType;
  chatId: string;
  direction: 'inbound' | 'outbound';
  messageId: string;
  summary: string;
  createdAt: string;
}

/** Permission link: maps permissionRequestId to an IM message for callback handling */
export interface PermissionLink {
  id: string;
  permissionRequestId: string;
  channelType: ChannelType;
  chatId: string;
  messageId: string;
  createdAt: string;
}

// ── Streaming Preview ─────────────────────────────────────────

/** Capabilities of a channel adapter's streaming preview support */
export interface PreviewCapabilities {
  supported: boolean;
  privateOnly: boolean;
}

/** Mutable state for an in-flight streaming preview */
export interface StreamingPreviewState {
  draftId: number;           // non-zero 31-bit random integer, reused within one answer cycle
  chatId: string;
  lastSentText: string;      // last text actually sent as draft
  lastSentAt: number;        // timestamp (ms) of last sent draft
  degraded: boolean;         // set true after API failure → skip further previews
  throttleTimer: ReturnType<typeof setTimeout> | null;
  pendingText: string;       // latest accumulated text (may not yet be sent due to throttle)
}

// ── Tool Call Info ─────────────────────────────────────────────

/** Tool call tracking for card progress display */
export interface ToolCallInfo {
  id: string;
  name: string;
  status: 'running' | 'complete' | 'error';
}

// ── Config ─────────────────────────────────────────────────────

/** Platform-specific message length limits */
export const PLATFORM_LIMITS: Record<string, number> = {
  telegram: 4096,
  discord: 2000,
  slack: 40000,
  feishu: 30000,
  qq: 2000,
  weixin: 4000,
};
