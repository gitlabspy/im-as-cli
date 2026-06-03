import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listNativeSessionTabs } from '../../lib/bridge/native-session-index';

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-native-index-'));
  tempRoots.push(root);
  return root;
}

function writeJsonl(filePath: string, rows: unknown[], mtime: Date): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n'), 'utf-8');
  fs.utimesSync(filePath, mtime, mtime);
}

describe('native-session-index', () => {
  it('lists recent Claude sessions with last user and assistant snippets', () => {
    const root = makeTempRoot();
    const claudeProjectsDir = path.join(root, 'claude-projects');
    const codexSessionsDir = path.join(root, 'codex-sessions');

    writeJsonl(path.join(claudeProjectsDir, 'older.jsonl'), [
      {
        type: 'user',
        timestamp: '2026-05-01T00:00:00.000Z',
        sessionId: 'claude-old',
        cwd: 'C:\\old',
        message: { role: 'user', content: 'old question' },
      },
    ], new Date('2026-05-01T00:00:00.000Z'));

    writeJsonl(path.join(claudeProjectsDir, 'newer.jsonl'), [
      {
        type: 'user',
        timestamp: '2026-06-01T00:00:00.000Z',
        sessionId: 'claude-new',
        cwd: 'C:\\new',
        message: { role: 'user', content: [{ type: 'text', text: 'please fix native tabs' }] },
      },
      {
        type: 'assistant',
        timestamp: '2026-06-01T00:01:00.000Z',
        sessionId: 'claude-new',
        cwd: 'C:\\new',
        message: { role: 'assistant', content: [{ type: 'text', text: 'native tabs are fixed' }] },
      },
    ], new Date('2026-06-01T00:01:00.000Z'));

    const tabs = listNativeSessionTabs({
      backend: 'claudecode',
      limit: 1,
      roots: { claudeProjectsDir, codexSessionsDir },
    });

    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].nativeSessionId, 'claude-new');
    assert.equal(tabs[0].workingDirectory, 'C:\\new');
    assert.equal(tabs[0].lastUserQuestion, 'please fix native tabs');
    assert.equal(tabs[0].lastAgentOutput, 'native tabs are fixed');
  });

  it('lists recent Codex sessions and truncates long snippets', () => {
    const root = makeTempRoot();
    const claudeProjectsDir = path.join(root, 'claude-projects');
    const codexSessionsDir = path.join(root, 'codex-sessions');
    const longUserText = 'u'.repeat(80);
    const longAgentText = 'a'.repeat(80);

    writeJsonl(path.join(codexSessionsDir, '2026', '06', 'rollout.jsonl'), [
      {
        timestamp: '2026-06-02T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-thread-1', cwd: 'C:\\codex' },
      },
      {
        timestamp: '2026-06-02T00:01:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: longUserText }] },
      },
      {
        timestamp: '2026-06-02T00:02:00.000Z',
        type: 'response_item',
        payload: { type: 'agent_message', role: 'assistant', content: [{ type: 'output_text', text: longAgentText }] },
      },
    ], new Date('2026-06-02T00:02:00.000Z'));

    const tabs = listNativeSessionTabs({
      backend: 'codex',
      limit: 10,
      maxSnippetChars: 20,
      roots: { claudeProjectsDir, codexSessionsDir },
    });

    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].nativeSessionId, 'codex-thread-1');
    assert.equal(tabs[0].workingDirectory, 'C:\\codex');
    assert.equal(tabs[0].lastUserQuestion, `${'u'.repeat(19)}…`);
    assert.equal(tabs[0].lastAgentOutput, `${'a'.repeat(19)}…`);
  });
});
