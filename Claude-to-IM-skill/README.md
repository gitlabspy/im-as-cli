# Remote Agent Control Skill

Bridge Claude Code / Codex to IM platforms — chat with AI coding agents from Telegram, Discord, Feishu/Lark, QQ, or WeChat.

[中文文档](README_CN.md)

---

## How It Works

This skill runs a background daemon that connects your IM bots to Claude Code or Codex sessions. Messages from IM are forwarded to the AI coding agent, and responses (including tool use, permission requests, streaming previews) are sent back to your chat.

```
You (Telegram/Discord/Feishu/QQ/WeChat)
  ↕ Bot API
Background Daemon (Node.js)
  ↕ Claude Agent SDK or Codex SDK (configurable via CTI_RUNTIME)
Claude Code / Codex → reads/writes your codebase
```

## Features

- **Five IM platforms** — Telegram, Discord, Feishu/Lark, QQ, WeChat — enable any combination
- **Interactive setup** — guided wizard collects tokens with step-by-step instructions
- **Permission control** — tool calls require explicit approval via inline buttons (Telegram/Discord) or text `/perm` commands / quick `1/2/3` replies (Feishu/QQ/WeChat)
- **Streaming preview** — see Claude's response as it types (Telegram & Discord)
- **Session persistence** — conversations survive daemon restarts
- **Secret protection** — tokens stored with `chmod 600`, auto-redacted in all logs
- **Zero code required** — install the skill and run `/remote-agent-control setup`, or tell Codex `remote-agent-control setup`

## Prerequisites

- **Node.js >= 20**
- **Claude Code CLI** (for `CTI_RUNTIME=claude` or `auto`) — installed and authenticated (`claude` command available)
- **Codex CLI** (for `CTI_RUNTIME=codex` or `auto`) — `npm install -g @openai/codex`. Auth: run `codex auth login`, or set `OPENAI_API_KEY` (optional, for API mode)

## Installation

Install from the source workspace. The skill package is named
`remote-agent-control-skill` and depends on the core package
`remote-agent-control-core` through the transitional local path
`file:../Claude-to-IM`, so the two package directories must stay next to each
other:

```text
remote-agent-control/
  Claude-to-IM/        # core bridge library
  Claude-to-IM-skill/  # this skill and daemon wrapper
```

Clone the new repository, then install and build from the repository root:

```bash
git clone <new-repo-url> remote-agent-control
cd remote-agent-control
npm run install:all
npm run build
```

### Claude Code

Use the installer from the repository root:

```bash
bash scripts/install-claude.sh
```

Then start a new Claude Code session and run:

```text
/remote-agent-control setup
```

### Codex

Use the installer from the repository root:

```bash
bash scripts/install-codex.sh
```

For local development with a live checkout:

```bash
bash scripts/install-codex.sh --link
```

The install script places the skill at `~/.codex/skills/remote-agent-control`,
copies or links the core library to the transitional dependency path, installs
dependencies, and builds both packages.

After installation, tell Codex:

```text
remote-agent-control setup
```

If you want WeChat specifically, you can also say:

```text
帮我接微信桥接
```

### Verify installation

**Claude Code:** Start a new session and type `/` — you should see `remote-agent-control` in the skill list. Or ask Claude: "What skills are available?"

**Codex:** Start a new session and say `remote-agent-control setup`, `start bridge`, or `帮我接微信桥接`.

## Updating the Skill

Pull or replace the source workspace, then rebuild both packages from the
repository root:

```bash
npm run install:all
npm run build
```

### Claude Code

If you installed via symlink, the rebuilt checkout is used immediately. If you
copied the skill manually, replace `~/.claude/skills/remote-agent-control` with the new
`Claude-to-IM-skill/` directory.

Restart the daemon after updating.

Then tell Claude Code:

```text
/remote-agent-control doctor
/remote-agent-control start
```

### Codex

If you installed with the Codex install script in copy mode, reinstall:

```bash
rm -rf ~/.codex/skills/remote-agent-control
bash scripts/install-codex.sh
```

If you installed with `--link`, rebuilding the source checkout is enough.

Then tell Codex:

```text
remote-agent-control doctor
start bridge
```

## Quick Start

### 1. Setup

**Claude Code**

```text
/remote-agent-control setup
```

**Codex**

```text
remote-agent-control setup
```

The wizard will guide you through:

1. **Choose channels** — pick Telegram, Discord, Feishu, QQ, WeChat, or any combination
2. **Enter credentials** — the wizard explains exactly where to get each token, which settings to enable, and what permissions to grant
3. **Set defaults** — working directory, model, and mode
4. **Validate** — tokens are verified against platform APIs immediately

### 2. Start

**Claude Code**

```text
/remote-agent-control start
```

**Codex**

```text
start bridge
```

The daemon starts in the background. You can close the terminal — it keeps running.

### 3. Chat

Open your IM app and send a message to your bot. Claude Code / Codex will respond through the bridge.

When Claude needs to use a tool (edit a file, run a command), you'll see a permission prompt with **Allow** / **Deny** buttons right in the chat (Telegram/Discord), or a text `/perm` command prompt / quick `1/2/3` replies (Feishu/QQ/WeChat).

## Commands

All commands are run inside Claude Code or Codex:

| Claude Code | Codex (natural language) | Description |
|---|---|---|
| `/remote-agent-control setup` | "remote-agent-control setup" / "配置" | Interactive setup wizard |
| `/remote-agent-control start` | "start bridge" / "启动桥接" | Start the bridge daemon |
| `/remote-agent-control stop` | "stop bridge" / "停止桥接" | Stop the bridge daemon |
| `/remote-agent-control status` | "bridge status" / "状态" | Show daemon status |
| `/remote-agent-control logs` | "查看日志" | Show last 50 log lines |
| `/remote-agent-control logs 200` | "logs 200" | Show last 200 log lines |
| `/remote-agent-control reconfigure` | "reconfigure" / "修改配置" | Update config interactively |
| `/remote-agent-control doctor` | "doctor" / "诊断" | Diagnose issues |

## Platform Setup Guides

The `setup` wizard provides inline guidance for every step. Here's a summary:

### Telegram

1. Message `@BotFather` on Telegram → `/newbot` → follow prompts
2. Copy the bot token (format: `123456789:AABbCc...`)
3. Recommended: `/setprivacy` → Disable (for group use)
4. Find your User ID: message `@userinfobot`

### Discord

1. Go to [Discord Developer Portal](https://discord.com/developers/applications) → New Application
2. Bot tab → Reset Token → copy it
3. Enable **Message Content Intent** under Privileged Gateway Intents
4. OAuth2 → URL Generator → scope `bot` → permissions: Send Messages, Read Message History, View Channels → copy invite URL

### Feishu / Lark

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) (or [Lark](https://open.larksuite.com/app))
2. Create Custom App → get App ID and App Secret
3. **Batch-add permissions**: go to "Permissions & Scopes" → use batch configuration to add all required scopes (the `setup` wizard provides the exact JSON)
4. Enable Bot feature under "Add Features"
5. **Events & Callbacks**: select **"Long Connection"** as event dispatch method → add `im.message.receive_v1` event
6. **Publish**: go to "Version Management & Release" → create version → submit for review → approve in Admin Console
7. **Important**: The bot will NOT work until the version is approved and published

### QQ

> QQ currently supports **C2C private chat only**. No group/channel support, no inline permission buttons, no streaming preview. Permissions use text `/perm ...` commands. Image inbound only (no image replies).

1. Go to [QQ Bot OpenClaw](https://q.qq.com/qqbot/openclaw)
2. Create a QQ Bot or select an existing one → get **App ID** and **App Secret** (only two required fields)
3. Configure sandbox access and scan QR code with QQ to add the bot
4. `CTI_QQ_ALLOWED_USERS` takes `user_openid` values (not QQ numbers) — can be left empty initially
5. Set `CTI_QQ_IMAGE_ENABLED=false` if the underlying provider doesn't support image input

### WeChat / Weixin

> WeChat currently uses QR login, single-account mode, text-based permissions, and no streaming preview.

1. Run the local QR helper from your installed skill directory:
   - Claude Code default install: `cd ~/.claude/skills/remote-agent-control && npm run weixin:login`
   - Codex default install: `cd ~/.codex/skills/remote-agent-control && npm run weixin:login`
2. The helper writes `~/.claude-to-im/runtime/weixin-login.html` and tries to open it in your browser automatically
3. Scan the QR code with WeChat and confirm on your phone
4. On success, the linked account is stored in `~/.claude-to-im/data/weixin-accounts.json`
5. Running the helper again replaces the previously linked WeChat account

Additional notes:

- `CTI_WEIXIN_MEDIA_ENABLED` controls inbound image/file/video downloads only
- Voice messages only use WeChat's own built-in speech-to-text text
- If WeChat does not provide `voice_item.text`, the bridge replies with an error instead of downloading/transcribing raw voice audio
- Permission approvals use text `/perm ...` commands or quick `1/2/3` replies

## Architecture

```
~/.claude-to-im/
├── config.env             ← Credentials & settings (chmod 600)
├── data/                  ← Persistent JSON storage
│   ├── sessions.json
│   ├── bindings.json
│   ├── permissions.json
│   └── messages/          ← Per-session message history
├── logs/
│   └── bridge.log         ← Auto-rotated, secrets redacted
└── runtime/
    ├── bridge.pid          ← Daemon PID file
    └── status.json         ← Current status
```

### Key components

| Component | Role |
|---|---|
| `src/main.ts` | Daemon entry — assembles DI, starts bridge |
| `src/config.ts` | Load/save `config.env`, map to bridge settings |
| `src/store.ts` | JSON file BridgeStore (30 methods, write-through cache) |
| `src/llm-provider.ts` | Claude Agent SDK `query()` → SSE stream |
| `src/codex-provider.ts` | Codex SDK `runStreamed()` → SSE stream |
| `src/sse-utils.ts` | Shared SSE formatting helper |
| `src/permission-gateway.ts` | Async bridge: SDK `canUseTool` ↔ IM buttons |
| `src/logger.ts` | Secret-redacted file logging with rotation |
| `scripts/daemon.sh` | Process management (start/stop/status/logs) |
| `scripts/doctor.sh` | Health checks |
| `SKILL.md` | Claude Code skill definition |

### Permission flow

```
1. Claude wants to use a tool (e.g., Edit file)
2. SDK calls canUseTool() → LLMProvider emits permission_request SSE
3. Bridge sends inline buttons to IM chat: [Allow] [Deny]
4. canUseTool() blocks, waiting for user response (5 min timeout)
5. User taps Allow → bridge resolves the pending permission
6. SDK continues tool execution → result streamed back to IM
```

## Troubleshooting

Run diagnostics:

```
/remote-agent-control doctor
```

This checks: Node.js version, config file existence and permissions, token validity (live API calls), log directory, PID file consistency, and recent errors.

| Issue | Solution |
|---|---|
| `Bridge won't start` | Run `doctor`. Check if Node >= 20. Check logs. |
| `Messages not received` | Verify token with `doctor`. Check allowed users config. |
| `Permission timeout` | User didn't respond within 5 min. Tool call auto-denied. |
| `Stale PID file` | Run `stop` then `start`. daemon.sh auto-cleans stale PIDs. |

See [references/troubleshooting.md](references/troubleshooting.md) for more details.

## Security

- All credentials stored in `~/.claude-to-im/config.env` with `chmod 600`
- Tokens are automatically redacted in all log output (pattern-based masking)
- Allowed user/channel/guild lists restrict who can interact with the bot
- The daemon is a local process with no inbound network listeners
- See [SECURITY.md](SECURITY.md) for threat model and incident response

## Development

```bash
npm install        # Install dependencies
npm run dev        # Run in dev mode
npm run typecheck  # Type check
npm test           # Run tests
npm run build      # Build bundle
```

## License

[MIT](LICENSE)
