# SeekHarness Eval 报告

> 基于 `~/.seekharness/traces/` 下 19 个 trace 文件的分析
> 生成时间：2025-03-28

## 1. 总体数据

| 指标 | 值 |
|------|-----|
| Trace 文件数 | 19 |
| 总事件数 | ~2000+ |
| 总工具调用 | ~500+ |
| 全部 session 数 | 12 |
| 最长单轮对话 | 642 messages |
| 最长单次 agent 执行 | 476 秒 |

## 2. 工具使用分布

```
bash ████████████████████████████████████████  ~220 次 (42%)
read ██████████████████████████               ~140 次 (27%)
edit ██████████                               ~50 次  (10%)
write ████████                                ~40 次  (8%)
glob ██████                                   ~30 次  (6%)
grep ████                                     ~20 次  (4%)
```

bash 占绝对大头，这合理——agent 通过 `npm test`, `npx tsc`, `git status` 等获取反馈。

## 3. 性能分析

### 3.1 LLM 调用延迟

```
trace                │ avg LLM (ms) │ max LLM (ms) │ 工具数
─────────────────────┼──────────────┼──────────────┼───────
seekHarness-1        │ 2,360        │ 10,376       │ 79
seekHarness-2        │ 3,190        │ 5,930        │ 87
seekHarness-3        │ 4,112        │ 5,597        │ 68
seekHarness-4        │ 4,997        │ 6,478        │ 17
seekHarness-5        │ 5,012        │ 5,930        │ 21
wingchi-website-1    │ 2,572        │ 4,746        │ 94
wingchi-website-2    │ 2,927        │ 3,872        │ 31
```

**观察**：LLM 平均 2-6 秒/次，有些对话里有 60+ 次 LLM 调用，光等 LLM 就花了 3-5 分钟。

### 3.2 退出原因

```
no_tool_calls  ───────  8 次 (正常完成)
cancelled     ───────  1 次 (用户手动中断)
? (trace不全)  ───────  10 次 (还在跑或被打断)
```

**观察**：半数 trace 没有 exit 事件，说明 agent 还在执行中就被中断了，或者 trace 写入不完整。

### 3.3 Tool 输出量

```
trace                │ tool 输出总量 │ 工具数  │ 平均/工具
─────────────────────┼──────────────┼────────┼─────────
seekHarness-1        │ 305 KB       │ 79     │ 3.9 KB
seekHarness-2        │ 240 KB       │ 68     │ 3.5 KB
seekHarness-3        │ 203 KB       │ 87     │ 2.3 KB
wingchi-website-1    │ 198 KB       │ 94     │ 2.1 KB
seekHarness-4        │ 148 KB       │ 34     │ 4.4 KB
```

**观察**：单次 agent 执行产生 200-300 KB 的工具输出，防线1(截断) 和 防线2(content eviction) 是必要的。

## 4. 问题发现

### 4.1 长会话退化

最长的一个 session 有 **642 条 messages**。即使有 content eviction，这么多消息也会让 LLM 的注意力被稀释。

```
20轮  → 正常
50轮  → 开始绕弯子
69轮  → 明显退化，agent 反复调同一组工具
```

### 4.2 死循环倾向

在 69 轮的 trace 里，最后 20 轮只有 `edit` + `bash npm test` 来回切：
```
turn 48: edit → bash
turn 49: edit → bash
turn 50: bash → bash
...
turn 69: edit
```

agent 陷入了"修改→测试→修改→测试"的循环，直到 maxTurns 才退出。

### 4.3 缺少 fallback

所有 tool 失败后 agent 没有重试或替代方案。如果 `bash` 命令返回非零退出码，agent 通常只读一次错误就放弃，不会尝试简化命令或换方案。

## 5. 建议的 benchmark 场景

基于以上分析，我建议建立以下基准测试：

```
基础场景：
  ✅ simple-read     — 读一个文件并回答内容
  ✅ glob-find       — 用 glob 找到特定文件
  ✅ bash-command    — 跑一个 shell 命令并解释输出

正常场景：
  ✅ dependency-audit   — 分析一个项目的依赖
  ✅ refactor-rename    — 重命名一个函数/文件
  ✅ fix-bug            — 从错误输出推断并修复

压力场景：
  ⚠️ long-task         — 需要 8+ 轮才能完成的任务
  ⚠️ error-recovery    — 工具连续失败，agent 能否换方案
  ⚠️ context-pressure  — 30 轮以上的持续对话
```

## 6. 下一步

1. **建立 baseline** — 把这 19 个 trace 的指标作为基准线
2. **benchmark runner** — 自动跑场景，与 baseline 对比
3. **CI gate** — 关键指标退化（turns 翻倍、工具数暴增）时报警
