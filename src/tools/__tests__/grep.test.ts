import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { grepTool } from "../grep.js";
import type { ToolContext } from "../types.js";

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seekharness-grep-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
  }
  return root;
}

function makeCtx(root: string): ToolContext {
  return { workspaceRoot: root, readFiles: new Set<string>() };
}

test("grep finds files with matches (default files_with_matches)", async () => {
  const root = await makeWorkspace({
    "src/a.ts": "hello world\nfoo bar",
    "src/b.ts": "goodbye world",
    "src/c.md": "no match here",
  });
  try {
    const result = await grepTool.execute(
      grepTool.validate({ pattern: "world", path: "src" }),
      makeCtx(root)
    );
    assert.equal(result.success, true);
    assert.match(result.output, /Found 2 files/);
    assert.match(result.output, /a\.ts/);
    assert.match(result.output, /b\.ts/);
    assert.doesNotMatch(result.output, /c\.md/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("grep content mode shows file:line:content", async () => {
  const root = await makeWorkspace({
    "src/a.ts": "line one\nline two with match\nline three",
  });
  try {
    const result = await grepTool.execute(
      grepTool.validate({ pattern: "match", output_mode: "content" }),
      makeCtx(root)
    );
    assert.equal(result.success, true);
    assert.match(result.output, /a\.ts:2:line two with match/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("grep count mode shows per-file line counts", async () => {
  const root = await makeWorkspace({
    "src/a.ts": "x x x\nno match",
    "src/b.ts": "x",
  });
  try {
    const result = await grepTool.execute(
      grepTool.validate({ pattern: "x", output_mode: "count" }),
      makeCtx(root)
    );
    assert.equal(result.success, true);
    // ripgrep -c 默认按匹配行数（不是次数）
    assert.match(result.output, /a\.ts:1/);
    assert.match(result.output, /b\.ts:1/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("grep returns no-match message when nothing found", async () => {
  const root = await makeWorkspace({ "src/a.ts": "hello" });
  try {
    const result = await grepTool.execute(
      grepTool.validate({ pattern: "absent_pattern_xyz" }),
      makeCtx(root)
    );
    assert.equal(result.success, true);
    assert.match(result.output, /^No matches/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("grep include filters by file glob", async () => {
  const root = await makeWorkspace({
    "src/a.ts": "findme",
    "src/a.md": "findme",
    "src/a.txt": "findme",
  });
  try {
    const result = await grepTool.execute(
      grepTool.validate({ pattern: "findme", include: "*.ts" }),
      makeCtx(root)
    );
    assert.equal(result.success, true);
    assert.match(result.output, /a\.ts/);
    assert.doesNotMatch(result.output, /a\.md/);
    assert.doesNotMatch(result.output, /a\.txt/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("grep handles workspace with .gitignore without erroring", async () => {
  // 注意：ripgrep 只在 .git 存在时遵守 .gitignore。
  // 这里只验证有 .gitignore 时 ripgrep 不报错。
  const root = await makeWorkspace({
    ".gitignore": "ignored/\n",
    "src/a.ts": "findme",
  });
  try {
    const result = await grepTool.execute(
      grepTool.validate({ pattern: "findme" }),
      makeCtx(root)
    );
    assert.equal(result.success, true);
    assert.match(result.output, /a\.ts/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("grep rejects empty pattern", () => {
  assert.throws(() => grepTool.validate({ pattern: "" }), /pattern/i);
});

test("grep rejects path that escapes workspace", async () => {
  const root = await makeWorkspace({});
  try {
    const result = await grepTool.execute(
      grepTool.validate({ pattern: "x", path: "../outside" }),
      makeCtx(root)
    );
    assert.equal(result.success, false);
    assert.match(result.output, /escapes workspace/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
