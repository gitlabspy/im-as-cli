# Developing Remote Agent Control

This is the **skill host** package (`remote-agent-control-skill`). It is a thin daemon that wraps
the **`remote-agent-control-core` library** and adds skill-specific glue (config wizard, file store,
process management, IM↔SDK providers). If you are here to fix bridge behavior — message
routing, streaming cards, permission flow, Markdown rendering, adapters — that code lives
in the **library**, not here.

## Two-package architecture

```
remote-agent-control-core (LIBRARY)                  remote-agent-control-skill (THIS PACKAGE / HOST)
  src/lib/bridge/*.ts                           src/main.ts          ← daemon entry
    bridge-manager.ts  (orchestrator)           src/config.ts        ← config.env ↔ settings
    channel-adapter.ts (base + registry)        src/store.ts         ← JSON BridgeStore
    adapters/ telegram|discord|feishu           src/llm-provider.ts  ← Claude Agent SDK
    markdown/ feishu|telegram|discord           src/codex-provider.ts← Codex SDK
    security/, context.ts, ...                  src/permission-gateway.ts
  package.json  "exports" map  ───────────┐     scripts/build.js     ← esbuild bundler
  dist/  (compiled JS, what runs) ◄────────┘     scripts/daemon.sh    ← start/stop/status
                                                 dist/daemon.mjs      ← bundled output
```

The host's `src/*.ts` import from the library using **source-style specifiers**, e.g.:

```ts
import { BridgeManager } from 'remote-agent-control-core/src/lib/bridge/bridge-manager.js';
```

These do **not** resolve to the library's TypeScript source. The library's `package.json`
has an `exports` map that rewrites `./src/lib/bridge/*.js` → `./dist/lib/bridge/*.js`, so
every such import lands on the library's **compiled `dist/`**. You never need to rewrite
these specifiers.

## The build chain (and why it used to hurt)

`scripts/build.js` runs esbuild with `bundle: true`. **`remote-agent-control-core` is listed in the
`external` array**, so the bundler does NOT inline the library's source into
`dist/daemon.mjs`. Instead the daemon loads the library from its compiled `dist/` at
runtime, via the same `exports` map.

What this means in practice:

| You changed code in… | What to rebuild |
|---|---|
| **the library** (`remote-agent-control-core/src/...`) | `npm run build` **in the library** only. The daemon picks it up on next restart — no skill rebundle. |
| **the host** (`remote-agent-control-skill/src/...`) | `npm run build` here, then restart the daemon. |

Before this externalization, esbuild inlined the entire library into `daemon.mjs`. A
one-line fix in the library meant: rebuild the library, *then* rebundle the skill, *then*
restart — and it was easy to forget step 2 and ship a stale daemon. Externalizing the
library collapsed that to a single rebuild in whichever package you actually edited.

To verify the bundle stays externalized after touching `build.js`:

```bash
npm run build
grep -o 'from "remote-agent-control-core[^"]*"' dist/daemon.mjs | sort -u   # should list runtime imports
grep -c 'buildFinalCardJson' dist/daemon.mjs                    # library internal → expect 0
```

If `buildFinalCardJson` (a library-internal function) appears in the bundle, the library
got inlined again — check that `'remote-agent-control-core', 'remote-agent-control-core/*'` are still in the
`external` array in `scripts/build.js`.

## How the host finds the library

`package.json` declares `"remote-agent-control-core": "file:..."` pointing at the library checkout, so
`npm install` materializes `node_modules/remote-agent-control-core`. On Windows this is a **junction**
(via `mklink /J`), on macOS/Linux a symlink. Node resolves the library's own runtime deps
(discord.js, markdown-it, ws, @larksuiteoapi, the Claude Agent SDK) from the **library's**
`node_modules` via realpath — so the library must have its own deps installed.

To confirm where the junction/symlink points:

```bash
# Windows
fsutil reparsepoint query node_modules/remote-agent-control-core
# macOS / Linux
readlink node_modules/remote-agent-control-core
```

## Skill registration (Claude Code vs Codex)

Claude Code and Codex discover skills from different directories, but both should point
at this package and use the sibling `Claude-to-IM/` library checkout:

- **Claude Code** — symlink or copy this package to `~/.claude/skills/remote-agent-control`.
- **Codex** — run `bash scripts/install-codex.sh` from this package. The script installs
  or links both `Claude-to-IM/` and `Claude-to-IM-skill/` under `~/.codex/skills/` so the
  `file:../Claude-to-IM` dependency resolves.

Each host runs its own daemon, but bridge behavior is defined once in the shared library.

## Daemon control

```bash
bash scripts/daemon.sh start        # background daemon
bash scripts/daemon.sh stop
bash scripts/daemon.sh status       # JSON: pid, runId, channels
bash scripts/daemon.sh logs 50      # last N log lines
```

On Windows these delegate to `scripts/supervisor-windows.ps1`; on macOS/Linux to the
respective `supervisor-*.sh`. Logs and runtime state live under `~/.claude-to-im/`
(`logs/bridge.log`, `runtime/bridge.pid`, `runtime/status.json`).

## Gotchas

- **esbuild escapes CJK** to `\uXXXX` in the bundle. Grepping `dist/daemon.mjs` for a
  Chinese string (e.g. `最后答复`) returns 0 matches even though the text is present.
  Grep the **source** instead.
- **Streaming cards are capability-gated**, not flag-gated. The bridge enables them when
  `typeof adapter.onStreamText === 'function'`; there is no env toggle. To change this,
  edit the library's `bridge-manager.ts`.
- **Restart after host changes.** A rebuilt `daemon.mjs` does nothing until the running
  daemon is restarted (`stop` then `start`).
- **Secrets in logs.** `config.env` holds IM credentials (`chmod 600`). The logger
  redacts tokens by pattern; when pasting any terminal output into a bug report, mask
  secrets to the last 4 characters.
