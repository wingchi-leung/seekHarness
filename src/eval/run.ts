/**
 * seekHarness eval runner — headless entry point for SWE-bench-style evaluation.
 *
 * Usage:
 *   tsx src/eval/run.ts <tasks.jsonl> [options]
 *
 * Options:
 *   --concurrency N     Max parallel tasks (default: 4, env: SEEKHARNESS_EVAL_CONCURRENCY)
 *
 * Input JSONL (one task per line):
 *   {
 *     "instance_id":   "django__django-12345",
 *     "problem_statement": "Bug in X: ...",
 *     "base_commit":   "abc123def...",
 *     "repo":          "https://github.com/django/django",
 *     "repo_dir_name": "django"   // local clone subdir name, optional
 *   }
 *
 * Per task, the runner:
 *   1. Clones the repo into datasets/workspaces/<instance_id>/<repo_dir_name> (if absent).
 *   2. `git checkout <base_commit>`.
 *   3. Starts an agent session with EVAL_SYSTEM_PROMPT.
 *   4. Calls runAgentTurn on the problem statement.
 *   5. Extracts the working-tree diff (tracked + new files) → outputs/patches/<instance_id>.diff.
 *   6. Writes outputs/run-summary.json with per-task status.
 *
 * The actual test scoring is performed separately by scripts/score.py using
 * the official swebench Python package + Docker.
 */

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { execFile as cpExecFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import "../load-env.js";
import { loadLlmConfig, createLlmClient } from "../llm/client.js";
import { createAgentSession, runAgentTurn } from "../agent/loop.js";
import { EVAL_SYSTEM_PROMPT } from "./system-prompt.js";

const execFile = promisify(cpExecFile);

const WORKSPACE_ROOT = path.resolve("datasets", "workspaces");
const PATCHES_DIR = path.resolve("outputs", "patches");
const SUMMARY_PATH = path.resolve("outputs", "run-summary.json");

// Git operations can be slow on bad networks (e.g. 24 KiB/s trans-Pacific
// links to GitHub). Default git transport kills the connection after a few
// seconds of low throughput; we disable that and cap the wall-clock per
// git call instead.
const GIT_CLONE_TIMEOUT_MS = Number(
  process.env.SEEKHARNESS_GIT_CLONE_TIMEOUT_MS ?? 30 * 60 * 1000, // 30 min
);
const GIT_FETCH_TIMEOUT_MS = Number(
  process.env.SEEKHARNESS_GIT_FETCH_TIMEOUT_MS ?? 30 * 60 * 1000,
);
const GIT_SMALL_TIMEOUT_MS = Number(
  process.env.SEEKHARNESS_GIT_SMALL_TIMEOUT_MS ?? 2 * 60 * 1000,
);

/** Run a git command with low-speed-limit disabled and a wall-clock cap. */
function git(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
  const env = {
    ...process.env,
    GIT_HTTP_LOW_SPEED_LIMIT: "0",
    GIT_HTTP_LOW_SPEED_TIME: "0",
  };
  return execFile("git", args, {
    ...opts,
    env,
    timeout: opts.timeoutMs ?? GIT_SMALL_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Retry a git call N times with exponential backoff. The runner does heavy
 * `git clone` / `git fetch` against GitHub from inside mainland China where
 * mid-transfer SSL resets are routine; without retry a single network blip
 * kills the task before the agent ever starts.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  attempts = 3,
  baseDelayMs = 2000,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1) break;
      const wait = baseDelayMs * 2 ** i;
      console.log(
        `  [${label}] attempt ${i + 1}/${attempts} failed: ${(e as Error).message.split("\n")[0]} — retrying in ${wait}ms`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

const MAX_TURNS = Number(process.env.SEEKHARNESS_EVAL_MAX_TURNS ?? 100);
const HARD_TIMEOUT_MS = Number(
  process.env.SEEKHARNESS_EVAL_TIMEOUT_MS ?? 10 * 60 * 1000,
);
const CONCURRENCY = Number(
  process.env.SEEKHARNESS_EVAL_CONCURRENCY ?? 4,
);

export interface EvalTask {
  instance_id: string;
  problem_statement: string;
  base_commit: string;
  repo: string;
  repo_dir_name?: string;
}

export interface TaskResult {
  instance_id: string;
  status: "ok" | "error" | "aborted" | "timeout";
  turns?: number;
  patch_path?: string;
  patch_length?: number;
  error?: string;
  final_text_preview?: string;
}

/** Parse a JSONL file into an array of EvalTask. Throws on the first malformed line. */
export function parseJsonlTasks(text: string): EvalTask[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      throw new Error(`Malformed JSONL at line ${i + 1}: ${(e as Error).message}`);
    }
    const t = obj as Partial<EvalTask>;
    if (!t.instance_id || !t.problem_statement || !t.base_commit || !t.repo) {
      throw new Error(
        `Task at line ${i + 1} missing required fields (instance_id, problem_statement, base_commit, repo)`,
      );
    }
    return t as EvalTask;
  });
}

/** Detect TASK_COMPLETE / TASK_ABORT markers in the agent's final text. */
export function detectSubmissionMarker(
  finalText: string,
): { kind: "complete" } | { kind: "abort"; reason: string } | { kind: "none" } {
  const trimmed = finalText.trim();
  if (/^TASK_COMPLETE\s*$/m.test(trimmed)) return { kind: "complete" };
  const abortMatch = trimmed.match(/^TASK_ABORT:\s*(.+)$/m);
  if (abortMatch) return { kind: "abort", reason: abortMatch[1].trim() };
  return { kind: "none" };
}

/** Extract the working-tree diff of a git repo, including new (untracked) files. */
export async function extractWorkingTreeDiff(cwd: string): Promise<string> {
  // Tracked changes
  const { stdout: tracked } = await execFile("git", ["diff", "--no-color"], {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
  });
  // Untracked but intent-to-add style: stage them first, then diff --cached
  const { stdout: untracked } = await execFile(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { cwd },
  );
  const untrackedFiles = untracked
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (untrackedFiles.length === 0) return tracked;

  // Stage untracked files (intent-to-add keeps content visible in diff --cached)
  await execFile("git", ["add", "--intent-to-add", "--", ...untrackedFiles], {
    cwd,
  });
  const { stdout: newFiles } = await execFile(
    "git",
    ["diff", "--cached", "--no-color"],
    { cwd, maxBuffer: 32 * 1024 * 1024 },
  );
  // Unstage so we don't leave the workspace dirty for the scorer
  await execFile("git", ["reset", "HEAD", "--", ...untrackedFiles], { cwd });
  return tracked + newFiles;
}

async function ensureRepoCloned(
  task: EvalTask,
  workspaceDir: string,
): Promise<string> {
  const dirName = task.repo_dir_name ?? deriveRepoDirName(task.repo);
  const repoDir = path.join(workspaceDir, dirName);
  const exists = await pathExists(repoDir);
  if (exists) {
    const gitDir = path.join(repoDir, ".git");
    if (!(await pathExists(gitDir))) {
      throw new Error(
        `${repoDir} exists but is not a git repo — remove it manually and retry`,
      );
    }
    // Verify the clone has objects (broken HEAD state e.g. django's .invalid ref)
    // Wrap in retry so a transient SSL reset during fetch doesn't kill the task.
    await withRetry(async () => {
      const ok = await execFile("git", ["cat-file", "-t", "HEAD"], { cwd: repoDir })
        .then(() => true)
        .catch(() => false);
      if (!ok) {
        console.log(`[${task.instance_id}] existing clone has broken HEAD — fetching origin...`);
        await withRetry(
          () => execFile("git", ["fetch", "origin"], { cwd: repoDir }),
          `fetch(${task.instance_id})`,
        );
      }
    }, `verify(${task.instance_id})`);
    // Existing clone may have been created before this fix landed, so its
    // working tree could be CRLF (Windows autocrlf default). Force LF to
    // match the diff we capture. Safe no-op on macOS/Linux.
    await execFile("git", ["config", "core.autocrlf", "false"], { cwd: repoDir });
    return repoDir;
  }
  console.log(`[${task.instance_id}] cloning ${task.repo} → ${repoDir}`);
  // --no-checkout avoids the "broken HEAD / .invalid ref" problem on repos
  // that changed their default branch name (e.g. django master→main).
  // We fetch all objects separately so any base_commit is reachable.
  // The whole clone+fetch is wrapped in retry — a single SSL reset on a
  // 1-GB repo would otherwise waste 5-15 min of work.
  await withRetry(async () => {
    await execFile("git", ["clone", "--no-checkout", "--quiet", task.repo, repoDir]);
  }, `clone(${task.instance_id})`);
  // CRITICAL on Windows: default `core.autocrlf=true` rewrites LF→CRLF on
  // checkout. The diff we capture is LF, so when swebench later runs
  // `git apply` against the (CRLF) working tree, hunk context lines fail to
  // match. Disable autocrlf repo-locally so the working tree matches the
  // recorded diff byte-for-byte. Safe on macOS/Linux (autocrlf=false by
  // default there).
  await execFile("git", ["config", "core.autocrlf", "false"], { cwd: repoDir });
  await withRetry(
    () => execFile("git", ["fetch", "origin"], { cwd: repoDir }),
    `fetch(${task.instance_id})`,
  );
  return repoDir;
}

function deriveRepoDirName(repoUrl: string): string {
  // https://github.com/owner/name.git → name
  const m = repoUrl.match(/\/([^\/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : "repo";
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function checkoutCommit(repoDir: string, commit: string): Promise<void> {
  // Detach HEAD to the target commit. `--detach` avoids branch-name resolution
  // failures when the working tree has never had a checked-out branch (which is
  // the case after `git clone --no-checkout`).
  await execFile("git", ["checkout", "--detach", commit], { cwd: repoDir });
  // CRLF normalization for Windows. If a previous run cloned the repo with
  // the OS-default `core.autocrlf=true`, files in the working tree are CRLF
  // but the diff we capture is LF — so when swebench later runs `git apply`
  // strict, the 3-line hunk context fails to match. We re-set autocrlf to
  // false (idempotent, the safe value on macOS/Linux) and then re-fill the
  // working tree from the git objects so any CRLF cache gets rewritten as
  // LF.
  //
  // We deliberately do NOT pass `-f` to checkout-index: on Windows the
  // 260-char MAX_PATH limit makes some files in repos like
  // gravitational/teleport uncacheable, and `-f` would make git exit non-zero
  // on those paths. Without `-f` git skips the unwriteable files and
  // continues — those files are never the ones the agent needs to modify
  // anyway.
  await execFile("git", ["config", "core.autocrlf", "false"], { cwd: repoDir });
  await execFile("git", ["read-tree", "HEAD"], { cwd: repoDir });
  await execFile("git", ["checkout-index", "-a"], { cwd: repoDir });
}

export async function runOne(
  task: EvalTask,
  options: { verbose?: boolean } = {},
): Promise<TaskResult> {
  const workspaceDir = path.join(WORKSPACE_ROOT, task.instance_id);
  await mkdir(workspaceDir, { recursive: true });

  let repoDir: string;
  try {
    repoDir = await ensureRepoCloned(task, workspaceDir);
    await checkoutCommit(repoDir, task.base_commit);
  } catch (e) {
    return {
      instance_id: task.instance_id,
      status: "error",
      error: `workspace prep failed: ${(e as Error).message}`,
    };
  }

  const llmConfig = loadLlmConfig();
  const client = createLlmClient(llmConfig);
  const session = createAgentSession(repoDir, EVAL_SYSTEM_PROMPT);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);

  const logLevel = process.env.SEEKHARNESS_EVAL_LOG ?? "info";

  let result: Awaited<ReturnType<typeof runAgentTurn>>;
  try {
    // runAgentTurn now accepts an AbortSignal — the LLM request and bash
    // processes will be genuinely cancelled on timeout, avoiding resource waste.
    result = await runAgentTurn(session, task.problem_statement, {
      client,
      llmConfig,
      maxTurns: MAX_TURNS,
      signal: controller.signal,
      onTurn: logLevel === "info" ? undefined : (info) => {
        // verbose / debug: print every model + tool call
        console.log(
          `  [turn ${info.turn}] ${info.role}: ${info.preview}`,
        );
      },
    });
  } catch (e) {
    clearTimeout(timer);
    return {
      instance_id: task.instance_id,
      status: controller.signal.aborted ? "timeout" : "error",
      error: (e as Error).message,
    };
  }
  clearTimeout(timer);

  const marker = detectSubmissionMarker(result.finalText);
  if (marker.kind === "abort") {
    return {
      instance_id: task.instance_id,
      status: "aborted",
      turns: result.turns,
      error: `agent aborted: ${marker.reason}`,
    };
  }

  let patch: string;
  try {
    patch = await extractWorkingTreeDiff(repoDir);
  } catch (e) {
    return {
      instance_id: task.instance_id,
      status: "error",
      turns: result.turns,
      error: `diff extraction failed: ${(e as Error).message}`,
    };
  }

  if (!patch.trim()) {
    return {
      instance_id: task.instance_id,
      status: "error",
      turns: result.turns,
      error: "empty patch (agent produced no working-tree changes)",
    };
  }

  const patchPath = path.join(PATCHES_DIR, `${task.instance_id}.diff`);
  await mkdir(PATCHES_DIR, { recursive: true });
  await writeFile(patchPath, patch, "utf8");

  if (options.verbose) {
    console.log(
      `[${task.instance_id}] ok — ${result.turns} turns, patch ${patch.length} bytes, marker=${marker.kind}`,
    );
  }

  return {
    instance_id: task.instance_id,
    status: "ok",
    turns: result.turns,
    patch_path: patchPath,
    patch_length: patch.length,
    final_text_preview: result.finalText.slice(-200),
  };
}

async function main() {
  // Simple CLI arg parsing: `--concurrency N` overrides env var
  const args = process.argv.slice(2);
  let tasksPath = "datasets/mini.jsonl";
  let concurrency = CONCURRENCY;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--concurrency" && i + 1 < args.length) {
      concurrency = Number(args[++i]);
    } else if (!args[i].startsWith("--")) {
      tasksPath = args[i];
    }
  }
  const text = await readFile(tasksPath, "utf8");
  const tasks = parseJsonlTasks(text);

  console.log(`seekHarness eval runner — ${tasks.length} task(s)`);
  console.log(`workspace:    ${WORKSPACE_ROOT}`);
  console.log(`patches:      ${PATCHES_DIR}`);
  console.log(`timeout:      ${HARD_TIMEOUT_MS}ms / task, max ${MAX_TURNS} turns`);
  console.log(`concurrency:  ${concurrency} task(s) in parallel`);

  const results: TaskResult[] = new Array(tasks.length);
  let completed = 0;

  // ── Concurrent pool via simple semaphore ──
  // Spawn up to CONCURRENCY "worker" coroutines. Each pulls the next task
  // from a shared iterator and runs it. This preserves task order in the
  // results array while allowing up to N tasks in flight.
  const runNext = async (): Promise<void> => {
    for (let i = nextIndex++; i < tasks.length; i = nextIndex++) {
      const t = tasks[i];
      const startedAt = Date.now();
      const r = await runOne(t, { verbose: true });
      results[i] = r;
      completed++;
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      const marker =
        r.status === "ok"
          ? `patch=${r.patch_length}B`
          : r.status === "aborted"
            ? `abort`
            : `err`;
      console.log(
        `  [${completed}/${tasks.length}] [${r.status}] ${r.instance_id} (${elapsed}s, ${marker})`,
      );
    }
  };

  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, runNext);
  await Promise.all(workers);

  // Write summary in original task order
  await mkdir(path.dirname(SUMMARY_PATH), { recursive: true });
  await writeFile(SUMMARY_PATH, JSON.stringify(results, null, 2), "utf8");

  const ok = results.filter((r) => r.status === "ok").length;
  const err = results.length - ok;
  console.log(`\nDone. ${ok} ok, ${err} non-ok. Summary: ${SUMMARY_PATH}`);
  console.log(`Run \`npm run eval:score\` to grade patches with swebench + Docker.`);
}

// Only run when invoked as a script (not when imported by tests).
// Compare normalized file URLs — robust across Windows drive letters, spaces
// in paths, and forward/backslash separators (the previous string compare
// silently returned false on Windows, so `npm run eval` did nothing).
function isInvokedAsMain(): boolean {
  const arg1 = process.argv[1];
  if (!arg1) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(arg1)).href;
  } catch {
    return false;
  }
}
if (isInvokedAsMain()) {
  main().catch((e) => {
    console.error("eval runner failed:", e);
    process.exit(1);
  });
}
