# `/sandbox` 命令 — 设计与实施计划

> 状态：待开发
> 作者：架构调研稿（2026-05-27）
> 涉及目录：`Claude-to-IM/`（Remote Agent Control core 过渡路径）+ `Claude-to-IM-skill/`（skill 包过渡路径，含 codex/copilot provider）

---

## 1. 背景与动机

桥接服务（remote-agent-control）支持三种后端：`codex` / `claudecode` (alias `claude`) / `copilot`，可通过 `/backend <name>` 在同一 binding 内按"后端独立 lane"切换，且不丢失各自的 session。

实测中发现 **Codex 后端默认是只读的**——用户让它改文件时它会回答"我不能写"。原因如下文 §2。

我们希望提供一个 **`/sandbox <值>`** 命令，能在**不切换 session、不重建 thread**的前提下，per-binding 地切换"工具能力上限"（只读 / 读写 / 完全权限）。

### 现有命令对照

| 命令 | 作用 | 维度 |
|---|---|---|
| `/backend <codex\|claude\|copilot>` | 切后端 lane | 后端选择 |
| `/mode <code\|ask\|plan>` | 切工作风格（影响 approval） | 是否每步问 |
| `/verbose <quiet\|normal\|verbose>` | 切输出详尽度 | 转发节流 |
| **`/sandbox <ro\|rw\|full>`**（待加） | **切工具权限上限** | **能不能做** |

`/mode` 与 `/sandbox` **正交**：前者管"问不问"，后者管"做不做"。当前 Codex 默认 `read-only` 实际上把 `/mode code` 的"自动通过"也变成无意义——通过了也写不动。

---

## 2. 各后端调研结果

### 2.1 Codex（`@openai/codex-sdk`）

SDK 类型定义（`node_modules/@openai/codex-sdk/dist/index.d.ts`）：

```ts
type ApprovalMode = "never" | "on-request" | "on-failure" | "untrusted";
type SandboxMode  = "read-only" | "workspace-write" | "danger-full-access";

type ThreadOptions = {
  model?: string;
  sandboxMode?: SandboxMode;          // ← 关键字段
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  approvalPolicy?: ApprovalMode;
  ...
};
```

**当前 `Claude-to-IM-skill/src/codex-provider.ts` 完全没有传 `sandboxMode`。** Codex CLI 在非交互（`exec`）模式下默认就是 `read-only`，所以现状是"只能读"。

`approvalPolicy` 控制"动作要不要弹审批"，`sandboxMode` 控制"动作能不能执行"——两者独立。即使 `approvalPolicy=on-failure`（自动批准失败重试），sandbox 是 `read-only` 仍然写不了。

切换不丢 session：`Codex.resumeThread(threadId, threadOptions)` 接受每次新的 options，**不会重建对话历史**。我们已经在用这条路径，只要在 `threadOptions` 里多塞 `sandboxMode` 即可。

### 2.2 Claude Code（CC，`@anthropic-ai/claude-code` SDK）

CC 没有独立的 sandbox 字段，只有一个 `permissionMode`：

| permissionMode | 含义 |
|---|---|
| `default` | 每步问用户 |
| `acceptEdits` | 自动批准编辑、写文件、bash |
| `plan` | 只读规划，不写不执行 |
| `bypassPermissions` | 全部跳过，等价 danger-full-access |

bridge 现有映射（`conversation-engine.ts` ~L153）：
- `binding.mode='code'` → `acceptEdits`
- `binding.mode='plan'` → `plan`
- `binding.mode='ask'`  → `default`

**结论：CC 在 `mode=code` 默认就是可写的，本期不需要额外做什么；但 `/sandbox` 要在 CC 上仍然语义一致，需要按下文 §3.3 的方式覆盖 `permissionMode`。**

### 2.3 Copilot CLI

`Claude-to-IM-skill/src/copilot-provider.ts` 通过 `--no-tools` 一刀切关掉所有工具，由全局环境变量 `CTI_COPILOT_ALLOW_TOOLS=true` 控制。Copilot CLI 还有 `--allow-tool` / `--deny-tool` 做细粒度名单，但**没有 read-only vs workspace-write 这种分级**。

**结论：Copilot 只能"全开"或"全关"，`/sandbox` 在 Copilot 上退化为二值。**

---

## 3. 设计建议

### 3.1 命令形态

```
/sandbox ro      # 别名: read, readonly
/sandbox rw      # 别名: write, workspace（默认值）
/sandbox full    # 别名: admin, danger
/sandbox         # 不带参数 → 显示当前值
```

- per-binding 持久化到 store（与 `/backend`、`/verbose` 同模式）
- **不重建 session**：仅在下一次 `processMessage` 时把当前 `sandboxMode` 注入到对应 provider 的 options
- 切换后回复一条短消息：`沙箱权限已设为：rw（可读写）`

### 3.2 默认值

**`rw`（workspace-write）**。理由：
- 用户在 IM 里通常是让 AI 干活（写代码、改文件），只读违反直觉
- 安全边界由 `workingDirectory` 限定，workspace-write 不会越界到系统目录
- 与 Claude Code `acceptEdits` 默认行为对齐
- 想严格的人可手动 `/sandbox ro`

### 3.3 三后端映射表

| `/sandbox` | Codex `sandboxMode` | CC `permissionMode` 覆盖逻辑 | Copilot |
|---|---|---|---|
| `ro`   | `read-only`          | **强制** `plan`（覆盖 `/mode` 的映射） | `--no-tools` |
| `rw`   | `workspace-write`    | 按 `/mode` 走原映射（acceptEdits/default/plan） | 启用工具（去掉 `--no-tools`） |
| `full` | `danger-full-access` | **强制** `bypassPermissions`            | 启用工具（去掉 `--no-tools`，可选 `--allow-all-tools`） |

注意细节：
- CC 在 `ro` 下必须强制 `plan`，否则用户开 `/mode code` 时 CC 仍会写文件（因为 CC 自己不区分 sandbox vs approval）。
- Copilot `ro` 时无视环境变量 `CTI_COPILOT_ALLOW_TOOLS`——binding 设置优先。
- Codex 不需要因 `/sandbox` 改 `approvalPolicy`，两者独立。

### 3.4 与 `/mode` 的交互

- `/mode` 决定 approval 策略（影响 Codex `approvalPolicy`、CC 在 `rw` 下的 permissionMode 选择）
- `/sandbox` 决定能力上限（影响 Codex `sandboxMode`、CC 的强制覆盖、Copilot 的 tools 开关）
- 两者独立切换，互不重置

---

## 4. 实施计划

### 4.1 数据模型（Remote Agent Control 主仓）

**文件：** `src/lib/bridge/types.ts`

```ts
export type SandboxLevel = 'ro' | 'rw' | 'full';

export interface ChannelBinding {
  // ... 现有字段
  sandboxLevel?: SandboxLevel;       // 默认 'rw'
}
```

**Store 迁移：** 在 `JsonStore`（或对应实现）里给 binding 新增 `sandboxLevel` 字段，读时 fallback 到 `'rw'`，写时持久化。无需 schema migration，因为是 JSON 存储 + 可选字段。

### 4.2 命令解析（Remote Agent Control 主仓）

**文件：** `src/lib/bridge/bridge-manager.ts`（参照 `/backend`、`/verbose` 的位置）

新增 `handleSandboxCommand(binding, arg)`：
- 支持 `ro|read|readonly` / `rw|write|workspace` / `full|admin|danger`
- 空参数返回当前值
- 持久化到 store
- 回复一条短消息（中文：`沙箱权限已设为：rw（可读写）`）
- **不重置 backend lane、不清 session id、不调 `resetChatState`**

### 4.3 传参到 provider（Remote Agent Control 主仓）

**文件：** `src/lib/bridge/host.ts`

`StreamChatParams` 增加可选字段：
```ts
sandboxLevel?: 'ro' | 'rw' | 'full';
```

**文件：** `src/lib/bridge/conversation-engine.ts`（~L182 `llm.streamChat({...})` 调用点）

把 `binding.sandboxLevel ?? 'rw'` 透传给 provider。

CC 的 `permissionMode` 计算（~L153）调整为：

```ts
const baseMode = binding.mode;          // code/ask/plan
const sandbox  = binding.sandboxLevel ?? 'rw';

let permissionMode: string;
if (sandbox === 'ro')   permissionMode = 'plan';
else if (sandbox === 'full') permissionMode = 'bypassPermissions';
else {  // rw: 按 mode 走
  switch (baseMode) {
    case 'plan': permissionMode = 'plan'; break;
    case 'ask':  permissionMode = 'default'; break;
    default:     permissionMode = 'acceptEdits';
  }
}
```

### 4.4 Codex provider（skill 包）

**文件：** `src/codex-provider.ts` `streamChat` 内构造 `threadOptions` 的位置（~L131）：

```ts
const sandboxLevel = params.sandboxLevel ?? 'rw';
const codexSandbox =
  sandboxLevel === 'ro'   ? 'read-only' :
  sandboxLevel === 'full' ? 'danger-full-access' :
                            'workspace-write';

const threadOptions: Record<string, unknown> = {
  ...(passModel && params.model ? { model: params.model } : {}),
  ...(params.workingDirectory ? { workingDirectory: params.workingDirectory } : {}),
  ...(shouldSkipGitRepoCheck() ? { skipGitRepoCheck: true } : {}),
  sandboxMode: codexSandbox,           // ← 新增
  approvalPolicy,
};
```

**关键：** 复用 `resumeThread(savedThreadId, threadOptions)` 路径——SDK 每次都接受新 options，**thread 历史不丢**。

### 4.5 Copilot provider（skill 包）

**文件：** `src/copilot-provider.ts`

`shouldAllowTools()` 改为接受 binding sandboxLevel 参数（或在 `streamChat` 里直接判定）：

```ts
const sandboxLevel = params.sandboxLevel ?? 'rw';
const allowTools = sandboxLevel !== 'ro' && (
  sandboxLevel === 'full' || shouldAllowTools()   // 'full' 强制开；'rw' 看环境变量
);
if (!allowTools) {
  args.push('--no-tools');
}
```

> 备选更激进策略：`rw` 也强制开工具、忽略环境变量。需要产品同学定。

### 4.6 帮助文本与文档

- `bridge-manager.ts` 中 `/help` 的回复加一行 `/sandbox <ro|rw|full> — 切换工具权限上限`
- `README.md` / `README.zh-CN.md` 命令表补一行
- `docs/development.md` 在 binding 字段表补 `sandboxLevel`

### 4.7 测试

主仓 `Claude-to-IM/tests`：
- `bridge-manager` 单测：`/sandbox ro` → store 写入 `'ro'`、回复正确文本、**不调** `adapter.resetChatState`
- `conversation-engine` 单测：`sandboxLevel='ro'` + `mode='code'` → 传给 provider 的 `permissionMode` 是 `'plan'`（CC 路径）
- 边界：`/sandbox xxx`（非法值）→ 回复用法提示，不修改 store

Skill 仓 `Claude-to-IM-skill/tests`：
- `codex-provider`：mock `Codex.resumeThread`，断言收到的 `threadOptions.sandboxMode` 等于映射后的值
- `copilot-provider`：断言 `ro` 下 `args` 含 `--no-tools`，`rw`/`full` 下不含

### 4.8 不做的事（明确划出）

- ❌ 不做 per-tool 黑白名单（Copilot 的 `--allow-tool`/`--deny-tool`）——本期超纲
- ❌ 不引入 `networkAccessEnabled` 切换——和 sandbox 是另一根线，未来另开 `/network on|off`
- ❌ 不把 `/sandbox` 持久化为"全局默认"——只 per-binding（与 `/backend`、`/verbose` 一致）

---

## 5. 验收清单

- [ ] `/sandbox ro|rw|full|<alias>` 命令解析正确，非法值有提示
- [ ] 不带参数 `/sandbox` 显示当前值
- [ ] 切换后 binding 的 `backend`/`sdkSessionId`/`codexThreadId` 等**全部保留**
- [ ] Codex 在 `rw` 下能写文件，在 `ro` 下回复"我无权写"
- [ ] CC 在 `/mode code` + `/sandbox ro` 下不会写文件
- [ ] Copilot 在 `ro` 下走 `--no-tools`，`rw` 下能跑工具
- [ ] `/mode` 与 `/sandbox` 互切不会相互重置
- [ ] 主仓 + skill 仓所有 typecheck + 单测通过
- [ ] README / development.md / `/help` 文档同步

---

## 6. 风险与注意事项

1. **secret 不入日志/计划/fixtures**：测试中不要把真实 Feishu App Secret、provider token、Codex API key 写进 mock。
2. **Codex SDK 版本兼容**：当前依赖 `@openai/codex-sdk`（已安装的 `index.d.ts` 包含 `sandboxMode`）。升级前需确认仍存在该字段。
3. **CC `bypassPermissions` 的危险性**：`/sandbox full` 在 CC 上等价跳过所有审批，需要在 `/help` 文案中明确警告。
4. **Copilot 退化的两值**：用户在 Copilot 下选 `full` 与 `rw` 行为一致——文档需注明此限制，避免误解。
5. **向后兼容**：旧 binding 没有 `sandboxLevel` 字段，读出 `undefined` 一律按 `'rw'` 处理；不要给老用户惊喜地变只读。

---

## 7. 参考文件

- `Claude-to-IM-skill/src/codex-provider.ts`（threadOptions 注入点 ~L131）
- `Claude-to-IM-skill/src/copilot-provider.ts`（`shouldAllowTools` + args 拼装 ~L46-57）
- `Claude-to-IM/src/lib/bridge/conversation-engine.ts`（permissionMode 映射 ~L153，streamChat 调用 ~L182）
- `Claude-to-IM/src/lib/bridge/bridge-manager.ts`（`/backend`、`/verbose` 命令处理位置——参照实现 `/sandbox`）
- `node_modules/@openai/codex-sdk/dist/index.d.ts`（`ThreadOptions` / `SandboxMode` 类型）
