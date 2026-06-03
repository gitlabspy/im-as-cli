import type { LLMProvider } from 'remote-agent-control-core/src/lib/bridge/host.js';
import type { BackendName } from 'remote-agent-control-core/src/lib/bridge/types.js';

import type { Config } from './config.js';
import { resolveClaudeCliPath, preflightCheck } from './llm-provider.js';
import type { PendingPermissions } from './permission-gateway.js';
import { buildDefaultRouter } from './provider-router.js';

export async function resolveProvider(config: Config, pendingPerms: PendingPermissions): Promise<LLMProvider> {
  const runtime = config.runtime;

  let defaultBackend: BackendName;
  let claudeCliPath: string | undefined;

  if (runtime === 'codex') {
    defaultBackend = 'codex';
  } else if (runtime === 'copilot') {
    defaultBackend = 'copilot';
  } else if (runtime === 'auto') {
    const cliPath = resolveClaudeCliPath();
    if (cliPath) {
      const check = preflightCheck(cliPath);
      if (check.ok) {
        console.log(`[remote-agent-control] Auto: using Claude CLI at ${cliPath} (${check.version})`);
        defaultBackend = 'claudecode';
        claudeCliPath = cliPath;
      } else {
        console.warn(
          `[remote-agent-control] Auto: Claude CLI at ${cliPath} failed preflight: ${check.error}\n` +
          `  Falling back to Codex.`,
        );
        defaultBackend = 'codex';
      }
    } else {
      console.log('[remote-agent-control] Auto: Claude CLI not found, falling back to Codex');
      defaultBackend = 'codex';
    }
  } else {
    const cliPath = resolveClaudeCliPath();
    if (!cliPath) {
      throw new Error(
        'Cannot find the `claude` CLI executable. Install Claude Code CLI, set CTI_CLAUDE_CODE_EXECUTABLE, or set CTI_RUNTIME=auto|codex|copilot.',
      );
    }
    const check = preflightCheck(cliPath);
    if (!check.ok) {
      throw new Error(`Claude CLI preflight failed at ${cliPath}: ${check.error}`);
    }
    console.log(`[remote-agent-control] CLI preflight OK: ${cliPath} (${check.version})`);
    defaultBackend = 'claudecode';
    claudeCliPath = cliPath;
  }

  return buildDefaultRouter({
    config,
    pendingPerms,
    claudeCliPath,
    defaultBackend,
  });
}
