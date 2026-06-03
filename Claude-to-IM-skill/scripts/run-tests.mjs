import { spawn } from 'node:child_process';
import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ctiHome = await mkdtemp(path.join(tmpdir(), 'remote-agent-control-test-'));
const testDir = path.join('src', '__tests__');
const files = (await readdir(testDir))
  .filter((file) => file.endsWith('.test.ts'))
  .sort()
  .map((file) => path.join(testDir, file));

const args = [
  '--test',
  '--test-concurrency=1',
  '--import',
  'tsx',
  '--test-timeout=15000',
  ...files,
];

const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  env: { ...process.env, CTI_HOME: ctiHome },
});

child.on('exit', async (code, signal) => {
  await rm(ctiHome, { recursive: true, force: true });
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
