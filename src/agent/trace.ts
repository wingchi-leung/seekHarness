/**
 * Agent 执行追踪（trace）系统。
 *
 * 记录每轮 agent 执行的完整、无损 trace，用于 eval/分析。
 * 每条 trace entry 是一个 JSON 对象，写入 JSONL 文件或通过回调输出。
 * 与 session messages 不同，trace 记录的是截断前的原始数据（完整 tool 输出等）。
 */

// ─── Trace Types ────────────────────────────────────────────────────────────

export interface TraceEntryUserInput {
  ts: number;
  type: "user_input";
  turn: number;
  text: string;
}

export interface TraceEntryLlmStart {
  ts: number;
  type: "llm_start";
  turn: number;
  /** 发送给 LLM 的 messages 数量 */
  messageCount: number;
  /** tool definitions 数量 */
  toolCount: number;
}

export interface TraceEntryLlmEnd {
  ts: number;
  type: "llm_end";
  turn: number;
  /** LLM 返回的文本内容 */
  content: string | null;
  /** LLM 调用的工具列表（参数也是原始 JSON） */
  toolCalls: { id: string; name: string; args: string }[];
  /** LLM 调用耗时（毫秒） */
  durationMs: number;
  /** 如果 API 返回了 usage 信息 */
  inputTokens?: number;
  outputTokens?: number;
}

export interface TraceEntryToolStart {
  ts: number;
  type: "tool_start";
  turn: number;
  toolCallId: string;
  toolName: string;
  args: string;
}

export interface TraceEntryToolEnd {
  ts: number;
  type: "tool_end";
  turn: number;
  toolCallId: string;
  toolName: string;
  /** 工具的完整输出（原始、未截断） */
  output: string;
  /** 工具执行是否成功 */
  success: boolean;
  /** 工具执行耗时（毫秒） */
  durationMs: number;
}

export type TraceExitReason = "no_tool_calls" | "cancelled" | "max_turns" | "loop_detected";

export interface TraceEntryExit {
  ts: number;
  type: "exit";
  turn: number;
  reason: TraceExitReason;
  /** 总耗时（毫秒），从收到 user input 到 exit */
  durationMs: number;
  /** 总工具调用次数 */
  totalToolCalls: number;
}

export type TraceEntry =
  | TraceEntryUserInput
  | TraceEntryLlmStart
  | TraceEntryLlmEnd
  | TraceEntryToolStart
  | TraceEntryToolEnd
  | TraceEntryExit;

/** trace 回调函数 */
export type TraceCallback = (entry: TraceEntry) => void;

// ─── JSONL Writer ──────────────────────────────────────────────────────────

import fs from "node:fs";

/**
 * 创建一个 trace 文件写入器。
 * 调用 write(entry) 追加一行 JSON，调用 close() 关闭文件。
 *
 * @example
 * const tracer = createTraceWriter("./traces/my-session.jsonl");
 * tracer.write({ ts: Date.now(), type: "user_input", turn: 0, text: "hi" });
 * tracer.close();
 */
export function createTraceWriter(filePath: string) {
  const stream = fs.createWriteStream(filePath, { flags: "a", encoding: "utf-8" });

  return {
    write(entry: TraceEntry): void {
      stream.write(JSON.stringify(entry) + "\n");
    },
    close(): void {
      stream.end();
    },
  };
}
