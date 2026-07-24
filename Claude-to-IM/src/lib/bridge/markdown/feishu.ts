import type { ToolCallInfo } from '../types.js';
import type { TokenUsage } from '../host.js';

/**
 * Feishu-specific Markdown processing.
 *
 * Rendering strategy (aligned with Openclaw):
 * - Code blocks / tables → interactive card (schema 2.0 markdown)
 * - Other text → post (msg_type: 'post') with md tag
 *
 * Schema 2.0 cards render code blocks, tables, bold, italic, links properly.
 * Post messages with md tag render bold, italic, inline code, links.
 */

/**
 * Detect complex markdown (code blocks / tables).
 * Used by send() to decide between card and post rendering.
 */
export function hasComplexMarkdown(text: string): boolean {
  // Fenced code blocks
  if (/```[\s\S]*?```/.test(text)) return true;
  // Tables: header row followed by separator row with pipes and dashes
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) return true;
  return false;
}

/**
 * Preprocess markdown for Feishu rendering.
 * Only ensures code fences have a newline before them.
 * Does NOT touch the text after ``` to preserve language tags like ```python.
 */
export function preprocessFeishuMarkdown(text: string): string {
  // Ensure ``` has newline before it (unless at start of text)
  return text.replace(/([^\n])```/g, '$1\n```');
}

/**
 * Build Feishu interactive card content (schema 2.0 markdown).
 * Renders code blocks, tables, bold, italic, links, inline code properly.
 * Aligned with Openclaw's buildMarkdownCard().
 */
export function buildCardContent(text: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: text,
        },
      ],
    },
  });
}

export interface FeishuTabsChoiceItem {
  index: number;
  active: boolean;
  sessionId: string;
  workingDirectory: string;
  backend: string;
  status: string;
  lastUserQuestion?: string;
  lastAgentOutput?: string;
  callbackData: string;
}

export function buildTabsChoiceCard(tabs: FeishuTabsChoiceItem[]): string {
  const lines = tabs.map((tab) => {
    return [
      `**${tab.index}. \`${tab.sessionId}\`**`,
      `backend: ${tab.backend}`,
      `cwd: ${tab.workingDirectory || '~'}`,
      `status: ${tab.status}`,
      tab.lastUserQuestion ? `user: ${tab.lastUserQuestion}` : '',
      tab.lastAgentOutput ? `agent: ${tab.lastAgentOutput}` : '',
    ].filter(Boolean).join('\n');
  });

  const buttonRows = [];
  for (let startIndex = 0; startIndex < tabs.length; startIndex += 3) {
    const rowTabs = tabs.slice(startIndex, startIndex + 3);
    buttonRows.push({
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_align: 'left',
      columns: rowTabs.map((tab) => ({
        tag: 'column',
        width: 'auto',
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: tab.active ? `${tab.index} Current` : `${tab.index} Switch` },
          type: tab.active ? 'default' : 'primary',
          size: 'small',
          value: { callback_data: tab.callbackData },
        }],
      })),
    });
  }

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Tabs' },
      template: 'blue',
      padding: '12px 12px 12px 12px',
    },
    body: {
      elements: [
        { tag: 'markdown', content: lines.join('\n\n'), text_size: 'normal' },
        { tag: 'hr' },
        ...buttonRows,
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: 'Or reply: `/tab <n>` to switch, `/pop` to show buffered output.',
          text_size: 'notation',
        },
      ],
    },
  });
}

export interface FeishuSearchResultCardInput {
  query: string;
  codepilotSessionId: string;
  workingDirectory: string;
  backend: string;
  status: string;
  isCurrentSession?: boolean;
  reason: string;
  lastUserQuestion?: string;
  lastAgentOutput?: string;
  confirmCallbackData: string;
  retryCallbackData: string;
}

export function buildSearchResultCard(result: FeishuSearchResultCardInput): string {
  const content = [
    `Query: \`${result.query}\``,
    '',
    `**Match:** \`${result.codepilotSessionId}\``,
    result.isCurrentSession ? 'Note: This is the current session.' : '',
    `Backend: ${result.backend}`,
    `Status: ${result.status}`,
    `CWD: ${result.workingDirectory || '~'}`,
    '',
    `Reason: ${result.reason}`,
    result.lastUserQuestion ? `Last user question: ${result.lastUserQuestion}` : '',
    result.lastAgentOutput ? `Last agent output: ${result.lastAgentOutput}` : '',
  ].filter(Boolean).join('\n');

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Search Result' },
      template: 'blue',
      padding: '12px 12px 12px 12px',
    },
    body: {
      elements: [
        { tag: 'markdown', content, text_size: 'normal' },
        { tag: 'hr' },
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_align: 'left',
          columns: [
            {
              tag: 'column',
              width: 'auto',
              elements: [{
                tag: 'button',
                text: { tag: 'plain_text', content: '确认' },
                type: 'primary',
                size: 'medium',
                value: { callback_data: result.confirmCallbackData },
              }],
            },
            {
              tag: 'column',
              width: 'auto',
              elements: [{
                tag: 'button',
                text: { tag: 'plain_text', content: '重新搜索' },
                type: 'default',
                size: 'medium',
                value: { callback_data: result.retryCallbackData },
              }],
            },
          ],
        },
      ],
    },
  });
}

export type FeishuPeekRisk = 'running' | 'idle' | 'waiting' | 'error' | 'normal';

export interface FeishuPeekCardInput {
  status: string;
  risk: FeishuPeekRisk;
  backend: string;
  workingDirectory: string;
  bridgeSessionId: string;
  nativeSessionId?: string;
  model?: string;
  lastActivity?: string;
  elapsed?: string;
  recentAction?: string;
  summary: string;
  summarySource: 'model' | 'local';
  truncated?: boolean;
}

const PEEK_RISK_TEMPLATE: Record<FeishuPeekRisk, string> = {
  running: 'blue',
  idle: 'grey',
  waiting: 'orange',
  error: 'red',
  normal: 'green',
};

const PEEK_RISK_LABEL: Record<FeishuPeekRisk, string> = {
  running: '🔄 运行中',
  idle: '💤 空闲',
  waiting: '⏳ 等待授权',
  error: '❌ 出错',
  normal: '✅ 正常',
};

/**
 * Build a Feishu interactive card (schema 2.0) summarizing the current
 * session for `/peek`. Read-only: no action buttons in v1.
 */
export function buildPeekCard(input: FeishuPeekCardInput): string {
  const fields = [
    `**状态：** ${input.status}`,
    `**风险：** ${PEEK_RISK_LABEL[input.risk]}`,
    `**后端：** ${input.backend}`,
    `**工作目录：** \`${input.workingDirectory || '~'}\``,
    input.lastActivity ? `**最近活动：** ${input.lastActivity}` : '',
    input.elapsed ? `**距上次活动：** ${input.elapsed}` : '',
    `**Bridge 会话：** \`${input.bridgeSessionId}\``,
    `**Native 会话：** \`${input.nativeSessionId || '无（全新）'}\``,
    input.model ? `**模型：** \`${input.model}\`` : '',
    input.recentAction ? `**最近动作：** ${input.recentAction}` : '',
  ].filter(Boolean).join('\n');

  const summaryHeading = input.summarySource === 'model' ? '**摘要**' : '**摘要（本地兜底）**';
  const summaryBody = input.summary || '_暂无可总结的近期活动。_';
  const notes: string[] = [];
  if (input.truncated) notes.push('已截断为最近的活动。');

  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: fields, text_size: 'normal' },
    { tag: 'hr' },
    { tag: 'markdown', content: `${summaryHeading}\n${summaryBody}`, text_size: 'normal' },
  ];
  if (notes.length > 0) {
    elements.push({ tag: 'markdown', content: notes.join('\n'), text_size: 'notation' });
  }

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '会话快照' },
      template: PEEK_RISK_TEMPLATE[input.risk],
      padding: '12px 12px 12px 12px',
    },
    body: { elements },
  });
}

/**
 * Build Feishu post message content (msg_type: 'post') with md tag.
 * Used for simple text without code blocks or tables.
 * Aligned with Openclaw's buildFeishuPostMessagePayload().
 */
export function buildPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text }]],
    },
  });
}

/**
 * Convert simple HTML (from command responses) to markdown for Feishu.
 * Handles common tags: <b>, <i>, <code>, <br>, entities.
 */
export function htmlToFeishuMarkdown(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Build tool progress markdown lines.
 * Each tool shows an icon based on status: 🔄 Running, ✅ Complete, ❌ Error.
 */
export function buildToolProgressMarkdown(tools: ToolCallInfo[]): string {
  if (tools.length === 0) return '';
  const lines = tools.map((tc) => {
    const icon = tc.status === 'running' ? '🔄' : tc.status === 'complete' ? '✅' : '❌';
    return `${icon} \`${tc.name}\``;
  });
  return lines.join('\n');
}

/**
 * Format elapsed time for card footer.
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.floor(sec % 60);
  return `${min}m ${remSec}s`;
}

/**
 * Compact a token count: 1234 → "1.2k", 999 → "999", 1_200_000 → "1.2M".
 */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}

/**
 * Build the "Tokens: …" footer line from a TokenUsage record.
 * Cached is the sum of cache read + cache creation; omitted when zero.
 * Returns '' when there is no usable usage data.
 */
export function formatTokenUsageLine(usage: TokenUsage): string {
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cached = (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  if (input === 0 && output === 0 && cached === 0) return '';
  const parts = [`${formatTokens(input)} in`, `${formatTokens(output)} out`];
  if (cached > 0) parts.push(`${formatTokens(cached)} cached`);
  return `Tokens: ${parts.join(' · ')}`;
}

/**
 * Build the final-reply footer as plain markdown text for fallback paths
 * where the footer is appended to the delivered message.
 *
 * Produces lines like:
 *   ---
 *   ✅ 最后答复
 *   Tokens: 1.2k in · 856 out · 4.1k cached
 *   Model: gpt-5-codex
 *
 * `isContinuation` switches the marker to "最后答复（续）".
 * Returns '' when there is nothing meaningful to show.
 */
export function buildFinalReplyFooterText(
  tokenUsage: TokenUsage | null | undefined,
  model: string | null | undefined,
  isContinuation = false,
): string {
  const lines: string[] = [isContinuation ? '✅ 最后答复（续）' : '✅ 最后答复'];
  if (tokenUsage) {
    const tokenLine = formatTokenUsageLine(tokenUsage);
    if (tokenLine) lines.push(tokenLine);
  }
  if (model) lines.push(`Model: ${model}`);
  return `\n\n---\n${lines.join('\n')}`;
}

/**
 * Map a final-card status label to a card 2.0 header `template` color band.
 * Falls back to "blue" for the normal completed case.
 */
function status2Template(status: string | undefined): string {
  if (!status) return 'blue';
  if (status.includes('❌')) return 'red';
  if (status.includes('⚠️')) return 'orange';
  return 'blue';
}

/**
 * Build the final card JSON (schema 2.0) with text, tool progress, and footer.
 */
export function buildFinalCardJson(
  text: string,
  tools: ToolCallInfo[],
  footer:
    | {
        status: string;
        elapsed: string;
        tokenUsage?: TokenUsage | null;
        model?: string | null;
        /** Optional reasoning effort — plumbed for later; currently never filled. */
        effort?: string | null;
        /** Whether this is the final reply (drives the "最后答复" marker). */
        isFinal?: boolean;
        /** Whether this card is a continuation overflow of the final reply. */
        isContinuation?: boolean;
      }
    | null,
): string {
  const elements: Array<Record<string, unknown>> = [];

  // Main text content
  let content = preprocessFeishuMarkdown(text);
  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) {
    content = content ? `${content}\n\n${toolMd}` : toolMd;
  }

  if (content) {
    elements.push({
      tag: 'markdown',
      content,
      text_align: 'left',
      text_size: 'normal',
    });
  }

  // Footer: status · elapsed / token / model go into a separate markdown
  // element. Feishu Card JSON 2.0 rejects the old `note` element.
  let header: Record<string, unknown> | undefined;
  if (footer) {
    // Header title carries the final-reply marker. Kept as a code-level
    // hardcoded value — never prompt-injected by the model.
    if (footer.isFinal) {
      header = {
        title: {
          tag: 'plain_text',
          content: footer.isContinuation ? '✅ 最后答复（续）' : '✅ 最后答复',
        },
        template: status2Template(footer.status),
      };
    }

    const noteLines: string[] = [];

    // status · elapsed
    const line1: string[] = [];
    if (footer.status) line1.push(footer.status);
    if (footer.elapsed) line1.push(footer.elapsed);
    if (line1.length > 0) noteLines.push(line1.join(' · '));

    // token usage
    if (footer.tokenUsage) {
      const tokenLine = formatTokenUsageLine(footer.tokenUsage);
      if (tokenLine) noteLines.push(tokenLine);
    }

    // model (· effort, when available)
    if (footer.model) {
      let modelLine = `Model: ${footer.model}`;
      if (footer.effort) modelLine += ` · Effort: ${footer.effort}`;
      noteLines.push(modelLine);
    }

    if (noteLines.length > 0) {
      elements.push({
        tag: 'markdown',
        content: noteLines.join('  ·  '),
        text_align: 'left',
        text_size: 'normal',
      });
    }
  }

  const card: Record<string, unknown> = {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: { elements },
  };
  if (header) card.header = header;

  return JSON.stringify(card);
}

/**
 * Build a permission card with real action buttons (column_set layout).
 * Structure aligned with Feishu card outbound constraints.
 * Returns the card JSON string for msg_type: 'interactive'.
 */
export function buildPermissionButtonCard(
  text: string,
  permissionRequestId: string,
  chatId?: string,
): string {
  const buttons = [
    { label: 'Allow', type: 'primary', action: 'allow' },
    { label: 'Allow Session', type: 'default', action: 'allow_session' },
    { label: 'Deny', type: 'danger', action: 'deny' },
  ];

  const buttonColumns = buttons.map((btn) => ({
    tag: 'column',
    width: 'auto',
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: btn.label },
      type: btn.type,
      size: 'medium',
      value: { callback_data: `perm:${btn.action}:${permissionRequestId}`, ...(chatId ? { chatId } : {}) },
    }],
  }));

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Permission Required' },
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'lock-chat_filled' },
      padding: '12px 12px 12px 12px',
    },
    body: {
      elements: [
        { tag: 'markdown', content: text, text_size: 'normal' },
        { tag: 'markdown', content: '⏱ This request will expire in 5 minutes', text_size: 'notation' },
        { tag: 'hr' },
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_align: 'left',
          columns: buttonColumns,
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: 'Or reply: `1` Allow · `2` Allow Session · `3` Deny',
          text_size: 'notation',
        },
      ],
    },
  });
}

export interface FeishuQuestionChoice {
  index: number;
  label: string;
  description?: string;
}

/**
 * Build an AskUserQuestion card: the question in the body, one button per
 * option, plus an "其他（自定义回复）" button for free-form input to the agent.
 * Option callbacks: `perm:choice:<index>:<permId>`; the custom button uses
 * `perm:choice_other:<permId>`.
 */
export function buildQuestionCard(
  questionText: string,
  choices: FeishuQuestionChoice[],
  permissionRequestId: string,
  chatId?: string,
): string {
  const optionLines = choices
    .map((choice) => {
      const desc = choice.description ? ` — ${choice.description}` : '';
      return `**${choice.index}.** ${choice.label}${desc}`;
    })
    .join('\n');

  const optionButtons = choices.map((choice) => ({
    tag: 'column',
    width: 'auto',
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: `${choice.index}. ${choice.label}` },
      type: 'primary',
      size: 'medium',
      value: { callback_data: `perm:choice:${choice.index}:${permissionRequestId}`, ...(chatId ? { chatId } : {}) },
    }],
  }));

  // Chunk option buttons into rows of up to 3 columns.
  const buttonRows: Array<Record<string, unknown>> = [];
  for (let start = 0; start < optionButtons.length; start += 3) {
    buttonRows.push({
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_align: 'left',
      columns: optionButtons.slice(start, start + 3),
    });
  }

  const otherButtonRow = {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_align: 'left',
    columns: [{
      tag: 'column',
      width: 'auto',
      elements: [{
        tag: 'button',
        text: { tag: 'plain_text', content: '其他（自定义回复）' },
        type: 'default',
        size: 'medium',
        value: { callback_data: `perm:choice_other:${permissionRequestId}`, ...(chatId ? { chatId } : {}) },
      }],
    }],
  };

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '需要你的选择' },
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'chat-question_filled' },
      padding: '12px 12px 12px 12px',
    },
    body: {
      elements: [
        { tag: 'markdown', content: questionText, text_size: 'normal' },
        { tag: 'hr' },
        { tag: 'markdown', content: optionLines, text_size: 'normal' },
        ...buttonRows,
        otherButtonRow,
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: '点击按钮，或直接回复编号（如 `1`）；选择「其他」后发送自定义内容给 agent。5 分钟后过期。',
          text_size: 'notation',
        },
      ],
    },
  });
}
