import * as esbuild from 'esbuild';

const commonOptions = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: [
    // remote-agent-control-core library (copy B) stays external - loaded at runtime from
    // its compiled dist via the package "exports" map, NOT inlined here.
    // This is what lets you `npm run build` in B and have the daemon pick up
    // the change without rebundling the skill. node_modules/remote-agent-control-core is a
    // junction -> B; Node resolves B's own deps from B/node_modules via realpath.
    'remote-agent-control-core', 'remote-agent-control-core/*',
    // SDK must stay external - it spawns a CLI subprocess and resolves
    // dist/cli.js relative to its own package location. Bundling it
    // breaks that path resolution.
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex-sdk',
    // discord.js optional native deps
    'bufferutil', 'utf-8-validate', 'zlib-sync', 'erlpack',
    // Node.js built-ins
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls',
    'stream', 'events', 'url', 'util', 'child_process', 'worker_threads',
    'node:*',
  ],
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
};

await esbuild.build({
  ...commonOptions,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/daemon.mjs',
});

console.log('Built dist/daemon.mjs');

await esbuild.build({
  ...commonOptions,
  entryPoints: ['src/worker-main.ts'],
  outfile: 'dist/worker.mjs',
});

console.log('Built dist/worker.mjs');
