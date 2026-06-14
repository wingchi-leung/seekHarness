/**
 * 工具层回归测试：模拟 agent 走完"修一个真实中等难度 bug"的完整闭环。
 * 不调 LLM，直接驱动工具。
 *
 * 跑法：npm run e2e
 *
 * Task：修 e2e-broken/ 里的 2 个 bug
 *   bug 1: src/strings.ts  的 slugify 缺 toLowerCase()
 *   bug 2: src/users.ts    的 getUser 应该在 id 不存在时 throw 而不是返回 undefined
 *
 * 验证手段：
 *   - npx tsc --noEmit  → 类型检查通过
 *   - npx tsx --test ...→ 14 个测试全过
 *   - npx tsx src/index.ts → 运行时输出符合预期（slug 全 lowercase、缺失 id throw）
 *
 * 依赖：fixture 需要 typescript + tsx（在 e2e-broken/ 跑 npm install）。
 * 缺依赖时优雅 SKIP，不算失败。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { readTool } from "../src/tools/read.js";
import { editTool } from "../src/tools/edit.js";
import { bashTool } from "../src/tools/bash.js";
import { globTool } from "../src/tools/glob.js";
import { grepTool } from "../src/tools/grep.js";
import { writeTool } from "../src/tools/write.js";
import { DefaultBashPolicy } from "../src/tools/policy.js";

const root = path.resolve(import.meta.dirname, "../e2e-broken");
const ctx = {
  workspaceRoot: root,
  readFiles: new Set<string>(),
  bashPolicy: new DefaultBashPolicy(),
  largeOutputDir: path.join(root, ".overflow"),
};

// 原始 broken 源码（每次跑前重置）
const BROKEN_STRINGS = `/**
 * String utilities for seekHarness fixtures.
 *
 * Public API:
 *   slugify(s: string): string         -> kebab-case, lowercase, no leading/trailing dashes
 *   joinSlug(parts: string[]): string -> join parts with single dash
 *
 * Real bugs in the code below (the agent must fix):
 *   bug 1: slugify doesn't call toLowerCase()
 */

export function slugify(s: string): string {
  return s
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function joinSlug(parts: string[]): string {
  return parts.map(slugify).join("-");
}
`;

const BROKEN_USERS = `/**
 * Simple in-memory user store.
 *
 * Real bug: getUser returns undefined on missing id, but the API contract says it must throw.
 */

import { slugify } from "./strings.js";

export interface User {
  id: number;
  name: string;
  slug: string;
}

const users: User[] = [];
let nextId = 1;

export function createUser(name: string): User {
  const u: User = {
    id: nextId++,
    name,
    slug: slugify(name),
  };
  users.push(u);
  return u;
}

export function getUser(id: number): User | undefined {
  return users.find((u) => u.id === id);
}

export function listUsers(): User[] {
  return [...users];
}
`;

async function ensureFixtureDeps(): Promise<boolean> {
  try {
    await fs.access(path.join(root, "package.json"));
  } catch {
    return false;
  }
  const probe = await new Promise<number>((resolve) => {
    const proc = spawn("npx", ["--no-install", "tsx", "-e", "0"], {
      cwd: root,
      shell: true,
      windowsHide: true,
    });
    proc.on("error", () => resolve(1));
    proc.on("close", (code) => resolve(code ?? 1));
  });
  return probe === 0;
}

async function resetFixture(): Promise<void> {
  await fs.mkdir(path.join(root, "src/__tests__"), { recursive: true });
  await fs.writeFile(path.join(root, "src/strings.ts"), BROKEN_STRINGS, "utf-8");
  await fs.writeFile(path.join(root, "src/users.ts"), BROKEN_USERS, "utf-8");
  try {
    await fs.unlink(path.join(root, "README.md"));
  } catch {}
  ctx.readFiles.clear();
}

function ok(s: string, success: boolean): void {
  console.log(`  ${success ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${s}`);
}

async function main() {
  console.log(`\n\x1b[1mTool e2e: fix 2 bugs in e2e-broken/ (slugify + getUser)\x1b[0m\n`);

  const ready = await ensureFixtureDeps();
  if (!ready) {
    console.log(
      `\x1b[33mSKIP:\x1b[0m e2e-broken/ 缺少 typescript/tsx 依赖。\n` +
        `  在 e2e-broken/ 跑一次 \`npm install --no-save typescript@^5.8.2 tsx@^4.19.3\` 再来。\n`
    );
    process.exit(0);
  }

  await resetFixture();
  console.log("  (fixture reset: slugify misses toLowerCase, getUser misses throw)\n");

  // 1. glob — 摸结构
  const r1 = await globTool.execute(
    globTool.validate({ pattern: "src/**/*.ts" }),
    ctx
  );
  ok("glob src/**/*.ts", r1.success);

  // 2. grep — 找 .toLowerCase() 调用点（注释里的不算，用正则锚定到方法调用）
  const r2 = await grepTool.execute(
    grepTool.validate({
      pattern: "\\.toLowerCase\\(",
      path: "src",
      include: "*.ts",
      output_mode: "files_with_matches",
    }),
    ctx
  );
  ok("grep '\\.toLowerCase\\(' in src/*.ts (should be 0 files = bug 1 confirmed)", r2.success);
  if (!r2.output.startsWith("No matches")) {
    console.log("    expected 'No matches' in src, got:", r2.output);
    process.exit(1);
  }

  // 3. read 两个源文件
  const r3 = await readTool.execute(
    readTool.validate({ path: "src/strings.ts" }),
    ctx
  );
  ok("read src/strings.ts", r3.success);

  const r3b = await readTool.execute(
    readTool.validate({ path: "src/users.ts" }),
    ctx
  );
  ok("read src/users.ts", r3b.success);

  // 4. edit 修 bug 1：slugify 缺 toLowerCase
  // 用最常见的实现：camelCase 边界 + lowercase + 非字母数字 collapse
  const r4 = await editTool.execute(
    editTool.validate({
      path: "src/strings.ts",
      old_string: `export function slugify(s: string): string {
  return s
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}`,
      new_string: `export function slugify(s: string): string {
  return s
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}`,
    }),
    ctx
  );
  ok("edit slugify (toLowerCase + camelCase boundary)", r4.success);

  // 5. edit 修 bug 2：getUser 缺 throw
  const r5 = await editTool.execute(
    editTool.validate({
      path: "src/users.ts",
      old_string: `export function getUser(id: number): User | undefined {
  return users.find((u) => u.id === id);
}`,
      new_string: `export function getUser(id: number): User {
  const u = users.find((u) => u.id === id);
  if (!u) {
    throw new Error(\`User not found: \${id}\`);
  }
  return u;
}`,
    }),
    ctx
  );
  ok("edit getUser (throw on missing)", r5.success);

  // 6. bash: tsc 验证类型
  const r6 = await bashTool.execute(
    bashTool.validate({
      command: "npx tsc --noEmit",
      description: "Type check after fix",
    }),
    ctx
  );
  ok("bash tsc --noEmit", r6.success);
  if (!r6.success) {
    console.log("    tsc output:", r6.output);
    process.exit(1);
  }

  // 7. bash: 跑测试套件
  const r7 = await bashTool.execute(
    bashTool.validate({
      command: "npx tsx --test src/__tests__/strings.test.ts src/__tests__/users.test.ts",
      description: "Run full test suite",
    }),
    ctx
  );
  ok("bash test suite (15 tests)", r7.success && r7.output.includes("# pass 15"));
  if (!r7.output.includes("# pass 15")) {
    console.log("    test output (first 80 lines):");
    console.log(
      r7.output
        .split("\n")
        .slice(0, 80)
        .map((l) => "      " + l)
        .join("\n")
    );
    process.exit(1);
  }

  // 8. bash: 跑 index 验证运行时
  const r8 = await bashTool.execute(
    bashTool.validate({
      command: "npx tsx src/index.ts",
      description: "Run demo to verify runtime behavior",
    }),
    ctx
  );
  ok("bash tsx src/index.ts", r8.success);
  if (r8.output.includes("ERROR: expected getUser to throw")) {
    console.log("    bug 2 not fixed: program still reports 'expected getUser to throw'");
    process.exit(1);
  }
  if (r8.output.includes("Alice-Smith") || r8.output.includes("Bob-Johnson")) {
    console.log("    bug 1 not fixed: slug still has uppercase");
    process.exit(1);
  }

  // 9. write 创建 README
  const r9 = await writeTool.execute(
    writeTool.validate({
      file_path: "README.md",
      content:
        "# e2e-broken\n\n" +
        "Medium-difficulty TypeScript fixture for seekHarness's tool e2e.\n\n" +
        "## Bugs the agent must fix\n\n" +
        "1. `src/strings.ts` — `slugify` forgets `.toLowerCase()`, so `HelloWorld` returns `HelloWorld` instead of `hello-world`.\n" +
        "2. `src/users.ts` — `getUser` returns `undefined` on missing id; the contract (and tests) say it must throw.\n\n" +
        "## Verification\n\n" +
        "```bash\n" +
        "npx tsc --noEmit\n" +
        "npx tsx --test src/__tests__/strings.test.ts src/__tests__/users.test.ts\n" +
        "npx tsx src/index.ts\n" +
        "```\n",
    }),
    ctx
  );
  ok("write README.md", r9.success);

  console.log(`\n\x1b[32m✓ All 9 tool calls succeeded; 2 bugs fixed and verified.\x1b[0m\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
