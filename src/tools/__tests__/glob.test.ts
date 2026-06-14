import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { globTool } from "../glob.js";
import type { ToolContext } from "../types.js";

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seekharness-glob-"));
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

test("glob finds files matching a basic pattern", async () => {
  const root = await makeWorkspace({
    "src/a.ts": "1",
    "src/b.ts": "2",
    "src/c.md": "3",
  });
  try {
    const result = await globTool.execute(
      globTool.validate({ pattern: "src/*.ts" }),
      makeCtx(root)
    );
    assert.equal(result.success, true);
    assert.match(result.output, /^Found 2 files/);
    // fast-glob returns paths relative to cwd (the search root)
    assert.match(result.output, /a\.ts/);
    assert.match(result.output, /b\.ts/);
    assert.doesNotMatch(result.output, /c\.md/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("glob returns empty message when nothing matches", async () => {
  const root = await makeWorkspace({ "src/a.ts": "1" });
  try {
    const result = await globTool.execute(
      globTool.validate({ pattern: "build/*.tmp" }),
      makeCtx(root)
    );
    assert.equal(result.success, true);
    assert.match(result.output, /^No files matched/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("glob rejects empty pattern via zod", () => {
  assert.throws(() => globTool.validate({ pattern: "" }), /pattern/i);
});

test("glob rejects path that escapes workspace", async () => {
  const root = await makeWorkspace({});
  try {
    const result = await globTool.execute(
      globTool.validate({ pattern: "**/*.ts", path: "../outside" }),
      makeCtx(root)
    );
    assert.equal(result.success, false);
    assert.match(result.output, /escapes workspace/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("glob uses search root when path is provided", async () => {
  const root = await makeWorkspace({
    "src/a.ts": "1",
    "lib/b.ts": "2",
  });
  try {
    const result = await globTool.execute(
      globTool.validate({ pattern: "**/*.ts", path: "src" }),
      makeCtx(root)
    );
    assert.equal(result.success, true);
    assert.match(result.output, /a\.ts/);
    assert.doesNotMatch(result.output, /b\.ts/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("glob caps results at 100 with truncation notice", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 120; i++) {
    files[`src/f${i}.ts`] = String(i);
  }
  const root = await makeWorkspace(files);
  try {
    const result = await globTool.execute(
      globTool.validate({ pattern: "src/*.ts" }),
      makeCtx(root)
    );
    assert.equal(result.success, true);
    assert.match(result.output, /Found 120\+/);
    assert.match(result.output, /showing 100/);
    const lines = result.output.split("\n");
    // 2 行截断提示 + 100 个文件路径 = 102 行
    assert.equal(lines.length, 102);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("glob sorts by mtime descending (newest first)", async () => {
  const root = await makeWorkspace({});
  const oldPath = path.join(root, "src/old.ts");
  const newPath = path.join(root, "src/new.ts");
  await fs.mkdir(path.dirname(oldPath), { recursive: true });
  await fs.writeFile(oldPath, "old");
  // 强制 mtime 差距
  await new Promise((r) => setTimeout(r, 50));
  await fs.writeFile(newPath, "new");

  try {
    const result = await globTool.execute(
      globTool.validate({ pattern: "src/*.ts" }),
      makeCtx(root)
    );
    assert.equal(result.success, true);
    const lines = result.output.split("\n");
    // header 在 line 0，src/new.ts 应该在 line 1
    assert.match(lines[1]!, /new\.ts/);
    assert.match(lines[2]!, /old\.ts/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
