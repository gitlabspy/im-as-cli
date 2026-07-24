/**
 * Copilot Provider — LLMProvider backed by the GitHub Copilot CLI.
 *
 * Invokes `copilot -p "<prompt>" --output-format json --no-color --log-level none`
 * as a non-TUI child process and converts the streaming JSONL output to the
 * SSE event format expected by the bridge.
 *
 * Phase 3 — initial implementation. Designed for safety:
 *  - Always non-interactive (no prompts)
 *  - Strict timeout via abortable child process
 *  - Tool execution gated on `CTI_COPILOT_ALLOW_TOOLS=true`
 *  - Errors surface as a final SSE `error` event; partial output preserved
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { LLMProvider, StreamChatParams } from 'remote-agent-control-core/src/lib/bridge/host.js';
import { sseEvent } from './sse-utils.js';

/** Default per-turn timeout in ms. */
const DEFAULT_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.CTI_COPILOT_TIMEOUT_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000;
})();

function resolveCopilotPath(): string {
  return process.env.CTI_COPILOT_EXECUTABLE || 'copilot';
}

function shouldAllowTools(): boolean {
  return (process.env.CTI_COPILOT_ALLOW_TOOLS || '').toLowerCase() === 'true';
}

/**
 * Build the argv list passed to the `copilot` CLI for a given turn.
 * Exposed for unit testing — does not perform IO.
 */
export function buildCopilotArgs(params: {
  prompt: string;
  resumeId?: string;
  sandboxLevel?: 'ro' | 'rw' | 'full';
  workingDirectory?: string;
}): string[] {
  const args: string[] = [
    '-p', params.prompt,
    '--output-format', 'json',
    '--no-color',
    '--log-level', 'none',
  ];
  if (params.resumeId) {
    args.push('--resume', params.resumeId);
  }
  const sandboxLevel = params.sandboxLevel ?? 'rw';
  const allowTools =
    sandboxLevel !== 'ro' && (sandboxLevel === 'full' || shouldAllowTools());
  if (!allowTools) {
    args.push('--no-tools');
  }
  if (params.workingDirectory) {
    args.push('--cwd', params.workingDirectory);
  }
  return args;
}

export class CopilotProvider implements LLMProvider {
  /** Maps bridge sessionId → Copilot CLI session id for resume across turns. */
  private sessionIds = new Map<string, string>();

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;

    return new ReadableStream<string>({
      start(controller) {
        const copilotPath = resolveCopilotPath();
        const resumeId = params.ephemeral
          ? undefined
          : self.sessionIds.get(params.sessionId) || params.sdkSessionId || undefined;

        // GitHub Copilot CLI has no supported effort flag in this provider.
        // params.effort is intentionally a no-op here.

        // Sandbox gating:
        //   'ro'   → always --no-tools (binding overrides env)
        //   'rw'   → env-driven (CTI_COPILOT_ALLOW_TOOLS=true unlocks tools)
        //   'full' → force enable tools (binding overrides env)
        const args = buildCopilotArgs({
          prompt: params.prompt,
          resumeId,
          sandboxLevel: params.sandboxLevel,
          workingDirectory: params.workingDirectory,
        });

        let child: ChildProcess;
        try {
          child = spawn(copilotPath, args, {
            cwd: params.workingDirectory || process.cwd(),
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          try {
            controller.enqueue(sseEvent('error', `Failed to spawn copilot CLI: ${msg}`));
            controller.close();
          } catch { /* already closed */ }
          return;
        }

        let stdoutBuf = '';
        let stderrBuf = '';
        let closed = false;
        let timedOut = false;

        const timeoutMs = DEFAULT_TIMEOUT_MS;
        const timer = setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGTERM'); } catch { /* ignore */ }
          setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 5000).unref();
        }, timeoutMs);
        timer.unref();

        const onAbort = () => {
          try { child.kill('SIGTERM'); } catch { /* ignore */ }
        };
        params.abortController?.signal.addEventListener('abort', onAbort);

        const safeEnqueue = (chunk: string) => {
          if (closed) return;
          try { controller.enqueue(chunk); } catch { closed = true; }
        };

        const handleJsonLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          let obj: Record<string, unknown>;
          try {
            obj = JSON.parse(trimmed);
          } catch {
            // Not JSON — treat as raw text fragment.
            safeEnqueue(sseEvent('text', trimmed));
            return;
          }
          const type = (obj.type as string) || '';
          // Copilot CLI JSON event shape is evolving; we map best-effort.
          switch (type) {
            case 'session': {
              const sid = (obj.session_id as string) || (obj.id as string);
              if (sid && !params.ephemeral) {
                self.sessionIds.set(params.sessionId, sid);
                safeEnqueue(sseEvent('status', { session_id: sid }));
              }
              break;
            }
            case 'text':
            case 'message':
            case 'assistant': {
              const text = (obj.text as string) || (obj.content as string) || '';
              if (text) safeEnqueue(sseEvent('text', text));
              break;
            }
            case 'tool_use': {
              safeEnqueue(sseEvent('tool_use', {
                id: (obj.id as string) || `copilot-tool-${Date.now()}`,
                name: (obj.name as string) || 'copilot_tool',
                input: obj.input ?? obj.arguments ?? {},
              }));
              break;
            }
            case 'tool_result': {
              safeEnqueue(sseEvent('tool_result', {
                tool_use_id: (obj.tool_use_id as string) || (obj.id as string) || '',
                content: (obj.content as string) || (obj.output as string) || '',
                is_error: !!obj.is_error,
              }));
              break;
            }
            case 'result':
            case 'done': {
              safeEnqueue(sseEvent('result', {
                usage: obj.usage,
                ...(obj.session_id ? { session_id: obj.session_id } : {}),
              }));
              break;
            }
            case 'error': {
              const msg = (obj.message as string) || (obj.error as string) || 'Copilot error';
              safeEnqueue(sseEvent('error', msg));
              break;
            }
            default: {
              // Unknown event: surface as status if it has text, else ignore.
              const text = (obj.text as string) || '';
              if (text) safeEnqueue(sseEvent('status', { text }));
              break;
            }
          }
        };

        child.stdout?.on('data', (chunk: Buffer) => {
          stdoutBuf += chunk.toString('utf-8');
          let idx: number;
          while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
            const line = stdoutBuf.slice(0, idx);
            stdoutBuf = stdoutBuf.slice(idx + 1);
            handleJsonLine(line);
          }
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          stderrBuf += chunk.toString('utf-8');
          // Cap to avoid runaway memory.
          if (stderrBuf.length > 64 * 1024) {
            stderrBuf = stderrBuf.slice(-64 * 1024);
          }
        });

        child.on('error', (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          safeEnqueue(sseEvent('error', `Copilot CLI process error: ${msg}`));
        });

        child.on('close', (code) => {
          clearTimeout(timer);
          params.abortController?.signal.removeEventListener('abort', onAbort);
          // Flush any trailing partial line.
          if (stdoutBuf.trim()) {
            handleJsonLine(stdoutBuf);
            stdoutBuf = '';
          }
          if (timedOut) {
            safeEnqueue(sseEvent('error', `Copilot CLI timed out after ${timeoutMs}ms`));
          } else if (code !== 0 && code !== null) {
            const tail = stderrBuf.trim().split('\n').slice(-5).join('\n');
            safeEnqueue(sseEvent('error', `Copilot CLI exited with code ${code}${tail ? `: ${tail}` : ''}`));
          }
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
        });
      },
    });
  }
}
