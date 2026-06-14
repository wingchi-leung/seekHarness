import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { writeTool } from "../write.js";
import { readTool } from "../read.js";
import type { ToolContext } from "../types.js";

async function makeWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "seekharness-write-"));
}

function makeCtx(root: string): ToolContext {
  return { workspaceRoot: root, readFiles: new Set<string>() };
}

test("write creates a new file", async () => {
  const root = await makeWorkspace();
  try {
    const ctx = makeCtx(root);
    const result = await writeTool.execute(
      writeTool.validate({ file_path: "new.txt", content: "hello" }),
      ctx
    );
    assert.equal(result.success, true);
    assert.match(result.output, /^Created new\.txt \(5 bytes\)$/);
    const content = await fs.readFile(path.join(root, "new.txt"), "utf-8");
    assert.equal(content, "hello");
    // 创建后应加入 readFiles
    assert.ok(ctx.readFiles.has(path.join(root, "new.txt")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("write creates parent directories automatically", async () => {
  const root = await makeWorkspace();
  try {
    const result = await writeTool.execute(
      writeTool.validate({
        file_path: "deep/nested/dir/file.ts",
        content: "x",
      }),
      makeCtx(root)
    );
    assert.equal(result.success, true);
    const exists = await fs
      .stat(path.join(root, "deep/nested/dir/file.ts"))
      .then(() => true)
      .catch(() => false);
    assert.equal(exists, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("write refuses to overwrite an existing unread file", async () => {
  const root = await makeWorkspace();
  try {
    await fs.writeFile(path.join(root, "existing.txt"), "original");
    const result = await writeTool.execute(
      writeTool.validate({ file_path: "existing.txt", content: "new" }),
      makeCtx(root)
    );
    assert.equal(result.success, false);
    assert.match(result.output, /Must read existing\.txt before overwriting/);
    // 确认文件没被改
    const content = await fs.readFile(path.join(root, "existing.txt"), "utf-8");
    assert.equal(content, "original");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("write overwrites a previously-read file", async () => {
  const root = await makeWorkspace();
  try {
    await fs.writeFile(path.join(root, "file.txt"), "original");
    const ctx = makeCtx(root);

    // 先 read
    const readResult = await readTool.execute(
      readTool.validate({ path: "file.txt" }),
      ctx
    );
    assert.equal(readResult.success, true);
    assert.ok(ctx.readFiles.has(path.join(root, "file.txt")));

    // 再 write
    const writeResult = await writeTool.execute(
      writeTool.validate({ file_path: "file.txt", content: "updated" }),
      ctx
    );
    assert.equal(writeResult.success, true);
    assert.match(writeResult.output, /^Overwrote file\.txt/);
    const content = await fs.readFile(path.join(root, "file.txt"), "utf-8");
    assert.equal(content, "updated");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("write rejects path that escapes workspace", async () => {
  const root = await makeWorkspace();
  try {
    const result = await writeTool.execute(
      writeTool.validate({ file_path: "../escape.txt", content: "x" }),
      makeCtx(root)
    );
    assert.equal(result.success, false);
    assert.match(result.output, /escapes workspace/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("write rejects empty file_path via zod", () => {
  assert.throws(
    () => writeTool.validate({ file_path: "", content: "x" }),
    /file_path/i
  );
});

test("write allows empty content (legitimate use case)", async () => {
  const root = await makeWorkspace();
  try {
    const result = await writeTool.execute(
      writeTool.validate({ file_path: "empty.txt", content: "" }),
      makeCtx(root)
    );
    assert.equal(result.success, true);
    assert.match(result.output, /Created empty\.txt \(0 bytes\)/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
