import type { TraceEntry, TraceExitReason } from "../src/agent/trace.js";

// ─── Task 定义 ──────────────────────────────────────────────────────────────

export interface BenchmarkCheck {
  name: string;
  /** 返回 true = 通过，false = 失败 */
  fn: (trace: TraceEntry[]) => boolean;
}

export interface BenchmarkTask {
  /** 任务名，用于报告 */
  name: string;
  /** 发送给 agent 的 prompt */
  prompt: string;
  /** 验证检查列表 */
  checks: BenchmarkCheck[];
  /** 最大轮数，默认 15 */
  maxTurns?: number;
  /** 允许的退出原因，默认 ["no_tool_calls"] */
  allowedExits?: TraceExitReason[];
}

// ─── 内置 check 工厂 ────────────────────────────────────────────────────────

/** 检查 agent 是否调用了某个工具至少 N 次 */
export function calledTool(toolName: string, minCount = 1): BenchmarkCheck {
  return {
    name: `调用了 ${toolName}`,
    fn: (trace) => trace.filter((e) => e.type === "tool_end" && e.toolName === toolName).length >= minCount,
  };
}

/** 检查 agent 是否读某个文件 */
export function readFile(filePattern: string): BenchmarkCheck {
  return {
    name: `读取了 ${filePattern}`,
    fn: (trace) =>
      trace.some(
        (e) => e.type === "tool_start" && e.toolName === "read" && e.args.includes(filePattern),
      ),
  };
}

/** 检查 agent 是否写了某个文件 */
export function wroteFile(filePattern: string): BenchmarkCheck {
  return {
    name: `写入了 ${filePattern}`,
    fn: (trace) =>
      trace.some(
        (e) =>
          (e.type === "tool_start" && e.toolName === "write" && e.args.includes(filePattern)) ||
          (e.type === "tool_start" && e.toolName === "edit" && e.args.includes(filePattern)),
      ),
  };
}

/** 检查 agent 的最终回答是否包含某些关键词 */
export function answeredWith(keywords: string[]): BenchmarkCheck {
  return {
    name: `回答包含 ${keywords.join(" / ")}`,
    fn: (trace) => {
      const exit = trace.find((e) => e.type === "exit");
      if (!exit) return false;
      // 取最后一个 assistant 的 content
      const lastAsst = [...trace].reverse().find((e) => e.type === "llm_end" && e.content);
      if (!lastAsst || lastAsst.type !== "llm_end") return false;
      return keywords.some((k) => (lastAsst.content ?? "").toLowerCase().includes(k.toLowerCase()));
    },
  };
}

// ─── 任务列表 ────────────────────────────────────────────────────────────────

export const defaultTasks: BenchmarkTask[] = [
  // ── 基础场景 ──
  {
    name: "simple-read",
    prompt: "读取 src/agent/loop.ts，告诉我它有多少行",
    maxTurns: 3,
    allowedExits: ["no_tool_calls"],
    checks: [calledTool("read", 1), answeredWith(["行"])],
  },
  {
    name: "glob-find",
    prompt: "用 glob 找一下项目里所有的 .ts 文件有多少个",
    maxTurns: 3,
    allowedExits: ["no_tool_calls"],
    checks: [calledTool("glob", 1)],
  },

  // ── 中等场景 ──
  {
    name: "dependency-audit",
    prompt:
      "看看这个项目的 package.json，列出所有 dependencies 的名字（不需要版本号）",
    maxTurns: 5,
    allowedExits: ["no_tool_calls"],
    checks: [calledTool("read", 1), answeredWith(["依赖", "dependencies"])],
  },
  {
    name: "bash-command",
    prompt: "跑 npx tsc --noEmit 看看有没有 TypeScript 编译错误",
    maxTurns: 4,
    allowedExits: ["no_tool_calls"],
    checks: [calledTool("bash", 1)],
  },

  // ── 编辑场景 ──
  {
    name: "simple-edit",
    prompt: "在 src/hello.txt 里写入一行 'hello seekharness'",
    maxTurns: 3,
    allowedExits: ["no_tool_calls"],
    checks: [calledTool("write", 1), wroteFile("hello.txt")],
  },

  // ── 分析场景 ──
  {
    name: "code-analysis",
    prompt:
      "分析 src/agent/context.ts，看看它导出了哪些函数，分别做什么的？用表格列出来",
    maxTurns: 6,
    allowedExits: ["no_tool_calls"],
    checks: [calledTool("read", 1), answeredWith(["truncateOutput", "compressHistory"])],
  },
];
