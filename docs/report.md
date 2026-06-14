# seekHarness Agentic Loop 优化报告

> **日期**: 2026-06-13
> **作者**: seekHarness 内部 review
> **范围**: agentic loop 核心链路 (`src/agent/loop.ts` + 上下游)

---

## 📋 改进看板

| 状态 | 优先级 | 改进项 | 说明 |
|------|--------|--------|------|
| ✅ **Done** | 🔴 P0 | AbortSignal 取消机制 | `src/agent/loop.ts` + `src/llm/client.ts` + `src/tools/bash.ts` + `src/eval/run.ts` — 已实现 |
| ✅ **Done** | 🔴 P0 | 工具并行执行 | `src/agent/loop.ts` + `src/tools/types.ts` + `src/tools/registry.ts` — 已实现 |
| ✅ **Done** | 🟠 P1 | API 调用重试 | `src/llm/client.ts` — 已完成 |
| ⬜ **待处理** | 🟠 P1 | 上下文窗口管理 | — |
| ✅ **Done** | 🟠 P1 | Eval 任务并发 | `src/eval/run.ts` — 已完成 |
| ✅ **Done** | 🟠 P1 | 数据集灵活支持 | `scripts/build-mini-set.py` — 支持 SWE-bench Lite / Verified / Full / Multilingual |
| ⬜ **待处理** | 🟡 P2 | 重复错误检测 | — |
| ⬜ **待处理** | 🔵 P2-P3 | 流式 Tool arg 透传 | — |
| ⬜ **待处理** | 🔵 P3 | 函数拆解 | — |

---

## 一、现状架构

```
src/index.ts
  └→ src/cli/repl.ts ───────────────────────┐
      (交互式 REPL)                           │
src/eval/run.ts                              │
  (headless eval 跑分)                        │
      └──────────────────────────────────────┤
              ↓                              │
      src/agent/loop.ts                      │
        runAgentTurn()                       │
          ┌─────────────────────┐            │
          │ while turns < max:  │            │
          │  1. streamChat()    │            │
          │  2. push assistant  │            │
          │  3. if no tool call │            │
          │     → break         │            │
          │  4. for each tool:  │  ◄── 顺序   │
          │     handleToolCall()│            │
          │     push result     │            │
          └─────────────────────┘            │
              ↓                              │
      src/llm/client.ts                      │
        streamChatWithTools()                │
              ↓                              │
      src/tools/registry.ts                  │
        validate → execute                   │
```

### 核心文件

| 文件 | 职责 | 行数 |
|------|------|------|
| `src/agent/loop.ts` | 主循环：stream → tool call → 结果聚合 | 236 |
| `src/llm/client.ts` | OpenAI SDK 封装，流式 chat + tool call 累加 | 140 |
| `src/tools/registry.ts` | 工具注册表，validate → execute 分发 | 44 |
| `src/tools/types.ts` | `Tool` / `ToolContext` / `ToolResult` 接口 | 31 |
| `src/tools/bash.ts` | bash 执行 + 超时 + 大输出截断 | 221 |
| `src/tools/write.ts` | 文件写入 + read-before-write 校验 | 84 |
| `src/tools/read.ts` | 文件读取 + 行号标注 | 55 |
| `src/tools/policy.ts` | bash 安全黑名单策略 | 79 |
| `src/eval/run.ts` | eval 评测入口，全流程编排 | 379 |
| `src/cli/repl.ts` | 交互式 REPL，box UI + 消息转发 | 171 |

---

## 二、优化项清单

### 🔴 P0 — 高优先级

#### 1. ✅ [已实现] 缺失 `AbortSignal` 取消机制

**状态**：✅ 已实现。`runAgentTurn()`、`streamChatWithTools()`、`bash.execute()` 均支持 `AbortSignal` 参数，eval 使用 `AbortController` 实现真正取消，不再依赖 `Promise.race`。

**历史问题**：此前 `runAgentTurn()` 完全不接受 `AbortSignal`。eval runner 使用了 `Promise.race` 做"伪超时"：

```typescript
// src/eval/run.ts:247 — 没有真正取消
result = await Promise.race([
  runAgentTurn(...),
  new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () =>
      reject(new Error(`hard timeout ${HARD_TIMEOUT_MS}ms`)),
    );
  }),
]);
```

正在进行的 LLM 请求或 bash 进程会在后台继续执行，浪费配额和资源。

**影响范围**：
- `src/agent/loop.ts` — `runAgentTurn()` 加 `AbortSignal` 参数 → `streamChatWithTools()` 透传
- `src/llm/client.ts` — `streamChatWithTools()` / `chatWithTools()` 透传 signal
- `src/tools/bash.ts` — `runCommand()` 透传 signal
- `src/eval/run.ts` — 去掉 `Promise.race`，改用真取消

---

#### 2. ✅ [已实现] 工具调用串行执行

**状态**：✅ 已实现。工具分为 `isReadOnly`（read/glob/grep）和 write（write/edit/bash）两类，只读工具用 `Promise.all()` 并行执行，写工具串行执行。

**历史问题**：此前 LLM 返回的多个 `tool_calls` 只能逐个 await，但很多工具调用是**读操作**，互不依赖：

```typescript
// src/agent/loop.ts:143
for (const call of toolCalls) {          // ← 串行！
  const result = await handleToolCall(call, ...);
  messages.push(result);
}
```

典型场景：agent 同时发 `read("a.ts")` + `read("b.ts")` + `glob("src/**/*.py")`，这三个完全可以并行。

**建议方案**：
- 将工具分为两类：**read-only**（read/glob/grep）与 **write**（write/edit/bash）
- read-only 工具用 `Promise.all()` 并行执行
- write 工具串行执行（可能有副作用）
- 如果同一批中 read-only 和 write 混合，先并行跑 read-only，再串行跑 write

**影响范围**：
- `src/tools/types.ts` — `Tool` 接口加 `isReadOnly?: boolean` 标记
- `src/agent/loop.ts` — 调度逻辑改为分类并行/串行

---

### 🟠 P1 — 中优先级

#### 3. ✅ [已实现] OpenAI API 调用无重试

**状态**：✅ 已实现。`src/llm/client.ts` 实现了指数退避重试（`withRetry`，3 次，退避 1s/2s/4s），`chatWithTools` 和 `streamChatWithTools` 均被包裹。遇到 429 / 5xx 时自动重试，支持 `AbortSignal` 中断。

**历史问题**：此前 LLM 调用没有重试逻辑：

```typescript
// src/agent/loop.ts:108
const assistantMsg = await streamChatWithTools(...);  // 遇 429/5xx 直接抛
```

如果 API 返回 429 Rate Limit 或 5xx 错误，agent 直接崩溃。

**建议方案**：加指数退避重试（3 次，退避 1s / 2s / 4s），用 `AbortSignal` 控制是否应该放弃重试。

**影响范围**：
- `src/agent/loop.ts` — 调用 `streamChatWithTools()` 处加 retry wrapper
- 或 `src/llm/client.ts` — 在客户端层统一加重试

---

#### 4. 上下文窗口无管理

**问题**：`session.messages` 只增不减，每个 turn 至少增加 `1(assistant) + N(tool_results)` 条消息。

```typescript
messages.push(assistantMsg);   // 每轮
messages.push(result);         // 每个工具
```

运行 20 轮、每轮 2 个工具，消息数组就有 `1(system) + 20*3 = 61` 条。对于长上下文模型而言短期内还能承受，但：
- 没有 token 计数
- 没有旧消息压缩/丢弃策略
- 没有窗口滑动

**建议方案**：
- 加 `contextWindow` 阈值（按 token 估算或消息数）
- 超过阈值时，丢弃最早的非 system 消息，或用 LLM 总结旧对话

**影响范围**：
- `src/agent/loop.ts` — `runAgentTurn()` 内每次 push 后检查

---

#### 5. ✅ [已实现] Eval 任务串行执行

**状态**：✅ 已实现。`src/eval/run.ts` 实现了并发池，默认 4 个 task 并行（通过 `SEEKHARNESS_EVAL_CONCURRENCY` 环境变量或 `--concurrency N` CLI 参数配置）。

**历史问题**：此前 SWE-bench 评测（通常 50~300 个 task）逐个串行跑：

```typescript
// src/eval/run.ts:337
for (const t of tasks) {     // ← 串行！可能几小时
  const r = await runOne(t, { verbose: true });
  results.push(r);
}
```

**实现方案**：将串行 `for` 循环替换为基于共享迭代器的并发池模式：
- N 个 worker 协程从同一个 `nextIndex` 迭代器中不断取任务执行
- 结果按原始索引存入数组，保证 summary 顺序一致
- 默认并发 4，可通过 `SEEKHARNESS_EVAL_CONCURRENCY` 环境变量或 `--concurrency N` CLI 参数调整

**影响范围**：
- `src/eval/run.ts` — `main()` 中的 for 循环改为并发池

---

### 🟡 P2 — 较低优先级

#### 6. 工具调用重复错误检测

**问题**：如果 LLM 重复调用一个不存在的工具或传错误参数，当前只是把错误文本推回给 LLM：

```typescript
// 没有检测"连续失败 N 次"的机制
return { success: false, output: `Error: ${result.output}` };
```

可能导致死循环——LLM 不断用同样的错误方式调同一个工具。

**建议方案**：在 `ToolContext` 或 loop 中加一个计数器，同一工具连续失败 N 次（如 3 次）时自动终止循环。

**影响范围**：
- `src/agent/loop.ts` — 加 `Context.errorCount` 检测
- `src/tools/types.ts` — `ToolContext` 加 `errorCounts` Map

---

#### 7. 流式 Tool Call 参数未逐 token 透传

**问题**：`onStream` 目前只有三种事件类型（`assistant_text` / `tool_start` / `tool_end`），但 tool call 的 arguments 是流式到达的，没有逐 chunk 推送给前端。

**建议方案**：加 `tool_arg_chunk` 事件类型，将 `streamChatWithTools` 中每个 tool call delta 转发出去。

**影响范围**：
- `src/agent/loop.ts` — `TurnStreamInfo.type` 扩展
- `src/llm/client.ts` — 新增回调暴露 tool call delta

---

### 🔵 P3 — 代码质量

#### 8. `runAgentTurn` 函数拆解

**问题**：`runAgentTurn`（100 行）同时负责：
1. 消息管理（push user msg）
2. 流式 LLM 调用 + 重试
3. Tool call 分发 + 并行/串行调度
4. 结果聚合

**建议方案**：拆为更小的单元方便单测：
- `executeTurn(options)` → 发一次 LLM 请求，返回 assistant msg
- `dispatchToolCalls(toolCalls, registry, ctx)` → 分类并行/串行
- `executeToolCall(call, ctx)` → 单个工具执行

**影响范围**：
- `src/agent/loop.ts` — 纯重构，不改接口

---

## 三、优先级总结

| 优先级 | 项 | 标签 | 预估收益 | 状态 |
|--------|----|------|----------|------|
| **P0** | `AbortSignal` 取消机制 | 🛡️ 资源安全 | ⭐⭐⭐ 不再浪费配额，eval 可靠 | ✅ 已完成 |
| **P0** | 工具并行执行 | ⚡ 性能 | ⭐⭐⭐ 2-5x 提速读密集型任务 | ✅ 已完成 |
| **P1** | API 调用重试 | 🔁 可靠性 | ⭐⭐ 减少偶发失败 | ✅ 已完成 |
| **P1** | 上下文窗口管理 | 🧠 稳定性 | ⭐⭐ 长对话不崩 | ⬜ 待处理 |
| **P1** | Eval 并发 | ⏱️ 评测速度 | ⭐⭐⭐ 评测提速 N 倍 | ✅ 已完成 |
| **P1** | 数据集灵活支持 | 📦 扩展性 | ⭐⭐⭐ 可跑 Full/Verified/Multilingual | ✅ 已完成 |
| **P2** | 重复错误检测 | 🚫 安全网 | ⭐ 防止死循环 | ⬜ 待处理 |
| **P3** | 流式 tool arg | 🎨 UX | ⭐ 前端体验 | ⬜ 待处理 |
| **P3** | 函数拆解 | 🧹 可维护 | ⭐ 代码质量 | ⬜ 待处理 |

---

## 四、推荐执行路径

1. ~~**Sprint 1** (P0): AbortSignal + 并行工具执行~~ ✅ 已完成
2. ~~**Sprint 2** (P1): API 重试 + 上下文窗口管理~~ ✅ API 重试已完成
3. ~~**Sprint 3** (P1): Eval 并发 + 数据集灵活支持~~ ✅ 已完成
4. **Sprint 4** (P2-P3): 重复错误检测 + 重构
