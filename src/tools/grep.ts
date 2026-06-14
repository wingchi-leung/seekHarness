import { spawn } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";
import { z } from "zod";
import type { Tool } from "./types.js";
import { resolveWorkspacePath } from "./paths.js";

const grepSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe("Regex pattern (ripgrep regex syntax, not POSIX grep)"),
  path: z
    .string()
    .optional()
    .describe("Search root, relative to workspace root. Defaults to '.'"),
  include: z
    .string()
    .optional()
    .describe("File glob filter, e.g. '*.ts' or 'src/**/*.tsx'"),
  output_mode: z
    .enum(["files_with_matches", "content", "count"])
    .optional()
    .default("files_with_matches")
    .describe(
      "files_with_matches (default) | content (with line numbers) | count (per file)"
    ),
  multiline: z
    .boolean()
    .optional()
    .default(false)
    .describe("Match across line boundaries"),
});

export type GrepInput = z.infer<typeof grepSchema>;

const RESULT_CAP = 100;

export const grepTool: Tool<GrepInput> = {
  isReadOnly: true,
  meta: {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search file contents for a regex pattern (ripgrep syntax). Respects .gitignore. Three output modes: 'files_with_matches' (default, file paths only), 'content' (matching lines with file:line:content), 'count' (match count per file). Use include to scope by file glob.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regex pattern",
          },
          path: {
            type: "string",
            description:
              "Search root, relative to workspace root. Defaults to '.'",
          },
          include: {
            type: "string",
            description: "File glob filter, e.g. '*.ts'",
          },
          output_mode: {
            type: "string",
            enum: ["files_with_matches", "content", "count"],
            description:
              "files_with_matches (default) | content | count",
          },
          multiline: {
            type: "boolean",
            description: "Match across line boundaries",
          },
        },
        required: ["pattern"],
      },
    },
  },

  validate(args: unknown): GrepInput {
    return grepSchema.parse(args);
  },

  async execute(input, ctx) {
    try {
      const searchRootRel = input.path ?? ".";
      const searchRootAbs = await resolveWorkspacePath(
        ctx.workspaceRoot,
        searchRootRel
      );

      const args: string[] = ["--no-heading", "--no-config"];

      switch (input.output_mode) {
        case "files_with_matches":
          args.push("-l");
          break;
        case "content":
          args.push("-n");
          break;
        case "count":
          args.push("-c");
          break;
      }

      if (input.multiline) {
        args.push("--multiline", "--multiline-dotall");
      }

      if (input.include) {
        args.push("--glob", input.include);
      }

      args.push(input.pattern, searchRootAbs);

      const { stdout, stderr, exitCode } = await runRg(args);

      // rg exit codes: 0=found, 1=not found, 2+=error
      if (exitCode === 1) {
        return {
          success: true,
          output: `No matches for "${input.pattern}" in ${searchRootRel}`,
        };
      }
      if (exitCode >= 2) {
        return {
          success: false,
          output: `ripgrep error (exit ${exitCode}): ${stderr.trim() || "(no stderr)"}`,
        };
      }

      return {
        success: true,
        output: formatOutput(
          stdout,
          input.output_mode ?? "files_with_matches",
          searchRootAbs,
          searchRootRel
        ),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: message };
    }
  },
};

interface RgResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runRg(args: string[]): Promise<RgResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(rgPath, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk.toString("utf-8")));
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString("utf-8")));
    proc.on("error", reject);
    proc.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

function formatOutput(
  raw: string,
  mode: "files_with_matches" | "content" | "count",
  absRoot: string,
  relRoot: string
): string {
  // ripgrep 在 Windows 上路径里也用 \，统一替换便于显示
  const normalized = raw.replace(/\\/g, "/").trim();
  if (!normalized) {
    return `No matches in ${relRoot}`;
  }

  const lines = normalized.split("\n");

  if (mode === "files_with_matches") {
    // 把绝对路径裁回相对 workspaceRoot
    const relPaths = lines
      .map((p) => p.replace(absRoot.replace(/\\/g, "/"), "").replace(/^\/+/, ""))
      .slice(0, RESULT_CAP);
    const total = lines.length;
    const truncated = total > RESULT_CAP;
    const header = truncated
      ? `Found ${total} files matching pattern in ${relRoot} (showing ${RESULT_CAP}):`
      : `Found ${total} file${total === 1 ? "" : "s"} matching pattern in ${relRoot}:`;
    return `${header}\n${relPaths.join("\n")}${
      truncated ? "\n... (truncated, narrow include/path to see more)" : ""
    }`;
  }

  if (mode === "count") {
    // count 模式: file:number
    const relLines = lines
      .map((l) => l.replace(absRoot.replace(/\\/g, "/"), "").replace(/^\/+/, ""))
      .slice(0, RESULT_CAP);
    return `Match counts in ${relRoot}:\n${relLines.join("\n")}${
      relLines.length < lines.length
        ? "\n... (truncated)"
        : ""
    }`;
  }

  // content 模式: file:line:content
  const relLines = lines
    .map((l) => l.replace(absRoot.replace(/\\/g, "/"), "").replace(/^\/+/, ""))
    .slice(0, RESULT_CAP);
  const total = lines.length;
  const truncated = total > RESULT_CAP;
  const header = truncated
    ? `Found ${total} matches in ${relRoot} (showing ${RESULT_CAP}):`
    : `Found ${total} match${total === 1 ? "" : "es"} in ${relRoot}:`;
  return `${header}\n${relLines.join("\n")}${
    truncated ? "\n... (truncated, narrow include/path to see more)" : ""
  }`;
}
