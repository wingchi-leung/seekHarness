import { z } from "zod";
import type { Tool } from "./types.js";
import { resolveWorkspacePath, readTextFile } from "./paths.js";

const readSchema = z.object({
  path: z.string().min(1).describe("Relative path to the file inside the workspace"),
});

export type ReadInput = z.infer<typeof readSchema>;

export const readTool: Tool<ReadInput> = {
  isReadOnly: true,
  meta: {
    type: "function",
    function: {
      name: "read",
      description:
        "Read the full contents of a text file in the workspace. Use for inspecting source code or config.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to the file",
          },
        },
        required: ["path"],
      },
    },
  },

  validate(args: unknown): ReadInput {
    return readSchema.parse(args);
  },

  async execute(input, ctx) {
    try {
      const absPath = await resolveWorkspacePath(ctx.workspaceRoot, input.path);
      const content = await readTextFile(absPath);
      ctx.readFiles.add(absPath);
      const lines = content.split("\n");
      const numbered = lines
        .map((line, i) => `${String(i + 1).padStart(6)}|${line}`)
        .join("\n");

      return {
        success: true,
        output: `File: ${input.path} (${lines.length} lines)\n${numbered}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: message };
    }
  },
};
