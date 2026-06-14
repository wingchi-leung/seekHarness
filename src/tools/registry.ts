import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { readTool } from "./read.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { writeTool } from "./write.js";
import { grepTool } from "./grep.js";
import { bashTool } from "./bash.js";

const ALL_TOOLS: Tool[] = [
  readTool,
  editTool,
  globTool,
  writeTool,
  grepTool,
  bashTool,
];

export function createToolRegistry(): {
  definitions: ChatCompletionTool[];
  run(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult>;
  isReadOnly(name: string): boolean;
} {
  const byName = new Map(ALL_TOOLS.map((t) => [t.meta.function!.name, t]));

  return {
    definitions: ALL_TOOLS.map((t) => t.meta),

    async run(name, args, ctx) {
      const tool = byName.get(name);
      if (!tool) {
        return { success: false, output: `Unknown tool: ${name}` };
      }

      try {
        const input = tool.validate(args);
        return await tool.execute(input, ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: `Validation error: ${message}` };
      }
    },

    isReadOnly(name: string): boolean {
      return byName.get(name)?.isReadOnly ?? false;
    },
  };
}
