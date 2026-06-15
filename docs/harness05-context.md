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

---

## 改进方案：两条防线

```
┌──────────────────────────────────────────────────────────────────┐
│                   发送给 LLM 之前的 messages                       │
│                                                                  │
│   [system] [user1] [asst1] [tool1] [user2] [asst2] [tool2] ...  │
│                                       │                          │
│   ┌───────────────────────────────────┘                          │
│   ▼                                                              │
│   防线1：工具结果截断（源头控制）                                  │
│   → 每个 tool result 写入时，超过阈值就截断 + 存文件               │
│                                                                  │
│   ┌───────────────────────────────────┐                          │
│   ▼                                   ▼                          │
│   防线2：历史消息裁剪（墙钟时间 eviction）                           │
│   → 超过 5 分钟的 tool result 自动裁掉，user/assistant 不动          │
└──────────────────────────────────────────────────────────────────┘
```

### 防线 1：工具结果截断（方向 C）

在工具结果写入 messages **之前**做截断，同时写入完整文件：

```ts
const MAX_PREFIX = 3000;
const MAX_SUFFIX = 2000;
const MAX_TOTAL = MAX_PREFIX + MAX_SUFFIX + 200; // ~5200

async function truncateOutput(
  output: string,
  toolName: string,
  outputDir?: string,
): Promise<string> {
  if (output.length <= MAX_TOTAL) return output;

  const prefix = output.slice(0, MAX_PREFIX);
  const suffix = output.slice(-MAX_SUFFIX);
  const truncatedLen = output.length - MAX_PREFIX - MAX_SUFFIX;

  // 写完整输出到文件（LLM 可按需 read）
  let filePath = ".seekharness/output.txt";
  if (outputDir) {
    await fs.mkdir(outputDir, { recursive: true });
    const filename = `${toolName}-${Date.now()}-${randomBytes(4).toString("hex")}.txt`;
    filePath = path.join(outputDir, filename);
    await fs.writeFile(filePath, output, "utf-8");
  }

  return [
    prefix,
    `\n\n[... ${truncatedLen.toLocaleString()} chars truncated; `,
    `full ${toolName} output saved to: ${filePath}]\n\n`,
    suffix,
    '\n\n[Use the read tool with the path above to see full output]',
  ].join('');
}
```

**为什么截断而不是全量存文件？**
- LLM 需要看到工具结果的**开头**（知道执行了什么）和**结尾**（知道结果/错误）
- 中间的详细输出是"按需查阅"的，不是每轮都需要
- 截断后的消息很小，可以留在 messages 中很久不被裁

**与 bash 30000 字符溢出机制的关系：**

| 层 | 位置 | 阈值 | 行为 |
|---|---|---|---|
| tool层 (bash) | `bash` 工具内部 | 30k chars 溢出 | 完整写入文件；messages 存完整内容 + 文件路径 |
| context层 (防线1) | `handleToolCall` | ~5k chars 截断 | 保留首尾 + 文件路径；**第二道防线** |

两层可以共存：bash 存完整文件，context 层做截断。即使 bash 未来改成了流式输出（不存文件），context 层的截断仍然兜底。

**截断后的信息流：**

```
bash("npm test") 输出 50000 chars
        │
        ▼
tool层：写完整文件 .seekharness/output_xxx.txt
        │
        ▼
context层：截断后存入 messages
  "[npm test 输出开头...] ...truncated... [npm test 输出结尾...]"
  "Use read .seekharness/output_xxx.txt to see full output"
        │
        ▼
LLM 看到截断内容 → 如果发现关键信息被截了 → 调用 read 工具读取完整文件
```

---

### 防线 2：历史消息裁剪 — Content Eviction（Claude Code 风格）

#### 核心思路

不动消息结构，只替换旧 tool 结果的 content。

```
Tool 消息还在，assistant 的 tool_calls 还在，用户消息还在。
但旧 tool 的 content 变成 "[Old tool result cleared]"。
```

这样 API 校验永远不会失败——每条 `tool_call_id` 都有对应的 `tool` 消息回应，但 content 变短了，省 token。

**策略**：收集所有 `tool_call_id`（按 assistant 出现的顺序），保留最近 5 个，清空更早的。

#### 为什么不是删消息或按时间裁？

| 方案 | 问题 |
|------|------|
| 删 tool 消息 | 对应的 assistant `tool_calls` 悬空 → API 400 |
| 删 tool + 清 assistant `tool_calls` | 复杂，要考虑各种边界 |
| 按墙钟时间裁 | 依赖时间戳持久化，会话恢复麻烦 |
| **只清 content（本方案）** | **消息结构不变，API 永远通过，实现最简单** |

#### 实现

```ts
const KEEP_RECENT = 5; // 保留最近 5 条 tool 结果的内容

function compressHistory(messages: ChatCompletionMessageParam[]): void {
  // 1. 收集所有 tool_call_id（按 assistant 的出现顺序）
  const allToolCallIds: string[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const tc = (msg as any).tool_calls;
      if (tc?.length) {
        for (const t of tc) allToolCallIds.push(t.id);
      }
    }
  }

  // 2. 算出要清空的 set
  const keepSet = new Set(allToolCallIds.slice(-KEEP_RECENT));
  const clearSet = new Set(allToolCallIds.filter(id => !keepSet.has(id)));
  if (clearSet.size === 0) return;

  // 3. 只替换 tool 消息的 content，其他一概不动
  for (const msg of messages) {
    if (msg.role === "tool" && msg.tool_call_id && clearSet.has(msg.tool_call_id)) {
      (msg as any).content = "[Old tool result cleared]";
    }
  }
}
```

#### 完整示例

```
对话调用了 8 个工具：

裁剪前：
  [sys] [user] [asst tool_calls:[c1..c8]]
  [tool c1] [tool c2] ... [tool c8]

裁剪后（保留最近 5 个）：
  [sys] [user] [asst tool_calls:[c1..c8]]       ← 原封不动
  [tool c1]"[Old tool result cleared]"          ← 清了
  [tool c2]"[Old tool result cleared]"          ← 清了
  [tool c3]"[Old tool result cleared]"          ← 清了
  [tool c4] [tool c5] [tool c6] [tool c7] [tool c8]  ← 保留
```

assistant 消息的 `tool_calls` 和 `reasoning_content` 全部保留，消息结构完整，API 校验通过。LLM 看到 `[Old tool result cleared]` 就知道需要重新执行工具获取数据。### 方向 B：精简 System Prompt

去掉 system prompt 中的工具文本描述，只保留：

```
身份 + 工作流 + 安全规则 + 约束
```

因为工具的完整定义已经通过 API 的 `tools` 参数传给 LLM 了。

当前 system prompt 约 1000 tokens，精简后估计 300-400 tokens，省 60%。

---

## 实施路线图

### Phase 1：防线1 — 工具结果截断（立竿见影）

```
改动范围：src/agent/loop.ts 的 handleToolCall 函数
收益：单条大工具结果从 50k chars → ~5k chars，省 90%
风险：极低（只是截断显示，完整文件还在）
```

### Phase 2：防线2 — Content Eviction（Claude Code 风格）

```
改动范围：src/agent/context.ts 的 compressHistory 函数
行为：保留最近 5 个 tool 结果的内容，清空更早的
收益：不动消息结构，API 校验永远通过，实现最简单
风险：低（逻辑简单，timebased 行为可预测）
```

---

## 关键决策记录

| 决策 | 选项 | 选择 | 理由 |
|------|------|------|------|
| 防线2 策略 | 删消息 / 清 content | **只清 content** | 消息结构不变，API 校验永远通过 |
| 裁剪依据 | 按时间 / 按位置 | **按位置（最近 5 条）** | 最简单，不依赖时间戳，会话恢复无负担 |
| 首轮 user 是否特殊保留 | 是 / 否 | **否** | 一视同仁 |
| 裁剪标记 | 无标记 / 简短标记 | **简短标记** | 让 LLM 感知上下文有裁剪，必要时主动重新探索 |
| 时间戳持久化 | 不需要 | **不需要** | content eviction 不依赖时间戳 |
| 老会话恢复 | 受影响 / 不受影响 | **不受影响** | 只依赖消息结构，无外部状态 |
| 防线1 截断策略 | 只保留开头 / 首尾保留 | **首尾保留** | LLM 需要看到结果（结尾）才能判断下一步 |
| 防线1 文件兜底 | 不写 / 写到 outputDir | **写到 outputDir** | 保证 LLM 按"Use read tool"能找到完整文件 |
| 与 tool 层溢出机制的关系 | 替代 / 共存 | **共存（两道防线）** | tool 层存完整文件，context 层做显示截断 |
