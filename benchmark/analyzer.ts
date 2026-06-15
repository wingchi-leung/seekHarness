import type { TraceEntry, TraceExitReason } from "../src/agent/trace.js";
import type { BenchmarkTask } from "./tasks.js";

// ─── 分析结果类型 ────────────────────────────────────────────────────────────

export interface ToolStat {
  name: string;
  count: number;
  success: number;
  fail: number;
  totalDuration: number;
}

export interface DeadlockInfo {
  /** 从第几轮开始死循环 */
  startTurn: number;
  /** 死循环的工具链 */
  pattern: string;
  /** 死的轮数 */
  turnsStuck: number;
  /** 重复调用次数 */
  repeatCount: number;
}

export interface TaskResult {
  task: BenchmarkTask;
  /** 是否正常完成 */
  passed: boolean;
  /** 总轮数 */
  turns: number;
  /** 总工具调用次数 */
  totalTools: number;
  /** 总耗时（ms） */
  durationMs: number;
  /** 退出原因 */
  exitReason: TraceExitReason | "unknown";
  /** check 逐条结果 */
  checkResults: { name: string; passed: boolean }[];
  /** 工具使用统计 */
  toolStats: ToolStat[];
  /** 死循环检测 */
  deadlock: DeadlockInfo | null;
  /** 完整 trace（供后续分析） */
  trace: TraceEntry[];
  /** 错误信息（如果有） */
  error?: string;
}

// ─── 分析器 ──────────────────────────────────────────────────────────────────

export function analyzeTask(task: BenchmarkTask, trace: TraceEntry[]): TaskResult {
  const exitEvent = trace.find((e) => e.type === "exit") as
    | { type: "exit"; reason: TraceExitReason; turn: number; durationMs: number; totalToolCalls: number }
    | undefined;

  const exitReason = exitEvent?.reason ?? "unknown";
  const turns = exitEvent?.turn ?? trace.length;
  const durationMs = exitEvent?.durationMs ?? 0;

  const toolEnds = trace.filter((e) => e.type === "tool_end") as {
    type: "tool_end";
    toolName: string;
    success: boolean;
    durationMs: number;
  }[];

  // 工具统计
  const toolMap = new Map<
    string,
    { count: number; success: number; fail: number; totalDuration: number }
  >();
  for (const t of toolEnds) {
    const s = toolMap.get(t.toolName) ?? { count: 0, success: 0, fail: 0, totalDuration: 0 };
    s.count++;
    if (t.success) s.success++;
    else s.fail++;
    s.totalDuration += t.durationMs;
    toolMap.set(t.toolName, s);
  }
  const toolStats: ToolStat[] = Array.from(toolMap.entries()).map(([name, s]) => ({
    name,
    ...s,
  }));

  // 死循环检测：连续 3 轮以上同样的工具组合
  const deadlock = detectDeadlock(trace);

  // check 逐条验证
  const checkResults = task.checks.map((c) => ({
    name: c.name,
    passed: c.fn(trace),
  }));

  const passed =
    checkResults.every((c) => c.passed) &&
    !deadlock &&
    (task.allowedExits ?? ["no_tool_calls"]).includes(exitReason as TraceExitReason);

  return {
    task,
    passed,
    turns,
    totalTools: toolEnds.length,
    durationMs,
    exitReason,
    checkResults,
    toolStats,
    deadlock,
    trace,
  };
}

// ─── 死循环检测 ──────────────────────────────────────────────────────────────

/**
 * 检测 agent 是否陷入了死循环。
 * 规则：连续 3 轮调用的工具组合相同（忽略参数差异），且没有进入新的 user turn。
 */
function detectDeadlock(trace: TraceEntry[]): DeadlockInfo | null {
  // 按 turn 分组工具调用
  const turnTools = new Map<number, string[]>();
  for (const e of trace) {
    if (e.type === "tool_end") {
      const list = turnTools.get(e.turn) ?? [];
      list.push(e.toolName);
      turnTools.set(e.turn, list);
    }
  }

  const turns = Array.from(turnTools.keys()).sort((a, b) => a - b);

  // 找连续相同的工具组合
  let streakStart = 0;
  for (let i = 1; i < turns.length; i++) {
    const prev = turnTools.get(turns[i - 1])!.sort().join(",");
    const curr = turnTools.get(turns[i])!.sort().join(",");

    if (prev === curr && prev.length > 0) {
      // 连续相同
      const streakLen = i - streakStart + 1;
      if (streakLen >= 3) {
        return {
          startTurn: turns[streakStart],
          pattern: prev,
          turnsStuck: streakLen,
          repeatCount: streakLen,
        };
      }
    } else {
      streakStart = i;
    }
  }

  return null;
}

// ─── 报告生成 ────────────────────────────────────────────────────────────────

export function generateReport(results: TaskResult[]): string {
  const lines: string[] = [];

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;

  lines.push("# Benchmark 报告");
  lines.push("");
  lines.push(`> ${new Date().toISOString().slice(0, 10)}`);
  lines.push("");
  lines.push(`**通过率**: ${passed}/${total} (${total > 0 ? Math.round((passed / total) * 100) : 0}%)`);
  lines.push("");

  // 总览表
  lines.push("## 总览");
  lines.push("");
  lines.push("| Task | Turns | Tools | Duration | Exit | Checks | 死循环 | Status |");
  lines.push("|------|-------|-------|----------|------|--------|--------|--------|");

  for (const r of results) {
    const checkStr = `${r.checkResults.filter((c) => c.passed).length}/${r.checkResults.length}`;
    const deadlockStr = r.deadlock ? `⚠️ ${r.deadlock.turnsStuck}轮` : "✅ 无";
    const status = r.passed ? "✅" : "❌";
    lines.push(
      `| ${r.task.name} | ${r.turns} | ${r.totalTools} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.exitReason} | ${checkStr} | ${deadlockStr} | ${status} |`,
    );
  }

  lines.push("");

  // 逐任务详情
  for (const r of results) {
    lines.push(`---`);
    lines.push("");
    lines.push(`### ${r.task.name}`);
    lines.push("");
    lines.push(`**Prompt**: \`${r.task.prompt}\``);
    lines.push("");
    lines.push(`**退出**: ${r.exitReason} | **轮数**: ${r.turns} | **工具数**: ${r.totalTools} | **耗时**: ${(r.durationMs / 1000).toFixed(1)}s`);
    lines.push("");

    // Checks
    lines.push("#### Checks");
    lines.push("");
    lines.push("| Check | Result |");
    lines.push("|-------|--------|");
    for (const c of r.checkResults) {
      lines.push(`| ${c.name} | ${c.passed ? "✅" : "❌"} |`);
    }
    lines.push("");

    // 工具统计
    lines.push("#### 工具使用");
    lines.push("");
    lines.push("| 工具 | 次数 | 成功 | 失败 | 平均耗时 |");
    lines.push("|------|------|------|------|---------|");
    for (const ts of r.toolStats) {
      const avgMs = ts.count > 0 ? Math.round(ts.totalDuration / ts.count) : 0;
      lines.push(`| ${ts.name} | ${ts.count} | ${ts.success} | ${ts.fail} | ${avgMs}ms |`);
    }
    lines.push("");

    // 死循环警告
    if (r.deadlock) {
      lines.push("#### ⚠️ 死循环检测");
      lines.push("");
      lines.push(`从第 ${r.deadlock.startTurn} 轮开始，连续 ${r.deadlock.turnsStuck} 轮调用相同的工具组合：\`${r.deadlock.pattern}\``);
      lines.push("");
    }

    if (r.error) {
      lines.push(`#### ❌ 错误\n\n\`\`\`\n${r.error}\n\`\`\`\n`);
    }
  }

  return lines.join("\n");
}
