# Remote Agent Control

Remote Agent Control lets you use Claude Code or Codex from IM apps such as
Telegram, Discord, Feishu/Lark, QQ, and WeChat.

This repository is the new open-source root for the project. It is not intended
to inherit earlier repository history or install instructions.

Current best practise: Lark + codex.

## Requirements

- Node.js 20 or newer
- Claude Code CLI for `CTI_RUNTIME=claude` or `auto`
- Codex CLI for `CTI_RUNTIME=codex` or `auto`
- Bot/app credentials for the IM platforms you enable

## Quick Start

From the repository root:

```bash
npm run install:all
npm run build
```

Install the skill for Codex:

```bash
bash scripts/install-codex.sh
```

On Windows PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-codex.ps1
```

For live local development, link the skill instead of copying it:

```bash
bash scripts/install-codex.sh --link
```

On Windows PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-codex.ps1 -Link
```

Install the skill for Claude Code:

```bash
bash scripts/install-claude.sh
```

On Windows PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-claude.ps1
```

Then start a new agent session and run:

```text
remote-agent-control setup
```

In Claude Code slash-command form:

```text
/remote-agent-control setup
```

## LLM Agent Install Notes

If you are an LLM agent installing this repository from a fresh checkout or zip,
first run these commands from the repository root:

```bash
npm run install:all
npm run build
```

Then install the skill for the agent runtime you are using.

Codex:

```bash
bash scripts/install-codex.sh --link
```

Claude Code:

```bash
bash scripts/install-claude.sh --link
```

On Windows PowerShell, use the matching installer:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-codex.ps1 -Link
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-claude.ps1 -Link
```

After installation, start a new agent session and run
`remote-agent-control setup` in Codex or `/remote-agent-control setup` in
Claude Code. Do not commit generated runtime files or secrets from
`~/.claude-to-im/`.

## Common Commands

```bash
npm run install:all
npm run build
npm run typecheck
npm test

bash Claude-to-IM-skill/scripts/daemon.sh status
bash Claude-to-IM-skill/scripts/daemon.sh start
bash Claude-to-IM-skill/scripts/daemon.sh stop
bash Claude-to-IM-skill/scripts/daemon.sh logs 100
```

On Windows, daemon commands are also available through:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File Claude-to-IM-skill\scripts\daemon.ps1 status
```

## Configuration Compatibility

The public project name is Remote Agent Control and the skill command is
`remote-agent-control`.

Runtime configuration intentionally keeps the existing compatibility names for
now:

- Environment variables still use the `CTI_*` prefix.
- Runtime data still defaults to `~/.claude-to-im/`.
- The checked-out package directories are still `Claude-to-IM/` and
  `Claude-to-IM-skill/` until a later physical layout migration.

The setup flow writes `~/.claude-to-im/config.env`. To configure manually, copy
[`Claude-to-IM-skill/config.env.example`](Claude-to-IM-skill/config.env.example)
to that location and fill in only the channels you want to enable.

Secrets and runtime state must not be committed. The repository `.gitignore`
excludes build output, `node_modules/`, logs, local reports, and common env
files.

## Source Layout

The current source layout is transitional:

```text
Claude-to-IM/
  src/lib/bridge/        core bridge library
  docs/                  library integration notes
  package.json           package name: remote-agent-control-core

Claude-to-IM-skill/
  SKILL.md               skill entry used by Claude Code/Codex
  src/                   daemon host implementation
  scripts/               install, build, daemon, and doctor scripts
  references/            setup and troubleshooting guides
  config.env.example     package name: remote-agent-control-skill
```

Keeping these directory names avoids breaking the transitional
`file:../Claude-to-IM` dependency while the project is being prepared as a new
root repository.

## Preparing a New Public Repo

This local workspace has been converted to a single root Git repository. The
old nested Git repositories from earlier development have been removed; keep it
that way before publishing.

Safe manual sequence before the first public commit:

```bash
# from this repository root
git add .
git status
```

Review the staged files before the first commit. Expected shareable files
include source, tests, docs, `package-lock.json`, `config.env.example`, and
scripts. Do not include `node_modules/`, `dist/`, local logs, `reports/`, or
`~/.claude-to-im/`.

Before publishing:

```bash
npm run build
npm run typecheck
npm test
```
