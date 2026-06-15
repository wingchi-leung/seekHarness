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

/**
 * 如果一个命令持续运行超过超时时间（如 npm run dev），
 * 我们不杀它，而是 detach 并返回已有输出。
 * 但为了不无限等待 close 事件（Windows 上 orphaned 子进程可能
 * 持住 pipe 句柄导致 close 永不触发），设置一个较短的安全兜底。
 */
const DETACH_GRACE_MS = 2_000;

/**
 * 全局进程注册表，用于追踪被 detach 的后台进程。
 * Session 结束时 cleanup 调此函数杀掉所有孤儿进程。
 */
const backgroundProcesses = new Map<string, { pid: number; label: string }>();
let bgCounter = 0;
export function getBackgroundProcesses() {
  return Array.from(backgroundProcesses.entries());
}
export function cleanupBackgroundProcesses(): void {
  const isWin = process.platform === "win32";
  for (const [id, info] of backgroundProcesses) {
    try {
      killProcessTree(info.pid, isWin);
    } catch { /* ignore */ }
    backgroundProcesses.delete(id);
  }
}

export const bashTool: Tool<BashInput> = {
  meta: {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command in the workspace root. Default 2min timeout, max 10min. " +
        "Output >30000 chars is truncated and saved to a temp file (path returned). " +
        "Returns exit code in the output. " +
        "Append ' &' at the end to start a background process (detached). " +
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

    // 3. 检测 background 命令（以 & 结尾）
    const trimmedCmd = input.command.trimEnd();
    const isBackground = trimmedCmd.endsWith(" &");
    const realCmd = isBackground ? trimmedCmd.slice(0, -2).trimEnd() : trimmedCmd;

    // 4. 如果是 background，detach 后立即返回
    if (isBackground) {
      runBackground(realCmd, ctx.workspaceRoot);
      return {
        success: true,
        output: `$ ${input.command}\n[Background process started]`,
      };
    }

    // 5. 确定超时
    const timeoutMs = Math.min(
      input.timeout ?? DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    );

    // 6. 执行
    const result = await runCommand(realCmd, {
      cwd: ctx.workspaceRoot,
      timeoutMs,
      signal: ctx.signal,
    });

    // 7. 处理超时
    if (result.timedOut) {
      return {
        success: false,
        output:
          `Error: command timed out after ${timeoutMs}ms.\n` +
          `Partial output before timeout:\n${truncate(result.stdout + result.stderr, 2000)}`,
      };
    }

    // 8. 处理取消
    if (result.cancelled) {
      return {
        success: false,
        output: "Error: execution cancelled by AbortSignal",
      };
    }

    // 9. 拼接 stdout + stderr
    const combined = result.stderr
      ? `${result.stdout}${result.stdout ? "\n" : ""}[stderr]\n${result.stderr}`
      : result.stdout;

    // 10. 输出截断 + 写临时文件
    const truncated = await handleLargeOutput(combined, ctx.largeOutputDir);

    const exitNote = result.exitCode === 0 ? "" : `\n(exit ${result.exitCode})`;
    return {
      success: result.exitCode === 0,
      output: `$ ${input.command}\n${truncated}${exitNote}`,
    };
  },
};

/**
 * 启动一个后台进程，detach 并 unref，不等待它退出。
 * 用于处理以 & 结尾的命令（如 `npm run dev &`）。
 */
function runBackground(command: string, cwd: string): void {
  const isWin = process.platform === "win32";
  const proc = isWin
    ? spawn("cmd.exe", ["/d", "/s", "/c", command], {
        cwd,
        windowsHide: true,
        shell: false,
        detached: true,
        stdio: "ignore",
      })
    : spawn("sh", ["-c", command], {
        cwd,
        shell: false,
        detached: true,
        stdio: "ignore",
      });
  proc.unref();
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  cancelled: boolean;
}

/**
 * Kill an entire process tree.
 * - On Windows: uses `taskkill /F /T` to kill the tree (critical for `cmd.exe /c npm run dev`
 *   scenarios where orphaned children hold the stdout pipe open, preventing the 'close' event).
 * - On POSIX: sends SIGTERM to the process group (negative pid).
 */
function killProcessTree(pid: number, isWin: boolean): void {
  if (isWin) {
    try {
      const child = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    } catch {
      // silently fall back to just killing the direct child
      try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
    }
  } else {
    // POSIX: kill the process group (negative pid = pgid)
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
    }
  }
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

    // Windows: cmd.exe /c <command>; POSIX 用 sh -c
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

    // ── Safety: flag + fallback timer to prevent hanging if close never fires ──
    let resolved = false;
    let safetyTimer: NodeJS.Timeout | undefined;

    function forceResolve(reason: "timeout" | "cancelled" | "error" | "close") {
      if (resolved) return;
      resolved = true;
      cleanup();
      if (reason === "timeout") {
        resolve({
          stdout,
          stderr: stderr + "\n[Process timed out; forcefully resolved]",
          exitCode: 1,
          timedOut: true,
          cancelled: false,
        });
      } else if (reason === "cancelled") {
        resolve({
          stdout,
          stderr: stderr + "\n[Process cancelled; forcefully resolved]",
          exitCode: 1,
          timedOut: false,
          cancelled: true,
        });
      }
    }

    // ── Timeout timer ──
    const timer = setTimeout(() => {
      killed = true;
      killProcessTree(proc.pid!, isWin);
      // Safety fallback: if close event doesn't fire within 7s (Windows: orphaned
      // children like npm/node may still hold the stdout pipe handle), force-resolve.
      safetyTimer = setTimeout(() => forceResolve("timeout"), DETACH_GRACE_MS + 2000);
    }, opts.timeoutMs);

    // ── AbortSignal listener ──
    const onAbort = () => {
      if (killed) return; // already handled by timeout
      killed = true;
      cancelled = true;
      killProcessTree(proc.pid!, isWin);
      safetyTimer = setTimeout(() => forceResolve("cancelled"), DETACH_GRACE_MS + 2000);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(safetyTimer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    proc.on("error", (err) => {
      cleanup();
      if (!resolved) {
        resolved = true;
        resolve({
          stdout,
          stderr: stderr || err.message,
          exitCode: 1,
          timedOut: false,
          cancelled: false,
        });
      }
    });

    proc.on("close", (code) => {
      cleanup();
      if (!resolved) {
        resolved = true;
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 0,
          timedOut: killed && !cancelled,
          cancelled,
        });
      }
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
