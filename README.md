# seekHarness

![seekHarness splash](asset/image.png)

> 从零实现一个 coding agent CLI，对标 Claude Code 核心架构，基于 DeepSeek 模型。
> 
> 研究方向：agent loop 控制流、上下文工程、工具系统设计、SWE-bench 评测。

---

## 为什么做这个

Claude Code 源码泄露后，社区对 agent loop 的架构设计有了更清晰的认识。参考 [解剖 agent loop](https://stevekinney.com/writing/agent-loops) 等文章和 CC 的实现，我想弄清楚两件事：

1. 一个 SWE-agent 最核心的东西是什么？
2. 上下文窗口在长任务里是怎么失控的，如何防御？

seekHarness 是我的答案：约 1500 行 TypeScript，实现了一个可以真正用来干活的 coding agent。

---

## 快速开始

```bash
npm install
cp .env.example .env
# 填入 DEEPSEEK_API_KEY
```

```bash
# 交互式 REPL
npm run dev

# 执行一条任务后进入对话
npm run dev -- "读取 README.md 并总结"

# 跳过动画
npm run dev -- --no-splash

# 恢复上次会话
npm run dev -- --resume
```

REPL 内置命令：`/help`  `/clear`  `/exit`

---

## 架构

```
src/
├── agent/
│   ├── loop.ts         # Agent loop 主控（while 循环，非递归）
│   ├── context.ts      # 上下文管理（双防线截断 + content eviction）
│   ├── prompt.ts       # 系统 prompt 构建（多段式，动态 Agents.md）
│   └── trace.ts        # JSONL 执行追踪
├── llm/
│   └── client.ts       # DeepSeek / OpenAI 兼容客户端（流式 + 重试）
├── tools/
│   ├── registry.ts     # 工具注册 & 调度（读写分离并行策略）
│   ├── bash.ts         # Shell 执行（安全黑名单 + 超时）
│   ├── read.ts         # 读文件（workspace 路径校验）
│   ├── write.ts        # 写文件（必须先 read 才能覆写）
│   ├── edit.ts         # 精确替换（子串定位）
│   ├── glob.ts         # 文件模式匹配（fast-glob）
│   ├── grep.ts         # 内容搜索（ripgrep）
│   └── policy.ts       # 危险命令检测
├── session/
│   └── persistence.ts  # 会话持久化（原子写入 + 全局索引）
└── eval/
    └── run.ts          # SWE-bench 评测 runner
```

---

## 核心设计

### 1. Agent Loop：while 而非递归

agent loop 用 `while` + 显式 `State` 对象，而非递归：

```typescript
let state: State = { messages, turnCount: 0 }

while (state.turnCount < maxTurns) {
  const assistantMsg = await streamChatWithTools(...)

  if (!hasToolCalls(assistantMsg)) break   // 正常完成

  // 并行执行只读工具，串行执行写操作
  await Promise.all(readOnlyCalls.map(exec))
  for (const call of writeCalls) await exec(call)

  state = { messages: [...state.messages, ...results], turnCount: state.turnCount + 1 }
}
```

递归方案在 50+ turns 的长任务里会爆栈（JS 默认栈深度 ~10k 帧）；`while` 是 O(1) 栈空间，错误恢复路径也更清晰。

### 2. 上下文管理：双防线

**问题：** 长会话里 `session.messages` 只增不减。一次 `bash npm test` 输出几万行，每轮对话都把它发给 LLM，token 浪费、速度变慢、还稀释了真正有用的上下文。

**防线 1：工具输出截断（源头控制）**

```
tool 输出 50,000 chars
    │
    ▼ context 层截断（阈值 ~5200 chars）
[前 3000 chars] ... [已截断，完整输出保存至 .seekharness/output_xxx.txt] ... [后 2000 chars]
[Use the read tool with the path above to see full output]
    │
    ▼ LLM 看到首尾 → 必要时主动 read 完整文件
```

保留首尾而非只保留开头：LLM 需要同时看到"命令是什么"和"结果/报错是什么"。

**防线 2：历史 Content Eviction（借鉴 Claude Code）**

不删消息（删了 `tool_call_id` 会悬空 → API 400），只替换旧 tool result 的 content：

```
裁剪前：[asst tool_calls:[c1..c8]] [tool c1]"大段输出" ... [tool c8]"大段输出"

裁剪后（保留最近 5 条）：
[asst tool_calls:[c1..c8]]           ← 结构不动
[tool c1] "[Old tool result cleared]" ← 只清 content
[tool c2] "[Old tool result cleared]"
[tool c3] "[Old tool result cleared]"
[tool c4] [tool c5] [tool c6] [tool c7] [tool c8]  ← 完整保留
```

消息结构不变 → API 校验永远通过；LLM 看到 `[Old tool result cleared]` 会主动重新调工具。

### 3. 工具系统

| 工具 | 类型 | 关键设计 |
|------|------|----------|
| `read` | 只读 | workspace 路径校验，带行号输出 |
| `glob` | 只读 | fast-glob，按修改时间排序，上限 100 条 |
| `grep` | 只读 | ripgrep，支持多行正则，三种输出模式 |
| `bash` | 写操作 | 危险命令黑名单，超时 2min（最长 10min），输出 >30k 写临时文件 |
| `write` | 写操作 | 必须先 `read` 才能覆写（防止意外破坏文件） |
| `edit` | 写操作 | 子串精确替换，要求唯一匹配 |

只读工具并行执行，写操作串行执行——这保证了副作用顺序的同时最大化了探索阶段的速度。

### 4. 执行追踪（JSONL Trace）

每次 agent 运行写一份 `~/.seekharness/traces/<timestamp>.jsonl`，记录完整生命周期：

```
user_input → llm_start → llm_end → tool_start → tool_end → ... → exit
```

每条事件包含时间戳、token 数、完整工具输入输出。用于：
- 性能分析（平均 LLM 延迟、工具分布）
- 问题诊断（死循环检测、长会话退化分析）
- SWE-bench 评测数据提取

---

## SWE-bench 评测

端到端接入 [SWE-bench Lite](https://www.swebench.com/lite.html)，自动 clone 仓库、执行 agent、提取 patch、Docker 评分。

```bash
# 准备（需要 Docker）
pip install swebench==4.1.0
npm run eval:build -- --size 20     # 生成 mini 子集

# 运行
npm run eval                        # agent 跑任务，patch 写到 outputs/patches/
npm run eval:score                  # swebench 评分，输出 summary.json
```

**评测数据（基于 19 个 trace 文件）：**

```
总工具调用  ~500+
最长会话    642 条 messages
最长执行    476 秒
工具分布    bash 42% > read 27% > edit 10% > write 8% > glob 6% > grep 4%
LLM 延迟    平均 2-6 秒/次；60+ 次调用的会话光等 LLM 就要 3-5 分钟
上下文压力  单次 agent 产出 200-300 KB 工具输出 → 双防线是必要的
```

**发现的问题：**
- 50+ turns 后 LLM 注意力稀释，69 轮的 session 最后 20 轮陷入 `edit → bash → edit` 死循环
- `bash` 失败后缺少 fallback 策略，agent 通常读一次错误就放弃

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DEEPSEEK_API_KEY` | — | API 密钥（也可用 `OPENAI_API_KEY`） |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 兼容任何 OpenAI 格式端点 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 模型名 |
| `SEEKHARNESS_ALLOW_DANGEROUS` | — | 设为 `1` 解锁被黑名单阻止的命令 |

---

## 文档

| 文档 | 内容 |
|------|------|
| [harness01-agentloop.md](docs/harness01-agentloop.md) | Agent loop 设计与控制流 |
| [harness02-toolsystem.md](docs/harness02-toolsystem.md) | 工具系统架构 |
| [harness03-tools-glob-write.md](docs/harness03-tools-glob-write.md) | Glob/Write 实现细节 |
| [harness04-eval.md](docs/harness04-eval.md) | SWE-bench 评测完整指南 |
| [harness05-context.md](docs/harness05-context.md) | 上下文管理深度分析 |
| [eval-report.md](docs/eval-report.md) | 19 个 trace 的评测数据报告 |

---

## 技术栈

- **运行时：** Node.js 20+，TypeScript strict
- **LLM：** openai SDK（兼容 DeepSeek / OpenAI / 任何 OpenAI 格式 API）
- **终端 UI：** Ink + React
- **搜索：** @vscode/ripgrep（VSCode 同款）+ fast-glob
- **验证：** Zod
- **生产依赖：** 8 个

---

## 自举验证

agent 参与了自身的构建：用它给博客系统加标签系统（数千行代码）、review 自己的代码并修复了 2 个 bug、为自己添加了对话恢复功能。
