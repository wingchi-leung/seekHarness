import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
import type { Tool } from "./types.js";
import { resolveWorkspacePath } from "./paths.js";

const writeSchema = z.object({
  file_path: z
    .string()
    .min(1)
    .describe("Relative path to the file inside the workspace"),
  content: z.string().describe("Full contents to write to the file"),
});

export type WriteInput = z.infer<typeof writeSchema>;

export const writeTool: Tool<WriteInput> = {
  meta: {
    type: "function",
    function: {
      name: "write",
      description:
        "Create a new file or overwrite an existing file with the full content provided. Overwriting an existing file requires reading it first in the current session. Use edit for partial changes.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Relative path to the file inside the workspace",
          },
          content: {
            type: "string",
            description: "Full contents to write to the file",
          },
        },
        required: ["file_path", "content"],
      },
    },
  },

  validate(args: unknown): WriteInput {
    return writeSchema.parse(args);
  },

  async execute(input, ctx) {
    try {
      const absPath = await resolveWorkspacePath(ctx.workspaceRoot, input.file_path);

      // 检查文件存在性
      let exists = false;
      try {
        const stat = await fs.stat(absPath);
        exists = stat.isFile();
      } catch {
        exists = false;
      }

      // Read-before-Write 校验
      if (exists && !ctx.readFiles.has(absPath)) {
        return {
          success: false,
          output: `Error: Must read ${input.file_path} before overwriting. Use the read tool first to see the current contents.`,
        };
      }

      // 自动建父目录
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, input.content, "utf-8");

      // 记录已读（新建和覆盖都加）
      ctx.readFiles.add(absPath);

      const bytes = Buffer.byteLength(input.content, "utf-8");
      return {
        success: true,
        output: `${exists ? "Overwrote" : "Created"} ${input.file_path} (${bytes} bytes)`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: message };
    }
  },
};
