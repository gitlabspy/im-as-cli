import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createControlCommandHandler } from '../control-command.js';

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cti-control-test-'));
}

describe('control command handler', () => {
  it('reports bridge status from status.json', async () => {
    const ctiHome = makeHome();
    fs.mkdirSync(path.join(ctiHome, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(ctiHome, 'runtime', 'status.json'), JSON.stringify({
      running: true,
      pid: 1234,
      runId: 'run-1',
      startedAt: '2026-06-03T00:00:00.000Z',
      channels: ['feishu'],
    }));

    const handler = createControlCommandHandler({ ctiHome });
    const result = await handler({
      action: 'status',
      args: '',
      rawText: '/ctl status',
      channelType: 'feishu',
      chatId: 'chat-1',
      messageId: 'msg-1',
    });

    assert.equal(result.parseMode, 'plain');
    assert.match(result.text, /Control plane: online/);
    assert.match(result.text, /Bridge status: running/);
    assert.match(result.text, /PID: 1234/);
    assert.match(result.text, /Channels: feishu/);
  });

  it('returns sanitized recent logs', async () => {
    const ctiHome = makeHome();
    fs.mkdirSync(path.join(ctiHome, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(ctiHome, 'logs', 'bridge.log'), [
      'first',
      'secret=abc123',
      'token: xyz789',
      'last',
    ].join('\n'));

    const handler = createControlCommandHandler({ ctiHome });
    const result = await handler({
      action: 'logs',
      args: '3',
      rawText: '/ctl logs 3',
      channelType: 'feishu',
      chatId: 'chat-1',
      messageId: 'msg-1',
    });

    assert.equal(result.parseMode, 'plain');
    assert.doesNotMatch(result.text, /first/);
    assert.doesNotMatch(result.text, /abc123|xyz789/);
    assert.match(result.text, /secret=\*+c123/);
    assert.match(result.text, /token: \*+z789/);
    assert.match(result.text, /last/);
  });

  it('schedules restart without blocking the reply', async () => {
    const scheduled: number[] = [];
    const handler = createControlCommandHandler({
      ctiHome: makeHome(),
      restartDelayMs: 25,
      scheduleRestart: (delayMs) => { scheduled.push(delayMs); },
    });

    const result = await handler({
      action: 'restart',
      args: '',
      rawText: '/ctl restart',
      channelType: 'feishu',
      chatId: 'chat-1',
      messageId: 'msg-1',
    });

    assert.deepStrictEqual(scheduled, [25]);
    assert.equal(result.parseMode, 'plain');
    assert.match(result.text, /Restart requested/);
  });

  it('rejects /ctl from unauthorized users when allowlist is set', async () => {
    const handler = createControlCommandHandler({
      ctiHome: makeHome(),
      config: { controlAllowedUsers: ['allowed-user'], controlAllowedChats: ['allowed-chat'] },
    });

    const result = await handler({
      action: 'status',
      args: '',
      rawText: '/ctl status',
      channelType: 'feishu',
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'msg-1',
    });

    assert.equal(result.parseMode, 'plain');
    assert.match(result.text, /Unauthorized/);
  });

  it('allows /ctl from an authorized chat', async () => {
    const handler = createControlCommandHandler({
      ctiHome: makeHome(),
      config: { controlAllowedChats: ['chat-1'] },
    });

    const result = await handler({
      action: 'status',
      args: '',
      rawText: '/ctl status',
      channelType: 'feishu',
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'msg-1',
    });

    assert.match(result.text, /Control plane: online/);
  });

  it('routes worker lifecycle commands to the worker manager', async () => {
    const calls: string[] = [];
    const workerStatus = { state: 'running' as const, pid: 42, port: 3000, generation: 'gen-1' };
    const handler = createControlCommandHandler({
      ctiHome: makeHome(),
      workerManager: {
        getStatus: async () => workerStatus,
        health: async () => ({ ok: true, state: 'running', pid: 42, port: 3000, generation: 'gen-1', uptimeMs: 1000 }),
        start: async () => { calls.push('start'); return { ok: true, message: 'started', status: workerStatus }; },
        stop: async () => { calls.push('stop'); return { ok: true, message: 'stopped', status: { state: 'stopped' as const } }; },
        restart: async () => { calls.push('restart'); return { ok: true, message: 'restarted', status: workerStatus }; },
      },
    });

    const result = await handler({
      action: 'worker',
      args: 'restart',
      rawText: '/ctl worker restart',
      channelType: 'feishu',
      chatId: 'chat-1',
      messageId: 'msg-1',
    });

    assert.deepStrictEqual(calls, ['restart']);
    assert.match(result.text, /restarted/);
    assert.match(result.text, /Worker status: running/);
  });
});
