import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions.js";
import type OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { streamChatWithTools, type LlmConfig } from "../llm/client.js";
import { createToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import { DefaultBashPolicy } from "../tools/policy.js";
import {
  buildSystemMessages,
  agentsMdSection,
  type PromptSection,
} from "./prompt.js";
import {
  truncateOutput,
  compressHistory,
  markToolTimestamp,
  createToolTimestampStore,
  type ToolTimestampStore,
} from "./context.js";
import {
  type TraceEntry,
  type TraceCallback,
  type TraceExitReason,
  createTraceWriter,
} from "./trace.js";

export interface AgentSession {
  /** 可选会话 ID，用于持久化绑定 */
  id?: string;
  workspaceRoot: string;
  messages: ChatCompletionMessageParam[];
  /** tool result 时间戳（可序列化），防线2 用 */
  toolTimestamps: ToolTimestampStore;
}

export function createAgentSession(
  workspaceRoot: string,
  systemPrompt?: string,
  extraSections?: PromptSection[],
): AgentSession {
  const messages: ChatCompletionMessageParam[] = systemPrompt
    ? [{ role: "system", content: systemPrompt }]
    : buildSystemMessages({ extraSections });

  return { workspaceRoot, messages, toolTimestamps: createToolTimestampStore() };
}

/**
 * 读取当前磁盘上的 Agents.md，格式化为 system message 内容。
 * 读不到或内容为空时返回 undefined。
 */
function readAgentsMd(workspaceRoot: string): string | undefined {
  const agentsMdPath = path.join(workspaceRoot, "Agents.md");
  try {
    if (fs.existsSync(agentsMdPath)) {
      const content = fs.readFileSync(agentsMdPath, "utf-8").trim();
      if (content) return agentsMdSection(content).content;
    }
  } catch {
    // Silently ignore
  }
  return undefined;
}

export interface TurnStreamInfo {
  turn: number;
  /** "assistant_text" = progressive text chunk, "tool_start" / "tool_end" = tool call lifecycle */
  type: "assistant_text" | "tool_start" | "tool_end";
  text: string;
}

export interface AgentTurnOptions {
  client: OpenAI;
  llmConfig: LlmConfig;
  maxTurns?: number;
  /** Legacy callback for turn summaries (called once per assistant message / tool call) */
  onTurn?: (info: { turn: number; role: string; preview: string }) => void;
  /** Streaming callback – called progressively for real-time output */
  onStream?: (info: TurnStreamInfo) => void;
  /** Trace callback – called once per lifecycle event with full, lossless data */
  onTrace?: TraceCallback;
  /** 如果传了 traceDir，自动写 trace JSONL 文件到该目录（文件名按时间生成） */
  traceDir?: string;
  /** AbortSignal to cancel the entire agent turn mid-flight */
  signal?: AbortSignal;
}

export interface AgentLoopResult {
  finalText: string;
  turns: number;
}

export async function runAgentTurn(
  session: AgentSession,
  userMessage: string,
  options: AgentTurnOptions
): Promise<AgentLoopResult> {
  const { client, llmConfig, maxTurns = 100, onTurn, onStream, signal } = options;
  const turnStartTime = Date.now();

  // 自动写 trace JSONL——除非调用方传了 onTrace，否则写到 ~/.seekharness/traces/
  const traceDir = options.traceDir ?? path.join(os.homedir(), ".seekharness", "traces");
  let traceWriter: ReturnType<typeof createTraceWriter> | null = null;
  let onTrace: TraceCallback | undefined = options.onTrace;
  if (!onTrace) {
    fs.mkdirSync(traceDir, { recursive: true });
    const traceName = `${Date.now()}-${path.basename(session.workspaceRoot).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    traceWriter = createTraceWriter(path.join(traceDir, `${traceName}.jsonl`));
    onTrace = (entry) => traceWriter!.write(entry);
  }

  try {
  // Fast-fail if already aborted
  if (signal?.aborted) {
    throw new Error("Agent turn cancelled (signal already aborted)");
  }

  session.messages.push({ role: "user", content: userMessage });

  // ── Trace: user input ──
  onTrace?.({
    ts: turnStartTime,
    type: "user_input",
    turn: 0,
    text: userMessage,
  });

  const registry = createToolRegistry();
  const toolCtx: ToolContext = {
    workspaceRoot: session.workspaceRoot,
    readFiles: new Set<string>(),
    bashPolicy: new DefaultBashPolicy(),
    largeOutputDir: path.join(os.tmpdir(), "seekharness"),
    signal,
  };
  const messages = session.messages;

  let turns = 0;
  let finalText = "";
  let totalToolCalls = 0;
  let exitReason: TraceExitReason = "no_tool_calls";

  // Loop-detection state: track how many times each (tool, args) pair has been called.
  // If any single signature hits MAX_REPEAT we nudge the model once, then hard-break.
  const callSignatures = new Map<string, number>();
  const MAX_REPEAT = 3;
  let loopNudgeSent = false;

  while (turns < maxTurns) {
    // Check for cancellation before each turn
    if (signal?.aborted) {
      finalText += "\n\n[Stopped: cancelled]";
      exitReason = "cancelled";
      break;
    }

    turns++;

    // ── Build request messages (session messages + fresh Agents.md) ──
    const agentsMdContent = readAgentsMd(session.workspaceRoot);
    const requestMessages = agentsMdContent
      ? [...messages, { role: "system" as const, content: agentsMdContent }]
      : messages;

    // ── Trace: LLM start ──
    const llmStartTime = Date.now();
    onTrace?.({
      ts: llmStartTime,
      type: "llm_start",
      turn: turns,
      messageCount: requestMessages.length,
      toolCount: registry.definitions.length,
    });

    // ── Stream the LLM response ──
    let assistantContent = "";

    const assistantMsg = await streamChatWithTools(
      client,
      llmConfig,
      requestMessages,
      registry.definitions,
      (chunk: string) => {
        assistantContent += chunk;
        onStream?.({
          turn: turns,
          type: "assistant_text",
          text: chunk,
        });
      },
      { signal },
    );

    // ── Trace: LLM end ──
    const llmEndTime = Date.now();
    const toolCalls = (assistantMsg as any).tool_calls ?? [];
    onTrace?.({
      ts: llmEndTime,
      type: "llm_end",
      turn: turns,
      content: assistantContent || null,
      toolCalls: toolCalls.map((tc: any) => ({
        id: tc.id,
        name: tc.function.name,
        args: tc.function.arguments,
      })),
      durationMs: llmEndTime - llmStartTime,
    });

    messages.push(assistantMsg);

    // Track the full text for the final result. Prefer the streaming
    // accumulator (always in sync with what we showed the user) over
    // assistantMsg.content, which we now guarantee is a string.
    if (assistantContent) {
      finalText = assistantContent;
      onTurn?.({
        turn: turns,
        role: "assistant",
        preview: truncate(assistantContent, 200),
      });
    }

    // No tool calls → we're done with this turn
    if (toolCalls.length === 0) {
      exitReason = "no_tool_calls";
      break;
    }

    // ── Execute tool calls ──
    // Classify: read-only tools (read/glob/grep) are safe to parallelize;
    // write tools (write/edit/bash) must run serially due to side effects.
    const readOnlyCalls = toolCalls.filter((c: ChatCompletionMessageToolCall) => registry.isReadOnly(c.function.name));
    const writeCalls = toolCalls.filter((c: ChatCompletionMessageToolCall) => !registry.isReadOnly(c.function.name));

    // Collect results keyed by call.id so we can push in original order
    const resultsByCallId = new Map<string, ChatCompletionMessageParam>();

    const execOne = async (call: ChatCompletionMessageToolCall): Promise<void> => {
      if (signal?.aborted) return; // skip if cancelled mid-batch

      // ── Trace: tool start ──
      onTrace?.({
        ts: Date.now(),
        type: "tool_start",
        turn: turns,
        toolCallId: call.id,
        toolName: call.function.name,
        args: call.function.arguments,
      });

      onStream?.({
        turn: turns,
        type: "tool_start",
        text: `${call.function.name}(${truncate(call.function.arguments, 80)})`,
      });

      const result = await handleToolCall(call, registry, toolCtx, onTurn, turns, session.toolTimestamps, onTrace);
      resultsByCallId.set(call.id, result);

      onStream?.({
        turn: turns,
        type: "tool_end",
        text: truncate(result.content as string, 120),
      });
    };

    // 1) Read-only tools → parallel
    if (readOnlyCalls.length > 0) {
      await Promise.all(readOnlyCalls.map(execOne));
    }

    // 2) Write tools → serial (preserve side-effect ordering)
    for (const call of writeCalls) {
      await execOne(call);
    }

    // Push results in the original call order for message consistency
    for (const call of toolCalls) {
      const result = resultsByCallId.get(call.id);
      if (result) messages.push(result);
    }

    totalToolCalls += toolCalls.length;

    // ── Loop detection: track repeated (tool, args) signatures ──
    let repeatDetected = false;
    for (const call of toolCalls) {
      const sig = `${call.function.name}:${call.function.arguments}`;
      const count = (callSignatures.get(sig) ?? 0) + 1;
      callSignatures.set(sig, count);
      if (count >= MAX_REPEAT) repeatDetected = true;
    }

    if (repeatDetected) {
      exitReason = "loop_detected";
      if (!loopNudgeSent) {
        // Give the model one chance to wrap up gracefully.
        messages.push({
          role: "user",
          content:
            "[System: You appear to be stuck — the same tool call has been made 3+ times with identical arguments. Stop calling tools and provide your final answer now.]",
        });
        loopNudgeSent = true;
      } else {
        // Model still looping after the nudge — hard stop.
        finalText += "\n\n[Stopped: loop detected]";
        break;
      }
    }

    //  每轮工具执行后，检查消息预算，超了就从最老的开始裁
    compressHistory(messages, session.toolTimestamps);
  }

  if (turns >= maxTurns) {
    finalText += "\n\n[Stopped: max turns reached]";
    exitReason = "max_turns";
  }

  // ── Trace: exit ──
  onTrace?.({
    ts: Date.now(),
    type: "exit",
    turn: turns,
    reason: exitReason,
    durationMs: Date.now() - turnStartTime,
    totalToolCalls,
  });

  return { finalText, turns };
  } finally {
    traceWriter?.close();
  }
}

/** @deprecated Use createAgentSession + runAgentTurn for multi-turn chat */
export async function runAgentLoop(options: {
  client: OpenAI;
  llmConfig: LlmConfig;
  workspaceRoot: string;
  userMessage: string;
  maxTurns?: number;
  onTurn?: AgentTurnOptions["onTurn"];
}): Promise<AgentLoopResult & { messages: ChatCompletionMessageParam[] }> {
  const session = createAgentSession(options.workspaceRoot);
  const result = await runAgentTurn(session, options.userMessage, {
    client: options.client,
    llmConfig: options.llmConfig,
    maxTurns: options.maxTurns,
    onTurn: options.onTurn,
  });
  return { ...result, messages: session.messages };
}

async function handleToolCall(
  call: ChatCompletionMessageToolCall,
  registry: ReturnType<typeof createToolRegistry>,
  toolCtx: ToolContext,
  onTurn: AgentTurnOptions["onTurn"],
  turn: number,
  store: ToolTimestampStore,
  onTrace?: TraceCallback,
): Promise<ChatCompletionMessageParam> {
  const fn = call.function;
  let args: unknown = {};
  const toolStartTime = Date.now();

  try {
    args = JSON.parse(fn.arguments || "{}");
  } catch {
    const errMsg = "Invalid JSON in tool arguments";
    onTurn?.({ turn, role: "tool", preview: `${fn.name}: ${errMsg}` });
    const errResult: ChatCompletionMessageParam = {
      role: "tool",
      tool_call_id: call.id,
      content: errMsg,
    };
    markToolTimestamp(errResult, store);

    // ── Trace: tool end (error) ──
    onTrace?.({
      ts: Date.now(),
      type: "tool_end",
      turn,
      toolCallId: call.id,
      toolName: fn.name,
      output: errMsg,
      success: false,
      durationMs: Date.now() - toolStartTime,
    });

    return errResult;
  }

  onTurn?.({
    turn,
    role: "tool",
    preview: `${fn.name}(${truncate(fn.arguments, 80)})`,
  });

  const result = await registry.run(fn.name, args, toolCtx);

  // ── Trace: tool end (full output, before truncation) ──
  const fullOutput = result.success
    ? result.output
    : `Error: ${result.output}`;
  onTrace?.({
    ts: Date.now(),
    type: "tool_end",
    turn,
    toolCallId: call.id,
    toolName: fn.name,
    output: fullOutput,
    success: result.success,
    durationMs: Date.now() - toolStartTime,
  });

  // 防线1：对工具结果做首尾截断，大输出自动写完整文件
  const content = await truncateOutput(fullOutput, fn.name, toolCtx.largeOutputDir);

  onTurn?.({
    turn,
    role: "tool",
    preview: truncate(content, 120),
  });

  const resultMsg: ChatCompletionMessageParam = {
    role: "tool",
    tool_call_id: call.id,
    content,
  };
  markToolTimestamp(resultMsg, store);
  return resultMsg;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

/**
 * 从 OpenAI 消息数组重建 UI 展示用的 Message 列表。
 * 用于恢复历史对话时重建 UI。
 */
export function reconstructMessages(
  msgs: ChatCompletionMessageParam[],
): { kind: string; text?: string; toolName?: string; args?: string; result?: string }[] {
  const result: { kind: string; text?: string; toolName?: string; args?: string; result?: string }[] = [];

  for (const m of msgs) {
    if (m.role === "system") continue;

    if (m.role === "user") {
      result.push({ kind: "user", text: String(m.content ?? "") });
    } else if (m.role === "assistant") {
      if (m.content) {
        result.push({ kind: "assistant", text: String(m.content) });
      }
      const toolCalls = (m as any).tool_calls;
      if (toolCalls) {
        for (const tc of toolCalls) {
          result.push({
            kind: "tool",
            toolName: tc.function.name,
            args: `${tc.function.name}(${truncate(tc.function.arguments, 80)})`,
            result: "",
          });
        }
      }
    } else if (m.role === "tool") {
      // 回填上一条无结果的 tool 消息
      for (let i = result.length - 1; i >= 0; i--) {
        if (result[i]?.kind === "tool" && result[i]?.result === "") {
          result[i] = { ...result[i], result: truncate(String(m.content ?? ""), 120) };
          break;
        }
      }
    }
  }

  return result as any;
}
