import fg from "fast-glob";
import { z } from "zod";
import type { Tool } from "./types.js";
import { resolveWorkspacePath } from "./paths.js";
const globSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe("Glob pattern, e.g. 'src/**/*.ts' or '**/*.json'"),
  path: z
    .string()
    .optional()
    .describe("Search root, relative to workspace root. Defaults to '.'"),
});

export type GlobInput = z.infer<typeof globSchema>;

const RESULT_CAP = 100;

export const globTool: Tool<GlobInput> = {
  isReadOnly: true,
  meta: {
    type: "function",
    function: {
      name: "glob",
      description:
        "Find files by name pattern (glob). Does not read file contents. Sorted by modification time, capped at 100 results. Does not respect .gitignore, so it can find files like .env.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob pattern, e.g. 'src/**/*.ts' or '**/*.json'",
          },
          path: {
            type: "string",
            description:
              "Search root, relative to workspace root. Defaults to '.'",
          },
        },
        required: ["pattern"],
      },
    },
  },

  validate(args: unknown): GlobInput {
    return globSchema.parse(args);
  },

  async execute(input, ctx) {
    try {
      const searchRootRel = input.path ?? ".";
      const searchRootAbs = await resolveWorkspacePath(
        ctx.workspaceRoot,
        searchRootRel
      );

      const entries = await fg(input.pattern, {
        cwd: searchRootAbs,
        absolute: false,
        stats: true,
        onlyFiles: true,
        dot: false,
        ignore: [],
      });

      // 按 mtime 降序
      entries.sort((a, b) => {
        const am = a.stats?.mtimeMs ?? 0;
        const bm = b.stats?.mtimeMs ?? 0;
        return bm - am;
      });

      const total = entries.length;
      const capped = entries.slice(0, RESULT_CAP);
      const truncated = total > RESULT_CAP;
      // fast-glob 返回的 name 是相对 cwd（搜索根），统一用正斜杠便于阅读
      const paths = capped.map((e) => e.name.replace(/\\/g, "/"));

      if (total === 0) {
        return {
          success: true,
          output: `No files matched "${input.pattern}" in ${searchRootRel}`,
        };
      }

      const header = truncated
        ? `Found ${total}+ files matching "${input.pattern}" in ${searchRootRel} (showing ${RESULT_CAP}, sorted by mtime).\nNarrow the pattern or use grep with output_mode "files_with_matches" to count first.`
        : `Found ${total} file${total === 1 ? "" : "s"} matching "${input.pattern}" in ${searchRootRel} (sorted by mtime):`;

      return {
        success: true,
        output: `${header}\n${paths.join("\n")}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: message };
    }
  },
};
