import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

export interface PromptSection {
  key: string;
  content: string;
}

export const IDENTITY_SECTION: PromptSection = {
  key: "identity",
  content: `You are seekHarness, a cli agent that helps users with software development tasks.

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
           Use bash to verify: build (e.g. \`npx tsc --noEmit\`), test, lint, git status.`,
};

export const WORKFLOW_SECTION: PromptSection = {
  key: "workflow",
  content: `Workflow:
1. Understand: use glob/grep to map the codebase. Don't guess paths.
2. Read before you write: read first, then edit/write. Use edit for small changes, write for new files.
3. Verify: after non-trivial changes, run a build/test command via bash to confirm nothing broke.
4. Recover: if a tool returns an error, read the error, adjust, retry. Don't repeat the same failing call.
5. Finish: each time you're about to call a tool, ask yourself if the task is complete. Once the task is complete, STOP calling tools and write your final reply. Do not call tools after you have already verified the result. Repeating the same tool call is always wrong — if you've already read a file or run a command, use the result you already have.`,
};

export const SAFETY_SECTION: PromptSection = {
  key: "safety",
  content: `Safety: bash is gated by a deny-list (rm -rf /, mkfs, fork bombs, curl|sh, etc.). The user can set
SEEKHARNESS_ALLOW_DANGEROUS=1 to override. When set, you'll see a red warning printed to the terminal
(the warning is for the human, not part of the tool result).

Constraints:
- All file paths in read/write/edit/glob/grep are relative to the workspace root.
- Bash runs in the workspace root by default; absolute paths are fine inside the command itself.
- Keep grep output small: when many files match, switch to output_mode "count" or "files_with_matches".
- Don't pipe untrusted content into bash. Don't fetch and execute remote code.
- Old tool results (beyond the most recent 5 tool calls) are auto-cleared to save context. The tool message stays but its content is replaced with "[Old tool result cleared]". If you need that info again, just re-run the tool.`,
};

/** Agents.md 区块内容的前缀标记，用于在 messages 中定位该区块 */
export const AGENTS_CONTEXT_PREFIX = "## Agents Context (from Agents.md)";

export function agentsMdSection(content: string): PromptSection {
  return {
    key: "agents-context",
    content: `${AGENTS_CONTEXT_PREFIX}\n\n${content}`,
  };
}

export const DEFAULT_SECTION_ORDER: readonly string[] = [
  "identity",
  "workflow",
  "safety",
  "agents-context",
];

export interface BuildSystemMessagesOptions {
  /** Agents.md 内容（可选），将作为独立的 "agents-context" 区块加入 */
  agentsMd?: string;
  /** 额外的自定义区块，追加在默认区块之后 */
  extraSections?: PromptSection[];
  /**
   * 区块顺序（按 key 指定）。
   * 未在该列表中的区块会被追加到末尾。
   * 默认为 DEFAULT_SECTION_ORDER。
   */
  sectionOrder?: readonly string[];
}

/**
 * 从结构化区块构建 system message 列表。
 * 每个区块输出一条独立的 { role: "system", content } 消息。
 *
 * @example
 * ```ts
 * const messages = buildSystemMessages({ agentsMd: "## Goal\n..." });
 * // [
 * //   { role: "system", content: "You are seekHarness..." },
 * //   { role: "system", content: "Workflow:\n1. ..." },
 * //   { role: "system", content: "Safety: ..." },
 * //   { role: "system", content: "## Agents Context\n..." },
 * // ]
 * ```
 */
export function buildSystemMessages(
  options: BuildSystemMessagesOptions = {},
): ChatCompletionMessageParam[] {
  const {
    agentsMd,
    extraSections = [],
    sectionOrder = DEFAULT_SECTION_ORDER,
  } = options;

  // 收集所有有效区块
  const sections = new Map<string, PromptSection>();
  sections.set(IDENTITY_SECTION.key, IDENTITY_SECTION);
  sections.set(WORKFLOW_SECTION.key, WORKFLOW_SECTION);
  sections.set(SAFETY_SECTION.key, SAFETY_SECTION);
  if (agentsMd) {
    sections.set("agents-context", agentsMdSection(agentsMd));
  }
  for (const extra of extraSections) {
    sections.set(extra.key, extra);
  }

  // 按指定顺序输出，未在顺序列表中的追加到末尾
  const messages: ChatCompletionMessageParam[] = [];
  const added = new Set<string>();

  for (const key of sectionOrder) {
    const section = sections.get(key);
    if (section) {
      messages.push({ role: "system", content: section.content });
      added.add(key);
    }
  }

  for (const [key, section] of sections) {
    if (!added.has(key)) {
      messages.push({ role: "system", content: section.content });
    }
  }

  return messages;
}

/**
 * 将所有区块平铺为一条 system message（用双换行分隔）。
 * 用于不支持多条 system message 的 provider 作为回退。
 */
export function getFlatSystemPrompt(
  options: BuildSystemMessagesOptions = {},
): string {
  return buildSystemMessages(options)
    .map((m) => m.content as string)
    .join("\n\n");
}
