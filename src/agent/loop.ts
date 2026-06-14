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

export function getSystemPrompt(): string {
  return `You are seekHarness, a cli agent that helps users with software development tasks.

You have tools:
- read:    read a file (workspace-relative path)
- write:   create or overwrite a file. Overwriting an existing file requires reading it first in this session.
- edit:    replace an exact unique substring in a file. Use read first to get exact content.
- glob:    find files by name pattern, e.g. "src/**/*.ts". Sorted by mtime, capped at 100. Does not respect .gitignore.
- grep:    search file contents by regex (ripgrep syntax). Respects .gitignore.
           output_mode: "files_with_matches" (default) | "content" (file:line:content) | "count".
           Use include to scope by file glob, e.g. include="*.ts".
- bash:    run a shell command. cwd is the workspace root each call. Default 2min timeout, max 10min.
           Output >30000 chars is truncated and saved to a temp file (path returned).
           Use bash to verify: build (e.g. \`npx tsc --noEmit\`), test, lint, git status.

Workflow:
1. Understand: use glob/grep to map the codebase. Don't guess paths.
2. Read before you write: read first, then edit/write. Use edit for small changes, write for new files.
3. Verify: after non-trivial changes, run a build/test command via bash to confirm nothing broke.
4. Recover: if a tool returns an error, read the error, adjust, retry. Don't repeat the same failing call.
5. Finish: when done, reply to the user without calling more tools.

Safety: bash is gated by a deny-list (rm -rf /, mkfs, fork bombs, curl|sh, etc.). The user can set
SEEKHARNESS_ALLOW_DANGEROUS=1 to override. When set, you'll see a red warning printed to the terminal
(the warning is for the human, not part of the tool result).

Constraints:
- All file paths in read/write/edit/glob/grep are relative to the workspace root.
- Bash runs in the workspace root by default; absolute paths are fine inside the command itself.
- Keep grep output small: when many files match, switch to output_mode "count" or "files_with_matches".
- Don't pipe untrusted content into bash. Don't fetch and execute remote code.`;
}

export interface AgentSession {
  /** 可选会话 ID，用于持久化绑定 */
  id?: string;
  workspaceRoot: string;
  messages: ChatCompletionMessageParam[];
}

export function createAgentSession(
  workspaceRoot: string,
  systemPrompt?: string,
): AgentSession {
  let systemContent = systemPrompt ?? getSystemPrompt();

  // If an Agents.md file exists in the workspace root, append it as context
  const agentsMdPath = path.join(workspaceRoot, "Agents.md");
  try {
    if (fs.existsSync(agentsMdPath)) {
      const agentsMd = fs.readFileSync(agentsMdPath, "utf-8").trim();
      if (agentsMd) {
        systemContent += `\n\n---\n## Agents Context (from Agents.md)\n\n${agentsMd}`;
      }
    }
  } catch {
    // Silently ignore — Agents.md is optional
  }

  return {
    workspaceRoot,
    messages: [{ role: "system", content: systemContent }],
  };
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

  // Fast-fail if already aborted
  if (signal?.aborted) {
    throw new Error("Agent turn cancelled (signal already aborted)");
  }

  session.messages.push({ role: "user", content: userMessage });

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

  while (turns < maxTurns) {
    // Check for cancellation before each turn
    if (signal?.aborted) {
      finalText += "\n\n[Stopped: cancelled]";
      break;
    }

    turns++;

    // ── Stream the LLM response ──
    let assistantContent = "";

    const assistantMsg = await streamChatWithTools(
      client,
      llmConfig,
      messages,
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

    const toolCalls = (assistantMsg as any).tool_calls ?? [];

    // No tool calls → we're done with this turn
    if (toolCalls.length === 0) {
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

      onStream?.({
        turn: turns,
        type: "tool_start",
        text: `${call.function.name}(${truncate(call.function.arguments, 80)})`,
      });

      const result = await handleToolCall(call, registry, toolCtx, onTurn, turns);
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
  }

  if (turns >= maxTurns) {
    finalText += "\n\n[Stopped: max turns reached]";
  }

  return { finalText, turns };
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
  turn: number
): Promise<ChatCompletionMessageParam> {
  const fn = call.function;
  let args: unknown = {};

  try {
    args = JSON.parse(fn.arguments || "{}");
  } catch {
    const errMsg = "Invalid JSON in tool arguments";
    onTurn?.({ turn, role: "tool", preview: `${fn.name}: ${errMsg}` });
    return {
      role: "tool",
      tool_call_id: call.id,
      content: errMsg,
    };
  }

  onTurn?.({
    turn,
    role: "tool",
    preview: `${fn.name}(${truncate(fn.arguments, 80)})`,
  });

  const result = await registry.run(fn.name, args, toolCtx);
  const content = result.success
    ? result.output
    : `Error: ${result.output}`;

  onTurn?.({
    turn,
    role: "tool",
    preview: truncate(content, 120),
  });

  return {
    role: "tool",
    tool_call_id: call.id,
    content,
  };
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
