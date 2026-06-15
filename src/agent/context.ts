import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

// ─── 防线 1：工具结果截断 ───

const MAX_PREFIX = 3_000;
const MAX_SUFFIX = 2_000;
const MAX_TOTAL = MAX_PREFIX + MAX_SUFFIX + 200; // ~5200

/**
 * 对大工具输出做首尾截断，保留开头 ~3k + 结尾 ~2k。
 * 如果被截断且 outputDir 不为空，完整输出写到文件（LLM 可按需 read）。
 * 如果 outputDir 为空，只截断提示但不写文件。
 */
export async function truncateOutput(
  output: string,
  toolName: string,
  outputDir?: string,
): Promise<string> {
  if (output.length <= MAX_TOTAL) return output;

  const prefix = output.slice(0, MAX_PREFIX);
  const suffix = output.slice(-MAX_SUFFIX);
  const truncatedLen = output.length - MAX_PREFIX - MAX_SUFFIX;

  let filePath = ".seekharness/output.txt";
  if (outputDir) {
    filePath = await writeFullOutput(output, toolName, outputDir);
  }

  return [
    prefix,
    `\n\n[... ${truncatedLen.toLocaleString()} chars truncated; `,
    `full ${toolName} output saved to: ${filePath}]\n\n`,
    suffix,
    `\n\n[Use the read tool with the path above to see full output]`,
  ].join('');
}

async function writeFullOutput(
  content: string,
  toolName: string,
  outputDir: string,
): Promise<string> {
  await fs.mkdir(outputDir, { recursive: true });
  const filename = `${toolName}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.txt`;
  const filePath = path.join(outputDir, filename);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

// ─── 防线 2：Timebased Content Eviction ───
//
// Claude Code 风格：不动消息结构，只清空旧 tool 的 content。
// 你的规则：5 分钟（timebased），不是按条数。
//
// 每个 tool result 产生时记录 Date.now()。
// 超过 5 分钟的 tool result content 被清空，消息本身还在。
// assistant 的 tool_calls / reasoning_content 原封不动。

/** tool result 存活时间（毫秒） */
const TOOL_TTL_MS = 5 * 60 * 1000; // 5 分钟

/** 时间戳存储：tool_call_id → Date.now()，由调用方持有（可序列化） */
export type ToolTimestampStore = Record<string, number>;

/** 创建一个空的 timestamp store */
export function createToolTimestampStore(): ToolTimestampStore {
  return {};
}

/**
 * 记录 tool result 的产生时间。在 push 到 messages 前调用。
 */
export function markToolTimestamp(
  msg: ChatCompletionMessageParam,
  store: ToolTimestampStore,
): void {
  if (msg.role === "tool" && msg.tool_call_id) {
    store[msg.tool_call_id] = Date.now();
  }
}

/**
 * 按时间清空旧 tool 结果的 content，不删消息，不动 assistant。
 *
 * 超过 5 分钟的 tool result → content 变成 "[Old tool result cleared]"
 * assistant 消息（tool_calls, reasoning_content）→ 原封不动
 * tool 消息本身 → 保留，只清 content
 *
 * @param messages  历史消息数组
 * @param store     时间戳存储（tool_call_id → timestamp）
 */
export function compressHistory(
  messages: ChatCompletionMessageParam[],
  store: ToolTimestampStore,
): void {
  const now = Date.now();
  const clearCallIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== "tool" || !msg.tool_call_id) continue;
    const ts = store[msg.tool_call_id];
    if (ts !== undefined && now - ts > TOOL_TTL_MS) {
      clearCallIds.add(msg.tool_call_id);
    }
  }

  if (clearCallIds.size === 0) return;

  for (const msg of messages) {
    if (msg.role === "tool" && msg.tool_call_id && clearCallIds.has(msg.tool_call_id)) {
      (msg as any).content = "[Old tool result cleared]";
    }
  }
}
