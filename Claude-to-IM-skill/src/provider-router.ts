/**
 * Provider Router — dispatches StreamChatParams to a per-backend LLMProvider.
 *
 * Backends are lazily initialized on first use so that, e.g., a daemon
 * configured with claudecode never imports `@openai/codex-sdk` until a
 * binding actually switches to Codex via `/backend codex`.
 *
 * Per-backend native SDK session IDs are passed through `params.backendSdkSessionId`
 * so each backend lane can resume independently.
 */

import type { LLMProvider, StreamChatParams } from 'remote-agent-control-core/src/lib/bridge/host.js';
import type { BackendName } from 'remote-agent-control-core/src/lib/bridge/types.js';
import { sseEvent } from './sse-utils.js';
import type { PendingPermissions } from './permission-gateway.js';
import type { Config } from './config.js';

/** Factory that produces a concrete LLMProvider for a backend. May throw. */
export type ProviderFactory = () => Promise<LLMProvider> | LLMProvider;

export interface ProviderRouterOptions {
  factories: Partial<Record<BackendName, ProviderFactory>>;
  /** Backend used when params.backend is missing/undefined. */
  defaultBackend: BackendName;
}

export class ProviderRouter implements LLMProvider {
  private cache = new Map<BackendName, LLMProvider>();
  private factories: Partial<Record<BackendName, ProviderFactory>>;
  private defaultBackend: BackendName;

  constructor(opts: ProviderRouterOptions) {
    this.factories = opts.factories;
    this.defaultBackend = opts.defaultBackend;
  }

  private async getProvider(backend: BackendName): Promise<LLMProvider> {
    const cached = this.cache.get(backend);
    if (cached) return cached;
    const factory = this.factories[backend];
    if (!factory) {
      throw new Error(`[provider-router] No provider configured for backend "${backend}"`);
    }
    const provider = await factory();
    this.cache.set(backend, provider);
    return provider;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const backend: BackendName = params.backend ?? this.defaultBackend;
    // Use per-backend SDK session id when provided; fall back to legacy field.
    const effectiveParams: StreamChatParams = {
      ...params,
      sdkSessionId: params.backendSdkSessionId ?? params.sdkSessionId,
      backend,
    };

    // We must return a ReadableStream synchronously, but getProvider is async
    // (factories may dynamic-import). Wrap with a stream that defers to the
    // concrete provider's stream once resolved.
    return new ReadableStream<string>({
      start: (controller) => {
        (async () => {
          let provider: LLMProvider;
          try {
            provider = await this.getProvider(backend);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            try {
              controller.enqueue(sseEvent('error', msg));
              controller.close();
            } catch { /* already closed */ }
            return;
          }
          let inner: ReadableStream<string>;
          try {
            inner = provider.streamChat(effectiveParams);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            try {
              controller.enqueue(sseEvent('error', msg));
              controller.close();
            } catch { /* already closed */ }
            return;
          }
          const reader = inner.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
            controller.close();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            try {
              controller.enqueue(sseEvent('error', msg));
              controller.close();
            } catch { /* already closed */ }
          } finally {
            try { reader.releaseLock(); } catch { /* ignore */ }
          }
        })();
      },
    });
  }
}

// ── Convenience builder ─────────────────────────────────────────

/**
 * Build a ProviderRouter wired to all three backends (lazy).
 * Factories use dynamic import so optional deps aren't loaded at startup.
 */
export function buildDefaultRouter(opts: {
  config: Config;
  pendingPerms: PendingPermissions;
  /** Optional pre-resolved Claude CLI path; if omitted, the factory resolves on demand. */
  claudeCliPath?: string;
  defaultBackend: BackendName;
}): ProviderRouter {
  const { config, pendingPerms, claudeCliPath, defaultBackend } = opts;

  return new ProviderRouter({
    defaultBackend,
    factories: {
      claudecode: async () => {
        const { SDKLLMProvider, resolveClaudeCliPath, preflightCheck } = await import('./llm-provider.js');
        const cliPath = claudeCliPath ?? resolveClaudeCliPath();
        if (!cliPath) {
          throw new Error(
            'Claude CLI not found. Install Claude Code or set CTI_CLAUDE_CODE_EXECUTABLE.',
          );
        }
        const check = preflightCheck(cliPath);
        if (!check.ok) {
          throw new Error(`Claude CLI preflight failed at ${cliPath}: ${check.error}`);
        }
        return new SDKLLMProvider(pendingPerms, cliPath, config.autoApprove);
      },
      codex: async () => {
        const { CodexProvider } = await import('./codex-provider.js');
        return new CodexProvider(pendingPerms);
      },
      copilot: async () => {
        const { CopilotProvider } = await import('./copilot-provider.js');
        return new CopilotProvider();
      },
    },
  });
}
