import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildCopilotArgs } from '../copilot-provider.js';

describe('buildCopilotArgs — sandbox gating', () => {
  const saved = process.env.CTI_COPILOT_ALLOW_TOOLS;
  function withEnv(val: string | undefined, fn: () => void) {
    if (val === undefined) delete process.env.CTI_COPILOT_ALLOW_TOOLS;
    else process.env.CTI_COPILOT_ALLOW_TOOLS = val;
    try { fn(); } finally {
      if (saved === undefined) delete process.env.CTI_COPILOT_ALLOW_TOOLS;
      else process.env.CTI_COPILOT_ALLOW_TOOLS = saved;
    }
  }

  it('sandboxLevel="ro" forces --no-tools even when env unlocks tools', () => {
    withEnv('true', () => {
      const args = buildCopilotArgs({ prompt: 'hi', sandboxLevel: 'ro' });
      assert.ok(args.includes('--no-tools'), 'ro must always gate tools off');
    });
  });

  it('sandboxLevel="full" omits --no-tools even when env is unset', () => {
    withEnv(undefined, () => {
      const args = buildCopilotArgs({ prompt: 'hi', sandboxLevel: 'full' });
      assert.ok(!args.includes('--no-tools'), 'full must enable tools regardless of env');
    });
  });

  it('sandboxLevel="rw" (default) follows env: tools off when env unset', () => {
    withEnv(undefined, () => {
      const args = buildCopilotArgs({ prompt: 'hi', sandboxLevel: 'rw' });
      assert.ok(args.includes('--no-tools'));
    });
  });

  it('sandboxLevel="rw" follows env: tools on when CTI_COPILOT_ALLOW_TOOLS=true', () => {
    withEnv('true', () => {
      const args = buildCopilotArgs({ prompt: 'hi', sandboxLevel: 'rw' });
      assert.ok(!args.includes('--no-tools'));
    });
  });

  it('defaults to rw when sandboxLevel omitted', () => {
    withEnv(undefined, () => {
      const args = buildCopilotArgs({ prompt: 'hi' });
      assert.ok(args.includes('--no-tools'));
    });
    withEnv('true', () => {
      const args = buildCopilotArgs({ prompt: 'hi' });
      assert.ok(!args.includes('--no-tools'));
    });
  });

  it('passes through prompt, --resume, and --cwd', () => {
    const args = buildCopilotArgs({
      prompt: 'hello',
      resumeId: 'sess-123',
      sandboxLevel: 'ro',
      workingDirectory: '/tmp/work',
    });
    assert.deepEqual(
      args,
      ['-p', 'hello', '--output-format', 'json', '--no-color', '--log-level', 'none',
       '--resume', 'sess-123', '--no-tools', '--cwd', '/tmp/work'],
    );
  });
});
