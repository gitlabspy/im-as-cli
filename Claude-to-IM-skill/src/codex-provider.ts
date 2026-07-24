/**
 * Codex Provider — LLMProvider implementation backed by @openai/codex-sdk.
 *
 * Maps Codex SDK thread events to the SSE stream format consumed by
 * the bridge conversation engine, making Codex a drop-in alternative
 * to the Claude Code SDK backend.
 *
 * Requires `@openai/codex-sdk` to be installed (optionalDependency).
 * The provider lazily imports the SDK at first use and throws a clear
 * error if it is not available.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LLMProvider, StreamChatParams } from 'remote-agent-control-core/src/lib/bridge/host.js';
import type { PendingPermissions } from './permission-gateway.js';
import { sseEvent } from './sse-utils.js';

/** MIME → file extension for temp image files. */
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// All SDK types kept as `any` because @openai/codex-sdk is optional.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexInstance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ThreadInstance = any;

/**
 * Map bridge permission modes to Codex approval policies.
 * - 'acceptEdits' (code mode) → 'on-failure' (auto-approve most things)
 * - 'plan' → 'on-request' (ask before executing)
 * - 'default' (ask mode) → 'on-request'
 */
function toApprovalPolicy(permissionMode?: string): string {
  switch (permissionMode) {
    case 'acceptEdits': return 'on-failure';
    case 'plan': return 'on-request';
    case 'default': return 'on-request';
    default: return 'on-request';
  }
}

/** Whether to forward bridge model to Codex CLI. Default: false (use Codex current/default model). */
function shouldPassModelToCodex(): boolean {
  return process.env.CTI_CODEX_PASS_MODEL === 'true';
}

/**
 * Allow Codex to run outside a trusted Git repository.
 * Defaults to true because the bridge often invokes Codex against arbitrary
 * working directories that are not git repos (e.g. ~/.claude-to-im or the
 * user's home directory). Set CTI_CODEX_SKIP_GIT_REPO_CHECK=false to opt out.
 */
function shouldSkipGitRepoCheck(): boolean {
  const raw = (process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK || '').toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return true;
}

function shouldRetryFreshThread(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('resuming session with different model') ||
    lower.includes('no such session') ||
    (lower.includes('resume') && lower.includes('session'))
  );
}

function toCodexReasoningEffort(effort?: string): 'low' | 'medium' | 'high' | undefined {
  return effort === 'low' || effort === 'medium' || effort === 'high'
    ? effort
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function eventErrorMessage(event: Record<string, unknown>, fallback: string): string {
  if (typeof event.message === 'string' && event.message) return event.message;
  const error = event.error;
  if (isRecord(error) && typeof error.message === 'string' && error.message) return error.message;
  return fallback;
}

export class CodexProvider implements LLMProvider {
  private sdk: CodexModule | null = null;
  private codex: CodexInstance | null = null;

  /** Maps session IDs to Codex thread IDs for resume. */
  private threadIds = new Map<string, string>();

  constructor(private pendingPerms: PendingPermissions) {}

  /**
   * Lazily load the Codex SDK. Throws a clear error if not installed.
   */
  private async ensureSDK(): Promise<{ sdk: CodexModule; codex: CodexInstance }> {
    if (this.sdk && this.codex) {
      return { sdk: this.sdk, codex: this.codex };
    }

    try {
      this.sdk = await (Function('return import("@openai/codex-sdk")')() as Promise<CodexModule>);
    } catch {
      throw new Error(
        '[CodexProvider] @openai/codex-sdk is not installed. ' +
        'Install it with: npm install @openai/codex-sdk'
      );
    }

    // Resolve API key: CTI_CODEX_API_KEY > CODEX_API_KEY > OPENAI_API_KEY > (login auth)
    const apiKey = process.env.CTI_CODEX_API_KEY
      || process.env.CODEX_API_KEY
      || process.env.OPENAI_API_KEY
      || undefined;
    const baseUrl = process.env.CTI_CODEX_BASE_URL || undefined;

    const CodexClass = this.sdk.Codex;
    this.codex = new CodexClass({
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    });

    return { sdk: this.sdk, codex: this.codex };
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;

    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          const tempFiles: string[] = [];
          try {
            const { codex } = await self.ensureSDK();

            // Resolve or create thread
            const inMemoryThreadId = params.ephemeral ? undefined : self.threadIds.get(params.sessionId);
            let savedThreadId = params.ephemeral ? undefined : (inMemoryThreadId || params.sdkSessionId || undefined);

            const approvalPolicy = toApprovalPolicy(params.permissionMode);
            const passModel = shouldPassModelToCodex();

            // Map bridge sandbox level → Codex SDK sandbox mode.
            // Independent of approvalPolicy (which only controls *whether* to ask).
            const sandboxLevel = params.sandboxLevel ?? 'rw';
            const codexSandbox =
              sandboxLevel === 'ro' ? 'read-only' :
              sandboxLevel === 'full' ? 'danger-full-access' :
              'workspace-write';

            const threadOptions: Record<string, unknown> = {
              ...(passModel && params.model ? { model: params.model } : {}),
              ...(toCodexReasoningEffort(params.effort) ? { modelReasoningEffort: toCodexReasoningEffort(params.effort) } : {}),
              ...(params.workingDirectory ? { workingDirectory: params.workingDirectory } : {}),
              ...(shouldSkipGitRepoCheck() ? { skipGitRepoCheck: true } : {}),
              sandboxMode: codexSandbox,
              approvalPolicy,
            };
            // The current Codex SDK ThreadOptions expose modelReasoningEffort,
            // but no no-session-persistence equivalent. Ephemeral calls
            // therefore avoid reuse and provider-side caching only.

            // Build input: Codex SDK UserInput supports { type: "text" } and
            // { type: "local_image", path: string }. We write base64 data to
            // temp files so the SDK can read them as local images.
            const imageFiles = params.files?.filter(
              f => f.type.startsWith('image/')
            ) ?? [];

            let input: string | Array<Record<string, string>>;
            if (imageFiles.length > 0) {
              const parts: Array<Record<string, string>> = [
                { type: 'text', text: params.prompt },
              ];
              for (const file of imageFiles) {
                const ext = MIME_EXT[file.type] || '.png';
                const tmpPath = path.join(os.tmpdir(), `cti-img-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
                fs.writeFileSync(tmpPath, Buffer.from(file.data, 'base64'));
                tempFiles.push(tmpPath);
                parts.push({ type: 'local_image', path: tmpPath });
              }
              input = parts;
            } else {
              input = params.prompt;
            }

            let retryFresh = false;

            while (true) {
              let thread: ThreadInstance;
              if (savedThreadId) {
                try {
                  thread = codex.resumeThread(savedThreadId, threadOptions);
                } catch {
                  thread = codex.startThread(threadOptions);
                }
              } else {
                thread = codex.startThread(threadOptions);
              }

              let sawAnyEvent = false;
              try {
                const { events } = await thread.runStreamed(input);
                let emittedText = '';

                for await (const event of events) {
                  sawAnyEvent = true;
                  if (params.abortController?.signal.aborted) {
                    break;
                  }

                  let terminalEvent = false;
                  switch (event.type) {
                    case 'thread.started': {
                      const threadId = event.thread_id as string;
                      if (!params.ephemeral) {
                        self.threadIds.set(params.sessionId, threadId);
                      }

                      controller.enqueue(sseEvent('status', {
                        session_id: threadId,
                      }));
                      break;
                    }

                    case 'item.completed': {
                      const item = event.item as Record<string, unknown>;
                      emittedText += self.handleCompletedItem(controller, item) ?? '';
                      break;
                    }

                    case 'turn.completed': {
                      const usage = event.usage as Record<string, unknown> | undefined;
                      const threadId = params.ephemeral ? undefined : self.threadIds.get(params.sessionId);

                      controller.enqueue(sseEvent('result', {
                        usage: usage ? {
                          input_tokens: usage.input_tokens ?? 0,
                          output_tokens: usage.output_tokens ?? 0,
                          cache_read_input_tokens: usage.cached_input_tokens ?? 0,
                        } : undefined,
                          ...(threadId ? { session_id: threadId } : {}),
                        }));
                      terminalEvent = true;
                      break;
                    }

                    case 'session_meta': {
                      const payload = isRecord(event.payload) ? event.payload : null;
                      const threadId = typeof payload?.id === 'string' ? payload.id : undefined;
                      if (threadId) {
                        if (!params.ephemeral) {
                          self.threadIds.set(params.sessionId, threadId);
                        }
                        controller.enqueue(sseEvent('status', {
                          session_id: threadId,
                        }));
                      }
                      break;
                    }

                    case 'event_msg': {
                      const payload = isRecord(event.payload) ? event.payload : null;
                      if (payload?.type === 'task_complete') {
                        const finalText = typeof payload.last_agent_message === 'string'
                          ? payload.last_agent_message
                          : '';
                        if (finalText && !emittedText.endsWith(finalText)) {
                          controller.enqueue(sseEvent('text', finalText));
                          emittedText += finalText;
                        }

                        const threadId = params.ephemeral
                          ? undefined
                          : self.threadIds.get(params.sessionId) || savedThreadId;
                        controller.enqueue(sseEvent('result', {
                          ...(threadId ? { session_id: threadId } : {}),
                        }));
                        terminalEvent = true;
                      }
                      break;
                    }

                    case 'turn.failed': {
                      controller.enqueue(sseEvent('error', eventErrorMessage(event as Record<string, unknown>, 'Turn failed')));
                      terminalEvent = true;
                      break;
                    }

                    case 'error': {
                      controller.enqueue(sseEvent('error', eventErrorMessage(event as Record<string, unknown>, 'Thread error')));
                      terminalEvent = true;
                      break;
                    }

                    // item.started, item.updated, turn.started — no action needed
                  }

                  if (terminalEvent) {
                    break;
                  }
                }
                break;
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (savedThreadId && !retryFresh && !sawAnyEvent && shouldRetryFreshThread(message)) {
                  console.warn('[codex-provider] Resume failed, retrying with a fresh thread:', message);
                  savedThreadId = undefined;
                  retryFresh = true;
                  continue;
                }
                throw err;
              }
            }

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[codex-provider] Error:', err instanceof Error ? err.stack || err.message : err);
            try {
              controller.enqueue(sseEvent('error', message));
              controller.close();
            } catch {
              // Controller already closed
            }
          } finally {
            // Clean up temp image files
            for (const tmp of tempFiles) {
              try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            }
          }
        })();
      },
    });
  }

  /**
   * Map a completed Codex item to SSE events.
   */
  private handleCompletedItem(
    controller: ReadableStreamDefaultController<string>,
    item: Record<string, unknown>,
  ): string | undefined {
    const itemType = item.type as string;

    switch (itemType) {
      case 'agent_message': {
        const text = (item.text as string) || '';
        if (text) {
          controller.enqueue(sseEvent('text', text));
          return text;
        }
        break;
      }

      case 'command_execution': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const command = item.command as string || '';
        const output = item.aggregated_output as string || '';
        const exitCode = item.exit_code as number | undefined;
        const isError = exitCode != null && exitCode !== 0;

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: 'Bash',
          input: { command },
        }));

        const resultContent = output || (isError ? `Exit code: ${exitCode}` : 'Done');
        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: resultContent,
          is_error: isError,
        }));
        break;
      }

      case 'file_change': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const changes = item.changes as Array<{ path: string; kind: string }> || [];
        const summary = changes.map(c => `${c.kind}: ${c.path}`).join('\n');

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: 'Edit',
          input: { files: changes },
        }));

        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: summary || 'File changes applied',
          is_error: false,
        }));
        break;
      }

      case 'mcp_tool_call': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const server = item.server as string || '';
        const tool = item.tool as string || '';
        const args = item.arguments as unknown;
        const result = item.result as { content?: unknown; structured_content?: unknown } | undefined;
        const error = item.error as { message?: string } | undefined;

        const resultContent = result?.content ?? result?.structured_content;
        const resultText = typeof resultContent === 'string' ? resultContent : (resultContent ? JSON.stringify(resultContent) : undefined);

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: `mcp__${server}__${tool}`,
          input: args,
        }));

        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: error?.message || resultText || 'Done',
          is_error: !!error,
        }));
        break;
      }

      case 'reasoning': {
        // Reasoning is internal; emit as status
        const text = (item.text as string) || '';
        if (text) {
          controller.enqueue(sseEvent('status', { reasoning: text }));
        }
        break;
      }
    }
    return undefined;
  }
}
