# 设计文档:把 Claude/Codex 选择题以"真实选项按钮"转发到 IM

- 日期:2026-06-19
- 状态:已批准设计,待写实现计划
- 适用仓库:`Projects/Claude-to-IM`(单仓双包)
  - 核心包:`Claude-to-IM/`(`remote-agent-control-core`)
  - skill 包:`Claude-to-IM-skill/`(provider 层)

## 1. 问题陈述

当前所有工具调用——包括 Claude 的选择题工具 `AskUserQuestion` 和计划确认
`ExitPlanMode`——都经由 skill 包的单一 `canUseTool` 回调
(`Claude-to-IM-skill/src/llm-provider.ts:484`)统一转成"权限请求"事件,
在 IM 端被渲染成固定的 `Allow / Allow Session / Deny` 三按钮卡片
(`Claude-to-IM/src/lib/bridge/permission-broker.ts:106`)。

后果:
- **选择题**:真实选项(`input.questions[].options[].label`)被丢弃,用户在手机上
  看到的是 Allow/Deny,无法做出实际选择。
- **计划确认**:`ExitPlanMode` 被标成 Allow/Deny,语义错位(本应是"批准计划/继续完善")。

Codex 后端(`@openai/codex-sdk`)经核对其 `dist/index.d.ts` 全部类型,**没有任何
审批回调或选择题/elicitation 事件**,只有单向事件流 + `approvalPolicy` 枚举。Codex
要提问时只能发一条纯文本 `agent_message` 并结束回合,**没有可拦截的结构化选择机制**。

## 2. 目标与非目标

### 目标
- Claude 的 `AskUserQuestion`(单选)在 IM 端渲染为"每个选项一颗按钮"的卡片;用户
  点击后,所选项作为答案回灌模型,会话继续。
- Claude 的 `ExitPlanMode` 渲染为"批准计划 / 继续完善"两颗语义正确的按钮。
- Codex 通过"提示词契约 + 解析 + 文本兜底"获得尽可能一致的体验(体验优先)。
- 全部 5 个渠道可用:Telegram / Discord / Feishu 用按钮;QQ / WeChat 用编号文本回复。
- 默认开启(无需配置开关)。

### 非目标(本期)
- **multiSelect 问题**:不拦截,降级为纯文本(模型按 IM 无结构化 UI 的常规方式提问,
  用户自然语言回复)。
- 多问题的并行卡片:1–4 个问题**串行**逐个处理(一张卡确认后再发下一张)。
- Codex 端不做 SDK 改造(SDK 无回调,无法拦截)。

## 3. 核心洞察

权限请求与选择题的**传输机制完全相同**:阻塞流 → 转发交互卡片 → 等待点击 →
resolve 挂起的 Promise。差异仅两点:**卡片渲染**(选项按钮 vs Allow/Deny)与
**答案翻译**(选中 label vs allow/deny)。因此采用**方案 A:扩展现有权限通道**,
用判别字段 `kind` 复用全部去重/链接存储/安全校验/超时/多渠道渲染机制。

## 4. 协议设计

### 4.1 判别字段

在 `permission_request` SSE 事件载荷与 `PermissionRequestInfo` 上新增:

```ts
kind: 'permission' | 'question' | 'plan'   // 缺省 'permission',向后兼容
choices?: Array<{ index: number; label: string; description?: string }>  // kind=question
questionText?: string                       // kind=question:问题正文
planSummary?: string                        // kind=plan:计划摘要
```

`canUseTool` 按工具名分流:

| 工具 | kind | 卡片 | 按钮 |
|------|------|------|------|
| 普通工具 | `permission` | 现状不变 | Allow / Allow Session / Deny |
| `AskUserQuestion`(单选) | `question` | 问题文本 + 选项 | 选项 1..N(2–4) |
| `AskUserQuestion`(multiSelect) | —(不拦截) | 降级纯文本 | 无 |
| `ExitPlanMode` | `plan` | 计划摘要 | 批准计划 / 继续完善 |

### 4.2 回调格式(复用 `perm:` 前缀)

沿用现有 `perm:action:id` 解析(Feishu 读 `value.callback_data`,Telegram 读 `cb.data`):

- 选项选择:`perm:choice:<index>:<permId>`
- 计划:`perm:plan_approve:<permId>` / `perm:plan_revise:<permId>`
- 数字文本回复:现有 `1/2/3` 路径(`bridge-manager.ts:1698`)扩展为 `1..N` → 映射为
  对应 `choice` index(plan 卡:`1`=批准,`2`=继续完善)。

### 4.3 答案回灌机制(⚠️ 由真实 SDK spike 先行确定)

候选两种,**以 spike 实测的模型行为为准**:

1. **deny-with-message**:`{behavior:'deny', message:'User selected: <label>'}`。简单,
   但模型视为"拒绝+附言"。
2. **allow-with-updatedInput**:`{behavior:'allow', updatedInput:{…}}`,令
   `AskUserQuestion` 工具本地执行并把选择作为工具结果返回。语义更正确。

多问题时,串行收集每个问题的选中项,在最后一个问题被解析后组装成完整答案返回。
spike 仅验证此回灌点;卡片/回调/降级逻辑不依赖该结论,可并行实现。

### 4.4 Codex 提示词契约

在传给 Codex 的 system 指令追加一段**条件契约**:当需要用户在固定选项中选择时,
输出一个围栏块:

````
```cti-choice
{ "question": "...", "options": ["A", "B", "C"] }
```
````

bridge 在 Codex 的 `agent_message` 文本中检测该围栏块:
- **检测到** → 解析为 `choices[]` → 复用同一张选项卡 → 用户点击 → 选中 label 作为
  **下一轮**输入发回 Codex(Codex 无回合内回调,只能跨回合)。
- **未检测到** → 完全降级为今天的纯文本行为(保底,确保不回退/不破坏)。

## 5. 组件与文件边界

### skill 包(`Claude-to-IM-skill/`)
- `src/llm-provider.ts`:`canUseTool` 增加工具名分流;按 `kind` enqueue 带
  `choices/questionText/planSummary` 的 `permission_request`;按 spike 结论实现答案回灌。
- `src/codex-provider.ts`:注入 system 契约;在 `handleCompletedItem` 的 `agent_message`
  分支检测 `cti-choice` 围栏块,检测到则 enqueue `question` 事件,否则原样透传文本。
- `src/permission-gateway.ts`:`PermissionResolution` 扩展以携带选项答案
  (`selectedIndex`/`selectedLabel`)。

### 核心包(`Claude-to-IM/src/lib/bridge/`)
- `host.ts`:扩展 `PermissionResolution` 与 permission-request 相关类型,加入 `kind`/
  `choices`/`questionText`/`planSummary`。
- `conversation-engine.ts`:`PermissionRequestInfo` 与 `permission_request` 解析透传新字段。
- `permission-broker.ts`:`forwardPermissionRequest` 按 `kind` 渲染不同卡片;
  `handlePermissionCallback` 处理 `choice`/`plan_approve`/`plan_revise` 动作。
- `markdown/feishu.ts`:新增/扩展卡片构造,支持 N 颗选项按钮与计划双按钮。
- `bridge-manager.ts`:数字文本回复路径由 `1/2/3` 扩展为 `1..N`,按 pending link 的
  `kind` 映射动作。
- `types.ts`:permission-link 记录加 `kind` 及可选 `choices` 序列化字段。
- `host.ts` 的 `BridgeStore` / skill 包 `store.ts`:permission-link 存储新增字段。

### 渠道渲染
- 按钮渠道(TG/Discord/Feishu):N 颗选项按钮 + 计划双按钮。
- 文本渠道(QQ/WeChat):问题 + 编号选项列表,`1..N` 回复。

## 6. 错误处理与边界

- **超时**:复用现有 5 分钟超时;选择题超时按"未选择"处理(Claude:deny 透传超时信息;
  Codex:无操作,等用户下一条消息)。
- **去重**:复用 `recentPermissionForwards` 与 permission-link `resolved` 原子标记。
- **安全**:复用 chat-id + message-id 双重校验;多问题串行卡片各自独立 permId。
- **越界 index**:回调携带的 index 超出 choices 范围 → 拒绝并提示重选。
- **Codex 围栏块畸形**:JSON 解析失败 → 视为未检测到 → 文本兜底。
- **向后兼容**:`kind` 缺省 `permission`,旧路径与现有测试不受影响。

## 7. 测试与验收策略(Tests + 1 live SDK spike)

### 7.1 Mock SDK 单元/集成测试(CI 可重复)
- `AskUserQuestion`(单选)→ 正确的 `question` 卡片载荷(问题 + N 选项)。
- `AskUserQuestion`(multiSelect)→ 走纯文本降级,不产生选项卡。
- `ExitPlanMode` → `plan` 卡片(批准/继续完善)。
- 按钮回调 `perm:choice:<i>:<id>` 与数字回复 `1..N` → 解析出正确答案并回灌。
- 计划回调 `plan_approve` / `plan_revise` → 正确 resolution。
- 多问题串行:第 1 张解析后才发第 2 张;全部解析后组装完整答案。
- Codex:注入契约文本;`cti-choice` 围栏块 → `question` 事件;无块 → 文本透传。
- 越界 index、畸形 JSON、超时等边界。

### 7.2 真实 SDK spike(一次性,非 CI)
- 用真实 Claude SDK 跑一次 `AskUserQuestion`,分别试 deny-with-message 与
  allow-with-updatedInput,**确定模型实际把哪种当作答案并自然继续**。
- 结论写回本 spec §4.3 并据此定稿实现。
- 由独立 subagent 执行并回报结果;无需真实 IM。

### 7.3 验收
- 全部新增测试通过 + 两个包既有测试不回归。
- spike 结论明确且已落到实现。
- 由 code-review subagent 对照本 spec 复核改动。

## 8. 决策记录(用户拍板)

- Codex:提示词契约 + 解析 + 文本兜底(体验优先)。
- 范围:单选,一张卡一张卡来;`ExitPlanMode` 纳入;multiSelect 降级文本。
- 验收:Tests + 1 live SDK spike。
- 灰度:默认开启(无开关)。
- 方案:A(扩展现有权限通道,`kind` 判别)。

## 9. 风险

- **回灌机制不确定**:已用 spike 前置消解(实现前先验证)。
- **Codex 不遵守契约格式**:文本兜底确保最差等同现状,不回退。
- **"permission"语义被用宽**:可接受,后续可改名(对应方案 C,本期不做)。
- **多渠道按钮差异**:文本渠道用编号回复对齐,逻辑集中在 broker/bridge-manager。
