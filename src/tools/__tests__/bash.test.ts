import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { bashTool } from "../bash.js";
import { DefaultBashPolicy } from "../policy.js";
import type { ToolContext } from "../types.js";

// node:test 的 { timeout } 选项在 @types/node@22 中尚未声明，但运行时支持。
// 用 cast 绕过类型检查，等 @types/node 升级后移除。
const tWithTimeout = test as unknown as (
  name: string,
  fn: () => Promise<void>,
  opts?: { timeout?: number }
) => Promise<void>;

async function makeWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "seekharness-bash-"));
}

function makeCtx(root: string): ToolContext {
  return {
    workspaceRoot: root,
    readFiles: new Set<string>(),
    bashPolicy: new DefaultBashPolicy(),
    largeOutputDir: path.join(root, ".overflow"),
  };
}

const isWin = process.platform === "win32";

test("bash runs a simple command and captures stdout", async () => {
  const root = await makeWorkspace();
  try {
    const cmd = isWin ? "echo hello" : "echo hello";
    const result = await bashTool.execute(
      bashTool.validate({ command: cmd }),
      makeCtx(root)
    );
    assert.equal(result.success, true);
    assert.match(result.output, /\$ echo hello/);
    assert.match(result.output, /hello/);
    assert.ok(!result.output.includes("(exit"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bash reports non-zero exit code", async () => {
  const root = await makeWorkspace();
  try {
    const cmd = isWin ? "exit 7" : "exit 7";
    const result = await bashTool.execute(
      bashTool.validate({ command: cmd }),
      makeCtx(root)
    );
    assert.equal(result.success, false);
    assert.match(result.output, /exit 7/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bash runs in workspace root by default", async () => {
  const root = await makeWorkspace();
  try {
    const cmd = isWin ? "cd" : "pwd";
    const result = await bashTool.execute(
      bashTool.validate({ command: cmd }),
      makeCtx(root)
    );
    assert.equal(result.success, true);
    // 路径可能在 normalize 后有大小写差异
    const norm = result.output.toLowerCase();
    const expected = root.toLowerCase();
    assert.ok(
      norm.includes(expected),
      `expected cwd to include ${expected}, got: ${result.output}`
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bash blocks rm -rf /", async () => {
  const root = await makeWorkspace();
  try {
    const result = await bashTool.execute(
      bashTool.validate({ command: "rm -rf /" }),
      makeCtx(root)
    );
    assert.equal(result.success, false);
    assert.match(result.output, /safety policy/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bash allows dangerous command when policy allows it", async () => {
  const root = await makeWorkspace();
  try {
    // 用一个无害的"危险"模式来测试绕开：自己建文件然后 cat
    await fs.writeFile(path.join(root, "marker.txt"), "safe");
    const policy = new DefaultBashPolicy();
    // 写一个允许任何命令的策略
    const allowAll = { deny: () => null };
    const result = await bashTool.execute(
      bashTool.validate({ command: "type marker.txt" }),
      { ...makeCtx(root), bashPolicy: allowAll }
    );
    assert.equal(result.success, true);
    assert.match(result.output, /safe/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

tWithTimeout("bash truncates output and writes to overflow file", async () => {
  const root = await makeWorkspace();
  try {
    // 生成 50000 字符输出
    const cmd = isWin
      ? "for /L %i in (1,1,5000) do @echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      : "yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | head -c 50000";
    const result = await bashTool.execute(
      bashTool.validate({ command: cmd }),
      makeCtx(root)
    );
    assert.equal(result.success, true);
    assert.match(result.output, /output truncated/);
    assert.match(result.output, /Full output saved to/);

    // 验证溢出文件存在
    const match = result.output.match(/Full output saved to: (.+)/);
    assert.ok(match);
    const overflowPath = match![1]!.trim();
    const exists = await fs
      .stat(overflowPath)
      .then(() => true)
      .catch(() => false);
    assert.equal(exists, true, `overflow file should exist at ${overflowPath}`);
    if (exists) await fs.unlink(overflowPath);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, { timeout: 30_000 });

tWithTimeout("bash times out long-running command", async () => {
  const root = await makeWorkspace();
  try {
    const cmd = isWin
      ? "ping -n 30 127.0.0.1 > nul"
      : "sleep 30";
    const result = await bashTool.execute(
      bashTool.validate({ command: cmd, timeout: 2000 }),
      makeCtx(root)
    );
    assert.equal(result.success, false);
    assert.match(result.output, /timed out after 2000ms/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, { timeout: 15_000 });

test("bash captures stderr", async () => {
  const root = await makeWorkspace();
  try {
    const cmd = isWin
      ? "1>&2 echo error-message"
      : "1>&2 echo error-message";
    const result = await bashTool.execute(
      bashTool.validate({ command: cmd }),
      makeCtx(root)
    );
    // 成功还是失败取决于平台 shell，stdout 为空不致命
    assert.match(result.output, /error-message/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bash rejects empty command", () => {
  assert.throws(() => bashTool.validate({ command: "" }), /command/i);
});

test("bash rejects timeout out of range", () => {
  assert.throws(() => bashTool.validate({ command: "ls", timeout: 500 }), /timeout/i);
  assert.throws(
    () => bashTool.validate({ command: "ls", timeout: 999_999 }),
    /timeout/i
  );
});
