# seekHarness 上下文（Context）设计分析

> 分析当前 Agent 上下文管理的现状、问题以及改进方向。

## 当前上下文模型

### 数据结构

```
AgentSession
├── workspaceRoot      // 工作目录
└── messages[]         // 对话历史（ChatCompletionMessageParam）
    ├── { role: "system",    content: SYSTEM_PROMPT [+ Agents.md] }
    ├── { role: "user",      content: "帮我看看 xxx" }
    ├── { role: "assistant", content: "...", tool_calls: [...] }
    ├── { role: "tool",      content: "<read 结果，可能几千行>" }
    ├── { role: "assistant", content: "...", tool_calls: [...] }
    ├── { role: "tool",      content: "<bash 结果，可能上万行>" }
    ├── ...
    └── { role: "user",      content: "继续" }
```

### 数据流

```
runAgentTurn(session, userMessage)
   1. push user msg → session.messages
   2. 传整个 session.messages 给 LLM API
   3. LLM 回复 → push assistant msg → session.messages
   4. 执行工具 → push tool result → session.messages
   5. 回到 2（直到 maxTurns 或无工具调用）
```

## 问题分析

### 问题 1：上下文窗口无限膨胀 ⚠️ 最严重

**现象**：`session.messages` 只增不减，没有裁剪机制。

**具体表现**：
- `read` 一个 2000 行的文件 → tool result 完整保存在 messages 里，后续每轮对话都发给 LLM
- `bash` 一个构建命令（几万行输出）→ tool result 完整保存
- 多轮对话后，messages 数组持续增长，旧消息不再有用但仍然占 token

**后果**：
- 浪费 LLM context window（128k-200k tokens）
- token 消耗过高 → 成本上升、速度变慢
- 旧工具输出会"稀释"当前真正需要关注的信息
- 极端情况下达到 API 的 context window 上限导致请求失败

### 问题 2：System Prompt 与 Tool Definitions 内容重复

**现象**：工具说明同时出现在两个地方。

```ts
// [src/agent/loop.ts] SYSTEM_PROMPT 文本版
const SYSTEM_PROMPT = `...
- read:    read a file (workspace-relative path)
- write:   create or overwrite a file...
- bash:    run a shell command...
...`;

// [src/agent/loop.ts] 调用 LLM 时又传一份
const assistantMsg = await streamChatWithTools(
  client, llmConfig,
  messages,
  registry.definitions,  // ← 这里传了工具的 JSON schema 定义
  ...
);
```

OpenAI / Anthropic API 在传 `tools` 参数时已经会告诉 LLM 每个工具的名称、参数、描述。system prompt 里再用文本写一遍等于重复消耗 token。

### 问题 3：System Prompt 结构扁平

当前 system prompt 把所有信息平铺在一个字符串里：

```
身份 + 工具列表 + 工作流 + 安全规则 + 约束 + Agents.md
```

这些信息有不同的**重要层级**和**变更频率**：

| 信息 | 层级 | 变更频率 |
|---|---|---|
| Agent 身份 | 高 | 几乎不变 |
| 工具列表 | 高 | 新增工具时才变 |
| 工作流步骤 | 中 | 迭代时调整 |
| 安全策略 | 高 | 几乎不变 |
| 约束条件 | 中 | 随工具调整 |
| Agents.md | 高（按需） | 用户随时可能改 |

混在一起导致：
- LLM 可能忽略后半部分的内容（"中间迷失"问题）
- 修改某一部分时需要动整个字符串
- Agents.md 内容在长 system prompt 中容易被淹没

### 问题 4：Agents.md 只在 Session 启动时加载

```ts
function createAgentSession(workspaceRoot, systemPrompt?) {
  // 读取 Agents.md（仅在创建 session 时）
  const agentsMdPath = path.join(workspaceRoot, "Agents.md");
  // ... 读到后塞进 system message
}
```

用户修改了 `Agents.md` 后需要重启 `seekharness` 才生效。对于长期运行的 REPL 会话来说不够灵活。

### 问题 5：工具结果缺乏大小控制

工具执行结果无论多大都原样放进 messages：

```ts
const result = await registry.run(fn.name, args, toolCtx);
const content = result.success ? result.output : `Error: ${result.output}`;

// 直接 push 进 messages，不做截断
return {
  role: "tool",
  tool_call_id: call.id,
  content,  // 可能是几万行的文本
};
```

`bash` 工具虽然有溢出文件机制（超过 30000 字符写到临时文件），但 messages 里存的仍是完整输出。

## 改进方向

### 方向 A：消息预算管理（预算裁剪）

为 session 引入一个 token 预算概念。当累积的消息超过预算时，对旧消息进行处理。

**策略选项**：

```
A1. 滑动窗口
    保留最近的 N 条消息，移除中间的工具结果。

A2. 摘要压缩
    对早期的工具调用链，让 LLM 生成一段摘要替代原始消息。
    "你之前做了：find schema → read models.py → update field type"

A3. 分层保留
    保留 system message + 最近 1-2 轮完整对话
    中间轮次只保留 assistant 回复，丢弃工具结果
```

**推荐：先做 A1，简单有效。**

保留：
- system message（始终保留）
- 最近 2 轮 user + assistant + tool 的完整对话
- 第一轮 user message（不丢失原始目标）

裁剪：
- 删除中间轮次的 tool result（bash 输出、read 内容等）
- 在删除位置插入一条压缩提示：`[turn 3-5 的工具结果已裁剪，共 ~12k tokens]`

### 方向 B：精简 System Prompt

去掉 system prompt 中的工具文本描述，只保留：

```
身份 + 工作流 + 安全规则 + 约束
```

因为工具的完整定义已经通过 API 的 `tools` 参数传给 LLM 了。

当前 system prompt 约 1000 tokens，精简后估计 300-400 tokens，省 60%。

### 方向 C：工具结果自动截断

在 `handleToolCall`（或 `registry.run` 返回时）对大结果做截断：

```ts
const MAX_TOOL_OUTPUT_LENGTH = 4000;

const content = result.success
  ? (result.output.length > MAX_TOOL_OUTPUT_LENGTH
      ? result.output.slice(0, MAX_TOOL_OUTPUT_LENGTH) +
        `\n\n[... output truncated at ${MAX_TOOL_OUTPUT_LENGTH} chars; full output saved to temp file]`
      : result.output)
  : `Error: ${result.output}`;
```

注意这里和 bash 的 30000 字符溢出文件机制的关系——bash 已经在 tool 层做了文件溢出，context 层再做截断是**第二道防线**。

### 方向 D：Agents.md 热加载

在 REPL 中每次 `runAgentTurn` 前重新读取 `Agents.md`，如果内容变了就更新 system message。

或者在 `/clear` 时或 `/reload` 命令时重新加载。

### 方向 E：结构化 System Prompt

将 system prompt 拆分为多个 system message（OpenAI API 支持多条 system message），或使用明确的标记分隔不同区域。

```ts
messages = [
  { role: "system", content: "你是 seekHarness..." },           // 身份
  { role: "system", content: "工作流：1. ..." },                  // 流程
  { role: "system", content: "## Agents Context\n${agentsMd}" }, // 用户上下文
];
```

实验表明，多条 system message 可以帮助 LLM 更好地区分不同层级的指令。

## 落地建议

### Phase 1（立即可做）

1. **工具结果截断**（方向 C）—— `src/agent/loop.ts` 中 `handleToolCall` 返回前截断，改动最小，见效快
2. **精简 System Prompt**（方向 B）—— 删除 SYSTEM_PROMPT 中的工具文本列表

### Phase 2（短期）

3. **滑动窗口裁剪**（方向 A1）—— 引入 `maxContextMessages` 配置，超过后裁剪中间工具结果
4. **Agents.md 热加载**（方向 D）—— REPL 每次 `runTurn` 前检查文件变更

### Phase 3（中长期）

5. **摘要压缩**（方向 A2）—— 让 LLM 定期总结进度
6. **结构化 System Prompt**（方向 E）—— 多条 system message 分层管理

## 相关代码

| 文件 | 职责 |
|---|---|
| [src/agent/loop.ts](../src/agent/loop.ts) | `createAgentSession`（system prompt 组装 + Agents.md 加载），`runAgentTurn`（消息循环），`handleToolCall`（结果处理） |
| [src/cli/ReplApp.tsx](../src/cli/ReplApp.tsx) | REPL UI，调用 `createAgentSession` 和 `runAgentTurn`，处理 `/clear` |
| [src/eval/run.ts](../src/eval/run.ts) | Eval 模式下使用 `createAgentSession` + `runAgentTurn` |
| [src/tools/types.ts](../src/tools/types.ts) | `ToolContext` 接口 |
