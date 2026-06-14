import type { ChatCompletionTool } from "openai/resources/chat/completions.js";

/**
 * Bash 安全策略接口。glob/write 阶段不实现，留给后续 bash 工具。
 * deny() 返回 null=放行，字符串=拒绝原因。
 */
export interface BashPolicy {
  deny(command: string): string | null;
}

export interface ToolContext {
  workspaceRoot: string;
  /** 本会话已 Read 过的文件绝对路径，用于 write 的 read-before-write 校验 */
  readFiles: Set<string>;
  /** 给后续 bash 工具用的安全策略，glob/write 不需要 */
  bashPolicy?: BashPolicy;
  /** 给后续 bash 工具存放大输出的目录，glob/write 不需要 */
  largeOutputDir?: string;
  /** 用于取消进行中的工具执行（如超时或用户终止） */
  signal?: AbortSignal;
}

export interface ToolResult {
  success: boolean;
  output: string;
}

export interface Tool<TInput = unknown> {
  meta: ChatCompletionTool;
  /** 标记为只读工具（read/glob/grep），可安全并行执行 */
  isReadOnly?: boolean;
  validate(args: unknown): TInput;
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}
