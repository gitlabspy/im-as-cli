# Remote Agent Control Skill

将 Claude Code / Codex 桥接到 IM 平台 —— 在 Telegram、Discord、飞书、QQ 或微信中与 AI 编程代理对话。

[English](README.md)

---

## 工作原理

本 Skill 运行一个后台守护进程，将你的 IM 机器人连接到 Claude Code 或 Codex 会话。来自 IM 的消息被转发给 AI 编程代理，响应（包括工具调用、权限请求、流式预览）会发回到聊天中。

```
你 (Telegram/Discord/飞书/QQ/微信)
  ↕ Bot API
后台守护进程 (Node.js)
  ↕ Claude Agent SDK 或 Codex SDK（通过 CTI_RUNTIME 配置）
Claude Code / Codex → 读写你的代码库
```

## 功能特点

- **五大 IM 平台** — Telegram、Discord、飞书、QQ、微信，可任意组合启用
- **交互式配置** — 引导式向导逐步收集 token，附带详细获取说明
- **权限控制** — 工具调用需要在聊天中通过内联按钮（Telegram/Discord）或文本 `/perm` 命令 / 快捷 `1/2/3` 回复（飞书/QQ/微信）明确批准
- **流式预览** — 实时查看 Claude 的输出（Telegram 和 Discord 支持）
- **会话持久化** — 对话在守护进程重启后保留
- **密钥保护** — token 以 `chmod 600` 存储，日志中自动脱敏
- **无需编写代码** — 安装 Skill 后运行 `/remote-agent-control setup`，或直接对 Codex 说 `remote-agent-control setup`

## 前置要求

- **Node.js >= 20**
- **Claude Code CLI**（`CTI_RUNTIME=claude` 或 `auto` 时需要）— 已安装并完成认证（`claude` 命令可用）
- **Codex CLI**（`CTI_RUNTIME=codex` 或 `auto` 时需要）— `npm install -g @openai/codex`。鉴权：运行 `codex auth login`，或设置 `OPENAI_API_KEY`（可选，API 模式）

## 安装

从源码工作区安装。这个 Skill 包名是 `remote-agent-control-skill`，依赖核心包
`remote-agent-control-core`。当前源码布局仍通过过渡路径
`file:../Claude-to-IM` 解析依赖，所以两个包目录必须保持相邻：

```text
remote-agent-control/
  Claude-to-IM/        # 核心桥接库
  Claude-to-IM-skill/  # 这个 Skill 和 daemon wrapper
```

克隆新的仓库后，从仓库根目录安装并构建：

```bash
git clone <new-repo-url> remote-agent-control
cd remote-agent-control
npm run install:all
npm run build
```

### Claude Code

从仓库根目录运行安装脚本：

```bash
bash scripts/install-claude.sh
```

然后启动新的 Claude Code 会话并运行：

```text
/remote-agent-control setup
```

### Codex

从仓库根目录运行安装脚本：

```bash
bash scripts/install-codex.sh
```

如果你想保留可开发的本地仓库：

```bash
bash scripts/install-codex.sh --link
```

安装脚本会把 Skill 放到 `~/.codex/skills/remote-agent-control`，将核心库复制或链接到过渡依赖路径，
并自动安装依赖、构建两个包。

安装完成后，直接对 Codex 说：

```text
remote-agent-control setup
```

如果你主要想接微信，也可以直接说：

```text
帮我接微信桥接
```

### 验证安装

**Claude Code：** 启动新会话，输入 `/` 应能看到 `remote-agent-control`。也可以直接问 Claude："What skills are available?"

**Codex：** 启动新会话，说 `remote-agent-control setup`、`start bridge` 或 `帮我接微信桥接`。

## 更新 Skill

拉取或替换源码工作区后，从仓库根目录重新安装并构建两个包：

```bash
npm run install:all
npm run build
```

### Claude Code

如果你是通过符号链接安装，重建源码 checkout 后会立即生效。如果你是手动复制安装，
用新的 `Claude-to-IM-skill/` 目录替换 `~/.claude/skills/remote-agent-control`。

更新后重启 daemon。

更新完成后，对 Claude Code 说：

```text
/remote-agent-control doctor
/remote-agent-control start
```

### Codex

如果你是用 `install-codex.sh` 的复制模式安装的：

```bash
rm -rf ~/.codex/skills/remote-agent-control
bash scripts/install-codex.sh
```

如果你是用 `--link` 模式，重建源码 checkout 即可。

更新完成后，对 Codex 说：

```text
remote-agent-control doctor
start bridge
```

## 快速开始

### 1. 配置

**Claude Code**

```text
/remote-agent-control setup
```

**Codex**

```text
remote-agent-control setup
```

向导会引导你完成以下步骤：

1. **选择渠道** — 选择 Telegram、Discord、飞书、QQ、微信，或任意组合
2. **输入凭据** — 向导会详细说明如何获取每个 token、需要开启哪些设置、授予哪些权限
3. **设置默认值** — 工作目录、模型、模式
4. **验证** — 立即通过平台 API 验证 token 有效性

### 2. 启动

**Claude Code**

```text
/remote-agent-control start
```

**Codex**

```text
start bridge
```

守护进程在后台启动。关闭终端后仍会继续运行。

### 3. 开始聊天

打开 IM 应用，给你的机器人发消息，Claude Code / Codex 会通过桥接回复。

当 Claude 需要使用工具（编辑文件、运行命令）时，聊天中会弹出带有 **允许** / **拒绝** 按钮的权限请求（Telegram/Discord），或文本 `/perm` 命令提示 / 快捷 `1/2/3` 回复（飞书/QQ/微信）。

## 命令列表

所有命令在 Claude Code 或 Codex 中执行：

| Claude Code | Codex（自然语言） | 说明 |
|---|---|---|
| `/remote-agent-control setup` | "remote-agent-control setup" / "配置" | 交互式配置向导 |
| `/remote-agent-control start` | "start bridge" / "启动桥接" | 启动桥接守护进程 |
| `/remote-agent-control stop` | "stop bridge" / "停止桥接" | 停止守护进程 |
| `/remote-agent-control status` | "bridge status" / "状态" | 查看运行状态 |
| `/remote-agent-control logs` | "查看日志" | 查看最近 50 行日志 |
| `/remote-agent-control logs 200` | "logs 200" | 查看最近 200 行日志 |
| `/remote-agent-control reconfigure` | "reconfigure" / "修改配置" | 交互式修改配置 |
| `/remote-agent-control doctor` | "doctor" / "诊断" | 诊断问题 |

## 平台配置指南

`setup` 向导会在每一步提供内联指引，以下是概要：

### Telegram

1. 在 Telegram 中搜索 `@BotFather` → 发送 `/newbot` → 按提示操作
2. 复制 bot token（格式：`123456789:AABbCc...`）
3. 建议：`/setprivacy` → Disable（用于群组）
4. 获取 User ID：给 `@userinfobot` 发消息

### Discord

1. 前往 [Discord 开发者门户](https://discord.com/developers/applications) → 新建应用
2. Bot 标签页 → Reset Token → 复制 token
3. 在 Privileged Gateway Intents 下开启 **Message Content Intent**
4. OAuth2 → URL Generator → scope 选 `bot` → 权限选 Send Messages、Read Message History、View Channels → 复制邀请链接

### 飞书 / Lark

1. 前往[飞书开放平台](https://open.feishu.cn/app)（或 [Lark](https://open.larksuite.com/app)）
2. 创建自建应用 → 获取 App ID 和 App Secret
3. **批量添加权限**：进入"权限管理" → 使用批量配置添加所有必需权限（`setup` 向导提供完整 JSON）
4. 在"添加应用能力"中启用机器人
5. **事件与回调**：选择**长连接**作为事件订阅方式 → 添加 `im.message.receive_v1` 事件
6. **发布**：进入"版本管理与发布" → 创建版本 → 提交审核 → 在管理后台审核通过
7. **注意**：版本审核通过并发布后机器人才能使用

### QQ

> QQ 目前仅支持 **C2C 私聊**（沙箱接入）。不支持群聊/频道、内联权限按钮、流式预览。权限确认使用文本 `/perm ...` 命令。仅支持图片入站（不支持图片回复）。

1. 前往 [QQ 机器人 OpenClaw](https://q.qq.com/qqbot/openclaw)
2. 创建或选择已有 QQ 机器人 → 获取 **App ID** 和 **App Secret**（仅需这两个必填项）
3. 配置沙箱接入，用 QQ 扫码添加机器人
4. `CTI_QQ_ALLOWED_USERS` 填写 `user_openid`（不是 QQ 号）— 可先留空
5. 如果底层 provider 不支持图片输入，设置 `CTI_QQ_IMAGE_ENABLED=false`

### 微信 / Weixin

> 微信当前采用扫码登录、单账号模式、文本权限确认，不支持流式预览。

1. 在已安装的 Skill 目录里运行本地扫码工具：
   - Claude Code 默认安装：`cd ~/.claude/skills/remote-agent-control && npm run weixin:login`
   - Codex 默认安装：`cd ~/.codex/skills/remote-agent-control && npm run weixin:login`
2. 工具会生成 `~/.claude-to-im/runtime/weixin-login.html`，并尽量自动用浏览器打开
3. 用微信扫码并在手机上确认
4. 成功后，账号会保存到 `~/.claude-to-im/data/weixin-accounts.json`
5. 再次运行扫码工具，会替换当前已绑定的微信账号

补充说明：

- `CTI_WEIXIN_MEDIA_ENABLED` 只控制图片 / 文件 / 视频的入站下载
- 语音消息只使用微信自带的语音转文字结果
- 如果微信没有提供 `voice_item.text`，桥会直接报错，不会自行下载或转写原始语音
- 权限确认使用文本 `/perm ...` 命令或快捷 `1/2/3` 回复

## 架构

```
~/.claude-to-im/
├── config.env             ← 凭据与配置 (chmod 600)
├── data/                  ← 持久化 JSON 存储
│   ├── sessions.json
│   ├── bindings.json
│   ├── permissions.json
│   └── messages/          ← 按会话分文件的消息历史
├── logs/
│   └── bridge.log         ← 自动轮转，密钥脱敏
└── runtime/
    ├── bridge.pid          ← 守护进程 PID 文件
    └── status.json         ← 当前状态
```

### 核心组件

| 组件 | 职责 |
|---|---|
| `src/main.ts` | 守护进程入口，组装依赖注入，启动 bridge |
| `src/config.ts` | 加载/保存 `config.env`，映射为 bridge 设置 |
| `src/store.ts` | JSON 文件 BridgeStore（30 个方法，写穿缓存） |
| `src/llm-provider.ts` | Claude Agent SDK `query()` → SSE 流 |
| `src/codex-provider.ts` | Codex SDK `runStreamed()` → SSE 流 |
| `src/sse-utils.ts` | 共享的 SSE 格式化辅助函数 |
| `src/permission-gateway.ts` | 异步桥接：SDK `canUseTool` ↔ IM 按钮 |
| `src/logger.ts` | 密钥脱敏的文件日志，支持轮转 |
| `scripts/daemon.sh` | 进程管理（start/stop/status/logs） |
| `scripts/doctor.sh` | 诊断检查 |
| `SKILL.md` | Claude Code Skill 定义文件 |

### 权限流程

```
1. Claude 想使用工具（如编辑文件）
2. SDK 调用 canUseTool() → LLMProvider 发射 permission_request SSE 事件
3. Bridge 在 IM 聊天中发送内联按钮：[允许] [拒绝]
4. canUseTool() 阻塞等待用户响应（5 分钟超时）
5. 用户点击允许 → Bridge 解除权限等待
6. SDK 继续执行工具 → 结果流式发回 IM
```

## 故障排查

运行诊断：

```
/remote-agent-control doctor
```

检查项目：Node.js 版本、配置文件是否存在及权限、token 有效性（实时 API 调用）、日志目录、PID 文件一致性、最近的错误。

| 问题 | 解决方案 |
|---|---|
| `Bridge 无法启动` | 运行 `doctor`，检查 Node 版本和日志 |
| `收不到消息` | 用 `doctor` 验证 token，检查允许用户配置 |
| `权限超时` | 用户 5 分钟内未响应，工具调用自动拒绝 |
| `PID 文件残留` | 运行 `stop` 再 `start`，脚本会自动清理 |

详见 [references/troubleshooting.md](references/troubleshooting.md)。

## 安全

- 所有凭据存储在 `~/.claude-to-im/config.env`，权限 `chmod 600`
- 日志输出中 token 自动脱敏（基于正则匹配）
- 允许用户/频道/服务器列表限制谁可以与机器人交互
- 守护进程是本地进程，没有入站网络监听
- 详见 [SECURITY.md](SECURITY.md) 了解威胁模型和应急响应

## 开发

```bash
npm install        # 安装依赖
npm run dev        # 开发模式运行
npm run typecheck  # 类型检查
npm test           # 运行测试
npm run build      # 构建打包
```

## 许可

[MIT](LICENSE)
