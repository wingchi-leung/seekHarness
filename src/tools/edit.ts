import fs from "node:fs/promises";
import { z } from "zod";
import type { Tool } from "./types.js";
import { resolveWorkspacePath } from "./paths.js";

const editSchema = z.object({
  path: z.string().min(1).describe("Relative path to the file"),
  old_string: z
    .string()
    .describe("Exact text to replace. Must appear exactly once in the file."),
  new_string: z.string().describe("Replacement text"),
});

export type EditInput = z.infer<typeof editSchema>;

export const editTool: Tool<EditInput> = {
  meta: {
    type: "function",
    function: {
      name: "edit",
      description:
        "Replace an exact unique substring in a file. old_string must match exactly once. Use read first to get the exact content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the file" },
          old_string: {
            type: "string",
            description: "Exact substring to replace (must be unique)",
          },
          new_string: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },

  validate(args: unknown): EditInput {
    return editSchema.parse(args);
  },

  async execute(input, ctx) {
    try {
      const absPath = await resolveWorkspacePath(ctx.workspaceRoot, input.path);
      const content = await fs.readFile(absPath, "utf-8");

      const count = countOccurrences(content, input.old_string);
      if (count === 0) {
        return {
          success: false,
          output: `old_string not found in ${input.path}`,
        };
      }
      if (count > 1) {
        return {
          success: false,
          output: `old_string appears ${count} times in ${input.path}; must be unique`,
        };
      }

      const updated = content.replace(input.old_string, input.new_string);
      await fs.writeFile(absPath, updated, "utf-8");

      return {
        success: true,
        output: `Updated ${input.path}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: message };
    }
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}
