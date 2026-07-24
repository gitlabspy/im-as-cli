/**
 * Permission Broker — forwards Claude permission requests to IM channels
 * and handles user responses via inline buttons.
 *
 * When Claude needs tool approval, the broker:
 * 1. Formats a permission prompt with inline keyboard buttons
 * 2. Sends it via the delivery layer
 * 3. Records the link between permission ID and IM message
 * 4. When a callback arrives, resolves the permission via the gateway
 */

import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { ChannelAddress, OutboundMessage } from './types.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import type { PermissionChoice } from './conversation-engine.js';
import { deliver } from './delivery-layer.js';
import { getBridgeContext } from './context.js';
import { escapeHtml } from './adapters/telegram-utils.js';
import { formatToolInput } from './markdown/tool-input.js';
import { buildQuestionCard } from './markdown/feishu.js';

/**
 * Dedup recent permission forwards to prevent duplicate cards.
 * Key: permissionRequestId, value: timestamp. Entries expire after 30s.
 */
const recentPermissionForwards = new Map<string, number>();

export interface ForwardQuestionOptions {
  kind: 'question';
  questionText: string;
  choices: PermissionChoice[];
}

/**
 * Forward a permission request to an IM channel as an interactive message.
 */
export async function forwardPermissionRequest(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  permissionRequestId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId?: string,
  suggestions?: unknown[],
  replyToMessageId?: string,
  question?: ForwardQuestionOptions,
): Promise<void> {
  const { store } = getBridgeContext();

  // Dedup: prevent duplicate forwarding of the same permission request
  const now = Date.now();
  if (recentPermissionForwards.has(permissionRequestId)) {
    console.warn(`[permission-broker] Duplicate forward suppressed for ${permissionRequestId}`);
    return;
  }
  recentPermissionForwards.set(permissionRequestId, now);
  // Clean up old entries
  for (const [id, ts] of recentPermissionForwards) {
    if (now - ts > 30_000) recentPermissionForwards.delete(id);
  }

  // ── AskUserQuestion (single-select) → option-button card ──
  if (question && question.choices.length > 0) {
    await forwardQuestionRequest(
      adapter,
      address,
      permissionRequestId,
      question,
      sessionId,
      replyToMessageId,
    );
    return;
  }

  console.log(`[permission-broker] Forwarding permission request: ${permissionRequestId} tool=${toolName} channel=${adapter.channelType}`);

  // Format the input summary — show only the key info (command, path, etc.)
  // instead of dumping raw JSON. Unknown tools fall back to truncated JSON.
  const inputSummary = formatToolInput(toolName, toolInput);

  let result: import('./types.js').SendResult;

  if (adapter.channelType === 'qq' || adapter.channelType === 'weixin') {
    const channelLabel = adapter.channelType === 'weixin' ? 'WeChat' : 'QQ';
    // QQ / WeChat: plain text permission prompt with copyable /perm commands (no inline buttons)
    const plainText = [
      `Permission Required`,
      ``,
      `Tool: ${toolName}`,
      inputSummary,
      ``,
      `Reply:`,
      `1 - Allow once`,
      `2 - Allow session`,
      `3 - Deny`,
      ``,
      `Or use full command:`,
      `/perm allow ${permissionRequestId}`,
      `/perm allow_session ${permissionRequestId}`,
      `/perm deny ${permissionRequestId}`,
    ].join('\n');

    const plainMessage: OutboundMessage = {
      address,
      text: plainText,
      parseMode: 'plain',
      replyToMessageId,
    };

    result = await deliver(adapter, plainMessage, { sessionId });
    console.log(
      `[permission-broker] Sent plain-text permission prompt for ${channelLabel}: ${permissionRequestId}`,
    );
  } else {
    const text = [
      `<b>Permission Required</b>`,
      ``,
      `Tool: <code>${escapeHtml(toolName)}</code>`,
      `<pre>${escapeHtml(inputSummary)}</pre>`,
      ``,
      `Choose an action:`,
    ].join('\n');

    const message: OutboundMessage = {
      address,
      text,
      parseMode: 'HTML',
      inlineButtons: [
        [
          { text: 'Allow', callbackData: `perm:allow:${permissionRequestId}` },
          { text: 'Allow Session', callbackData: `perm:allow_session:${permissionRequestId}` },
          { text: 'Deny', callbackData: `perm:deny:${permissionRequestId}` },
        ],
      ],
      replyToMessageId,
    };

    result = await deliver(adapter, message, { sessionId });
  }

  // Record the link so we can match callback queries back to this permission
  if (result.ok && result.messageId) {
    try {
      store.insertPermissionLink({
        permissionRequestId,
        channelType: adapter.channelType,
        chatId: address.chatId,
        messageId: result.messageId,
        toolName,
        suggestions: suggestions ? JSON.stringify(suggestions) : '',
      });
    } catch { /* best effort */ }
  }
}

/**
 * Render an AskUserQuestion as an option-button card (button channels) or a
 * numbered text prompt (text channels). The question kind + choices are stored
 * on the permission link so callbacks/numeric replies can translate the chosen
 * index back into the option label.
 */
async function forwardQuestionRequest(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  permissionRequestId: string,
  question: ForwardQuestionOptions,
  sessionId?: string,
  replyToMessageId?: string,
): Promise<void> {
  const { store } = getBridgeContext();
  const choicesJson = JSON.stringify(question.choices);
  let result: import('./types.js').SendResult;

  if (adapter.channelType === 'feishu' && adapter.sendInteractiveCard) {
    const cardJson = buildQuestionCard(
      question.questionText,
      question.choices,
      permissionRequestId,
      address.chatId,
    );
    result = await adapter.sendInteractiveCard(address, cardJson, replyToMessageId);
  } else if (adapter.channelType === 'qq' || adapter.channelType === 'weixin') {
    const lines = [
      question.questionText,
      '',
      ...question.choices.map((choice) => `${choice.index} - ${choice.label}${choice.description ? `（${choice.description}）` : ''}`),
      '',
      '回复编号选择，或直接发送自定义内容给 agent。',
    ];
    result = await deliver(adapter, {
      address,
      text: lines.join('\n'),
      parseMode: 'plain',
      replyToMessageId,
    }, { sessionId });
  } else {
    // Telegram / Discord / others: HTML text + inline option buttons.
    const text = [
      `<b>需要你的选择</b>`,
      ``,
      escapeHtml(question.questionText),
      ``,
      ...question.choices.map((choice) =>
        `${choice.index}. ${escapeHtml(choice.label)}${choice.description ? ` — ${escapeHtml(choice.description)}` : ''}`),
    ].join('\n');
    const optionButtons = question.choices.map((choice) => ({
      text: `${choice.index}. ${choice.label}`,
      callbackData: `perm:choice:${choice.index}:${permissionRequestId}`,
    }));
    // Chunk into rows of up to 3, plus the custom-reply button on its own row.
    const rows: Array<Array<{ text: string; callbackData: string }>> = [];
    for (let start = 0; start < optionButtons.length; start += 3) {
      rows.push(optionButtons.slice(start, start + 3));
    }
    rows.push([{ text: '其他（自定义回复）', callbackData: `perm:choice_other:${permissionRequestId}` }]);
    result = await deliver(adapter, {
      address,
      text,
      parseMode: 'HTML',
      inlineButtons: rows,
      replyToMessageId,
    }, { sessionId });
  }

  if (result.ok && result.messageId) {
    try {
      store.insertPermissionLink({
        permissionRequestId,
        channelType: adapter.channelType,
        chatId: address.chatId,
        messageId: result.messageId,
        toolName: 'AskUserQuestion',
        suggestions: '',
        kind: 'question',
        choices: choicesJson,
      });
    } catch { /* best effort */ }
  }
}

/**
 * Handle a permission callback from an inline button press.
 * Validates that the callback came from the same chat AND same message that
 * received the permission request, prevents duplicate resolution via atomic
 * DB check-and-set, and implements real allow_session semantics by passing
 * updatedPermissions (suggestions).
 *
 * Returns true if the callback was recognized and handled.
 */
export async function handlePermissionCallback(
  callbackData: string,
  callbackChatId: string,
  callbackMessageId?: string,
): Promise<boolean> {
  const { store, permissions } = getBridgeContext();

  // Parse callback data: perm:action:permId
  // Special form for question options: perm:choice:<index>:permId
  const parts = callbackData.split(':');
  if (parts.length < 3 || parts[0] !== 'perm') return false;

  const action = parts[1];
  let choiceIndex: number | null = null;
  let permissionRequestId: string;
  if (action === 'choice') {
    if (parts.length < 4) return false;
    choiceIndex = Number.parseInt(parts[2], 10);
    if (!Number.isInteger(choiceIndex)) return false;
    permissionRequestId = parts.slice(3).join(':');
  } else {
    permissionRequestId = parts.slice(2).join(':'); // permId might contain colons
  }

  // Look up the permission link to validate origin and check dedup
  const link = store.getPermissionLink(permissionRequestId);
  if (!link) {
    console.warn(`[permission-broker] No permission link found for ${permissionRequestId}`);
    return false;
  }

  // Security: verify the callback came from the same chat that received the request
  if (link.chatId !== callbackChatId) {
    console.warn(`[permission-broker] Chat ID mismatch: expected ${link.chatId}, got ${callbackChatId}`);
    return false;
  }

  // Security: verify the callback came from the original permission message
  if (callbackMessageId && link.messageId !== callbackMessageId) {
    console.warn(`[permission-broker] Message ID mismatch: expected ${link.messageId}, got ${callbackMessageId}`);
    return false;
  }

  // 'choice_other' is acknowledged but does NOT resolve the question: the user
  // will follow up with free-form text that the bridge feeds back to the agent.
  // Leaving the link unresolved keeps the pending permission alive for that text.
  if (action === 'choice_other') {
    return link.resolved ? false : true;
  }

  // Validate the choice index BEFORE claiming the link, so an out-of-range
  // selection leaves the question open for the user to retry.
  let choiceLabel: string | null = null;
  if (action === 'choice') {
    choiceLabel = lookupChoiceLabel(link.choices, choiceIndex);
    if (!choiceLabel) {
      console.warn(`[permission-broker] Choice index ${choiceIndex} out of range for ${permissionRequestId}`);
      return false;
    }
  }

  // Dedup: reject if already resolved (fast path before expensive resolution)
  if (link.resolved) {
    console.warn(`[permission-broker] Permission ${permissionRequestId} already resolved`);
    return false;
  }

  // Atomically mark as resolved BEFORE calling resolvePendingPermission
  // to prevent race conditions with concurrent button clicks
  let claimed: boolean;
  try {
    claimed = store.markPermissionLinkResolved(permissionRequestId);
  } catch {
    return false;
  }

  if (!claimed) {
    // Another concurrent handler already resolved this permission
    console.warn(`[permission-broker] Permission ${permissionRequestId} already claimed by concurrent handler`);
    return false;
  }

  let resolved: boolean;

  switch (action) {
    case 'allow':
      resolved = await permissions.resolvePendingPermission(permissionRequestId, {
        behavior: 'allow',
      });
      break;

    case 'allow_session': {
      // Parse stored suggestions so subsequent same-tool calls auto-approve
      let updatedPermissions: PermissionUpdate[] | undefined;
      if (link.suggestions) {
        try {
          updatedPermissions = JSON.parse(link.suggestions) as PermissionUpdate[];
        } catch { /* fall through without updatedPermissions */ }
      }

      resolved = await permissions.resolvePendingPermission(permissionRequestId, {
        behavior: 'allow',
        ...(updatedPermissions ? { updatedPermissions } : {}),
      });
      break;
    }

    case 'deny':
      resolved = await permissions.resolvePendingPermission(permissionRequestId, {
        behavior: 'deny',
        message: 'Denied via IM bridge',
      });
      break;

    case 'choice': {
      // AskUserQuestion option selection. The label was validated before the
      // link was claimed; resolve with it as the answer message so the skill's
      // canUseTool feeds it back to the model.
      resolved = await permissions.resolvePendingPermission(permissionRequestId, {
        behavior: 'deny',
        message: `User selected: ${choiceLabel}`,
      });
      break;
    }

    default:
      return false;
  }

  return resolved;
}

/** Resolve a 1-based choice index to its label from serialized choices JSON. */
function lookupChoiceLabel(choicesJson: string | undefined, index: number | null): string | null {
  if (!choicesJson || index == null) return null;
  try {
    const choices = JSON.parse(choicesJson) as Array<{ index: number; label: string }>;
    const match = choices.find((choice) => choice.index === index);
    return match?.label ?? null;
  } catch {
    return null;
  }
}
