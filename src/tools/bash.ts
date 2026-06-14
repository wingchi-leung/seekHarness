import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { z } from "zod";
import type { Tool } from "./types.js";
import { DefaultBashPolicy } from "./policy.js";

const bashSchema = z.object({
  command: z.string().min(1).describe("Shell command to execute"),
  description: z
    .string()
    .optional()
    .describe("5-10 word description of what this command does (for the user)"),
  timeout: z
    .number()
    .int()
    .min(1000)
    .max(600_000)
    .optional()
    .describe("Timeout in milliseconds. Default 120000 (2min), max 600000 (10min)"),
});

export type BashInput = z.infer<typeof bashSchema>;

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const OUTPUT_CHAR_CAP = 30_000;
const SIGKILL_GRACE_MS = 5_000;

export const bashTool: Tool<BashInput> = {
  meta: {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command in the workspace root. Default 2min timeout, max 10min. " +
        "Output >30000 chars is truncated and saved to a temp file (path returned). " +
        "Returns exit code in the output. " +
        "Destructive commands (rm -rf /, mkfs, curl|sh, fork bombs, etc.) are blocked by default; " +
        "set SEEKHARNESS_ALLOW_DANGEROUS=1 to allow them.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to execute",
          },
          description: {
            type: "string",
            description:
              "5-10 word description of what this command does (for the user)",
          },
          timeout: {
            type: "number",
            description: "Timeout in ms (default 120000, max 600000)",
          },
        },
        required: ["command"],
      },
    },
  },

  validate(args: unknown): BashInput {
    return bashSchema.parse(args);
  },

  async execute(input, ctx) {
    // 1. 检查是否已被取消
    if (ctx.signal?.aborted) {
      return { success: false, output: "Error: execution cancelled (signal already aborted)" };
    }

    // 2. 安全策略检查
    const policy = ctx.bashPolicy ?? new DefaultBashPolicy();
    const denyReason = policy.deny(input.command);
    if (denyReason !== null) {
      return {
        success: false,
        output: `Error: command blocked by safety policy: ${denyReason}`,
      };
    }

    // 3. 确定超时
    const timeoutMs = Math.min(
      input.timeout ?? DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    );

    // 4. 执行
    const result = await runCommand(input.command, {
      cwd: ctx.workspaceRoot,
      timeoutMs,
      signal: ctx.signal,
    });

    // 5. 处理超时
    if (result.timedOut) {
      return {
        success: false,
        output:
          `Error: command timed out after ${timeoutMs}ms.\n` +
          `Partial output before timeout:\n${truncate(result.stdout + result.stderr, 2000)}`,
      };
    }

    // 6. 处理取消
    if (result.cancelled) {
      return {
        success: false,
        output: "Error: execution cancelled by AbortSignal",
      };
    }

    // 7. 拼接 stdout + stderr
    const combined = result.stderr
      ? `${result.stdout}${result.stdout ? "\n" : ""}[stderr]\n${result.stderr}`
      : result.stdout;

    // 8. 输出截断 + 写临时文件
    const truncated = await handleLargeOutput(combined, ctx.largeOutputDir);

    const exitNote = result.exitCode === 0 ? "" : `\n(exit ${result.exitCode})`;
    return {
      success: result.exitCode === 0,
      output: `$ ${input.command}\n${truncated}${exitNote}`,
    };
  },
};

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  cancelled: boolean;
}

function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal }
): Promise<CommandResult> {
  return new Promise((resolve) => {
    // Already aborted before we started
    if (opts.signal?.aborted) {
      resolve({ stdout: "", stderr: "", exitCode: 1, timedOut: false, cancelled: true });
      return;
    }

    // Windows: cmd.exe /c <command>; POSIX 暂用 sh -c
    const isWin = process.platform === "win32";
    const proc = isWin
      ? spawn("cmd.exe", ["/d", "/s", "/c", command], {
          cwd: opts.cwd,
          windowsHide: true,
          shell: false,
        })
      : spawn("sh", ["-c", command], {
          cwd: opts.cwd,
          shell: false,
        });

    let stdout = "";
    let stderr = "";
    let killed = false;
    let cancelled = false;

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });

    // ── Timeout timer ──
    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, SIGKILL_GRACE_MS);
    }, opts.timeoutMs);

    // ── AbortSignal listener ──
    const onAbort = () => {
      if (killed) return; // already handled by timeout
      killed = true;
      cancelled = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, SIGKILL_GRACE_MS);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    proc.on("error", (err) => {
      cleanup();
      resolve({
        stdout,
        stderr: stderr || err.message,
        exitCode: 1,
        timedOut: false,
        cancelled: false,
      });
    });

    proc.on("close", (code) => {
      cleanup();
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0,
        timedOut: killed && !cancelled,
        cancelled,
      });
    });
  });
}

/**
 * 如果 combined 输出超过 OUTPUT_CHAR_CAP，截断并把全文写到临时文件，返回包含路径的输出。
 * 否则原样返回。
 */
async function handleLargeOutput(
  combined: string,
  largeOutputDir: string | undefined
): Promise<string> {
  if (combined.length <= OUTPUT_CHAR_CAP) {
    return combined;
  }

  const truncated = combined.slice(0, OUTPUT_CHAR_CAP);
  const filePath = await writeOverflowFile(combined, largeOutputDir);
  return (
    `${truncated}\n` +
    `\n... [output truncated: ${combined.length} chars total, showing first ${OUTPUT_CHAR_CAP}]\n` +
    `Full output saved to: ${filePath}\n` +
    `Use the read tool to inspect it.`
  );
}

async function writeOverflowFile(
  content: string,
  largeOutputDir: string | undefined
): Promise<string> {
  const dir = largeOutputDir ?? path.join(os.tmpdir(), "seekharness");
  await fs.mkdir(dir, { recursive: true });
  const filename = `bash-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.txt`;
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
