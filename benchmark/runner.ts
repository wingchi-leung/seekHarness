/**
 * benchmark runner
 *
 * 用法：
 *   npx tsx benchmark/runner.ts                          # 跑所有默认任务
 *   npx tsx benchmark/runner.ts --task simple-read        # 只跑某个任务
 *   npx tsx benchmark/runner.ts --report report.md        # 输出到文件
 *
 * 环境变量：DEEPSEEK_API_KEY, DEEPSEEK_MODEL 等（复用 .env）
 */

import fs from "node:fs";
import path from "node:path";
import { createAgentSession, runAgentTurn } from "../src/agent/loop.js";
import { createLlmClient, loadLlmConfig } from "../src/llm/client.js";
import { type TraceEntry } from "../src/agent/trace.js";
import { defaultTasks, type BenchmarkTask } from "./tasks.js";
import { analyzeTask, generateReport, type TaskResult } from "./analyzer.js";

// ─── CLI args 解析 ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const taskFilter = args.includes("--task") ? args[args.indexOf("--task") + 1] : null;
const reportFile = args.includes("--report") ? args[args.indexOf("--report") + 1] : null;

// ─── 收集 trace 到内存 ──────────────────────────────────────────────────────

function createTraceCollector(): {
  trace: TraceEntry[];
  onTrace: (entry: TraceEntry) => void;
} {
  const trace: TraceEntry[] = [];
  return {
    trace,
    onTrace: (entry) => trace.push(entry),
  };
}

// ─── 执行单个任务 ────────────────────────────────────────────────────────────

async function runTask(
  task: BenchmarkTask,
  workspaceRoot: string,
): Promise<TaskResult> {
  const session = createAgentSession(workspaceRoot);
  const config = loadLlmConfig();
  const client = createLlmClient(config);
  const collector = createTraceCollector();

  console.log(`\n  ▶ ${task.name}: ${task.prompt.slice(0, 60)}...`);

  try {
    const result = await runAgentTurn(session, task.prompt, {
      client,
      llmConfig: config,
      maxTurns: task.maxTurns ?? 15,
      onTrace: collector.onTrace,
      // 静默，不输出到 stdout
      onTurn: () => {},
      onStream: () => {},
    });

    console.log(`    ✅ 完成: ${result.turns} turns`);

    return analyzeTask(task, collector.trace);
  } catch (err: any) {
    console.log(`    ❌ 错误: ${err.message}`);

    return {
      task,
      passed: false,
      turns: 0,
      totalTools: 0,
      durationMs: 0,
      exitReason: "unknown",
      checkResults: task.checks.map((c) => ({ name: c.name, passed: false })),
      toolStats: [],
      deadlock: null,
      trace: collector.trace,
      error: err.message,
    };
  }
}

// ─── 主函数 ──────────────────────────────────────────────────────────────────

async function main() {
  const workspaceRoot = process.cwd();

  // 过滤任务
  const tasks: BenchmarkTask[] = taskFilter
    ? defaultTasks.filter((t) => t.name === taskFilter)
    : defaultTasks;

  if (tasks.length === 0) {
    console.error(`没有找到任务${taskFilter ? `: ${taskFilter}` : ""}`);
    console.error(`可用任务: ${defaultTasks.map((t) => t.name).join(", ")}`);
    process.exit(1);
  }

  console.log(`\n🧪 SeekHarness Benchmark`);
  console.log(`   workspace: ${workspaceRoot}`);
  console.log(`   tasks: ${tasks.map((t) => t.name).join(", ")}`);

  const results: TaskResult[] = [];
  for (const task of tasks) {
    const r = await runTask(task, workspaceRoot);
    results.push(r);
  }

  // 生成报告
  const report = generateReport(results);

  if (reportFile) {
    const reportPath = path.resolve(reportFile);
    await fs.promises.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.promises.writeFile(reportPath, report, "utf-8");
    console.log(`\n📄 报告已保存: ${reportPath}`);
  }

  // 打印最终摘要
  const passed = results.filter((r) => r.passed).length;
  console.log(`\n📊 结果: ${passed}/${results.length} 通过`);
  for (const r of results) {
    const icon = r.passed ? "✅" : r.deadlock ? "⚠️" : "❌";
    console.log(`   ${icon} ${r.task.name}: ${r.turns}t ${r.totalTools}tools ${(r.durationMs / 1000).toFixed(1)}s`);
  }

  // 如果有死循环，非零退出
  const deadlocked = results.filter((r) => r.deadlock);
  if (deadlocked.length > 0) {
    console.log(`\n⚠️ 检测到 ${deadlocked.length} 个死循环任务`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
