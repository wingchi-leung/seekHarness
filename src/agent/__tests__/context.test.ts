import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {
  truncateOutput,
  compressHistory,
  markToolTimestamp,
  createToolTimestampStore,
} from "../context.js";

test("truncateOutput: small output unchanged", async () => {
  const result = await truncateOutput("hello world", "read");
  assert.equal(result, "hello world");
});

test("truncateOutput: big output truncated + file saved", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "seekharness-test-"));
  try {
    const big = "x".repeat(10_000);
    const result = await truncateOutput(big, "bash", tmpDir);
    assert.ok(result.length < big.length, "should be truncated");
    assert.ok(result.includes("truncated"), "should mention truncation");
    assert.ok(result.includes("Use the read tool"), "should hint read");

    const fileMatch = result.match(/saved to: (.+\.txt)/);
    assert.ok(fileMatch, "should have file path");
    const filePath = fileMatch![1]!.trim();
    const exists = await fs.stat(filePath).then(() => true).catch(() => false);
    assert.equal(exists, true, "full output file should exist");
    const content = await fs.readFile(filePath, "utf-8");
    assert.equal(content, big, "file should contain full output");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("truncateOutput: no outputDir skips file write", async () => {
  const big = "x".repeat(10_000);
  const result = await truncateOutput(big, "read");
  assert.ok(result.includes("truncated"));
  assert.ok(result.includes(".seekharness/output.txt"));
});

// ─── compressHistory: timebased content clearing ───

test("clears content of tool results older than 5 minutes", () => {
  const store = createToolTimestampStore();
  const now = 1_000_000;
  const origNow = Date.now;

  try {
    Date.now = () => now;

    const msgs: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1", tool_calls: [{ id: "c1" }, { id: "c2" }, { id: "c3" }] },
      { role: "tool", content: "r1", tool_call_id: "c1" },
      { role: "tool", content: "r2", tool_call_id: "c2" },
      { role: "tool", content: "r3", tool_call_id: "c3" },
    ];
    markToolTimestamp(msgs[3], store); // c1 @ now
    markToolTimestamp(msgs[4], store); // c2 @ now
    markToolTimestamp(msgs[5], store); // c3 @ now

    // 6 分钟后：c1, c2, c3 全过期
    Date.now = () => now + 6 * 60 * 1000;
    compressHistory(msgs, store);

    // 所有 tool content 被清空
    assert.equal((msgs.find((m: any) => m.tool_call_id === "c1")).content, "[Old tool result cleared]");
    assert.equal((msgs.find((m: any) => m.tool_call_id === "c2")).content, "[Old tool result cleared]");
    assert.equal((msgs.find((m: any) => m.tool_call_id === "c3")).content, "[Old tool result cleared]");
    // 消息还在，没被删
    assert.equal(msgs.filter(m => m.role === "tool").length, 3);
    // assistant 的 tool_calls 还在
    const a = msgs.find(m => m.role === "assistant");
    assert.equal((a as any).tool_calls?.length, 3);
  } finally {
    Date.now = origNow;
  }
});

test("assistant with reasoning_content untouched", () => {
  const store = createToolTimestampStore();
  const now = 1_000_000;
  const origNow = Date.now;

  try {
    Date.now = () => now;

    const msgs: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      {
        role: "assistant", content: "", reasoning_content: "思考过程...",
        tool_calls: [{ id: "c1" }],
      },
      { role: "tool", content: "r1", tool_call_id: "c1" },
    ];
    markToolTimestamp(msgs[3], store);

    Date.now = () => now + 6 * 60 * 1000;
    compressHistory(msgs, store);

    const a = msgs.find(m => m.role === "assistant");
    assert.equal((a as any).reasoning_content, "思考过程...", "reasoning_content kept");
    assert.equal((a as any).tool_calls?.length, 1, "tool_calls kept");
    assert.equal(msgs.filter(m => m.role === "tool").length, 1, "tool msg still there");
    assert.equal((msgs[3] as any).content, "[Old tool result cleared]", "content cleared");
  } finally {
    Date.now = origNow;
  }
});

test("no timestamps (restored session) clears nothing", () => {
  const store = createToolTimestampStore();

  const msgs: any[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1", tool_calls: [{ id: "c1" }] },
    { role: "tool", content: "r1", tool_call_id: "c1" },
  ];

  compressHistory(msgs, store);
  assert.equal((msgs[3] as any).content, "r1");
});

test("under 5 minutes, nothing cleared", () => {
  const store = createToolTimestampStore();
  const now = 1_000_000;
  const origNow = Date.now;

  try {
    Date.now = () => now;
    const msgs: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1", tool_calls: [{ id: "c1" }] },
      { role: "tool", content: "r1", tool_call_id: "c1" },
    ];
    markToolTimestamp(msgs[3], store);

    Date.now = () => now + 3 * 60 * 1000; // 3 分钟
    compressHistory(msgs, store);
    assert.equal((msgs[3] as any).content, "r1");
  } finally {
    Date.now = origNow;
  }
});

test("tool without tool_call_id does not crash", () => {
  const store = createToolTimestampStore();
  const now = 1_000_000;
  const origNow = Date.now;

  try {
    Date.now = () => now;
    const msgs: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1", tool_calls: [{ id: "c1" }] },
      { role: "tool", content: "r1", tool_call_id: "c1" },
      { role: "tool", content: "orphan" },
    ];
    markToolTimestamp(msgs[3], store);

    Date.now = () => now + 10 * 60 * 1000;
    compressHistory(msgs, store);
    assert.equal((msgs[3] as any).content, "[Old tool result cleared]");
    assert.equal((msgs[4] as any).content, "orphan"); // 没有 tool_call_id，不受影响
  } finally {
    Date.now = origNow;
  }
});

test("empty messages does not crash", () => {
  compressHistory([], createToolTimestampStore());
  assert.ok(true);
});

test("multiple compresses progressively clear older tools", () => {
  const store = createToolTimestampStore();
  const now = 1_000_000;
  const origNow = Date.now;

  try {
    Date.now = () => now;
    const msgs: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1", tool_calls: [{ id: "c1" }, { id: "c2" }] },
      { role: "tool", content: "r1", tool_call_id: "c1" },
      { role: "tool", content: "r2", tool_call_id: "c2" },
    ];
    markToolTimestamp(msgs[3], store);
    Date.now = () => now + 1 * 60 * 1000;
    markToolTimestamp(msgs[4], store);

    // 第一次：c1 过期，c2 没过期
    Date.now = () => now + 6 * 60 * 1000;
    compressHistory(msgs, store);
    assert.equal((msgs[3] as any).content, "[Old tool result cleared]");
    assert.equal((msgs[4] as any).content, "r2");

    // 第二次：c2 也过期了
    Date.now = () => now + 7 * 60 * 1000;
    compressHistory(msgs, store);
    assert.equal((msgs[3] as any).content, "[Old tool result cleared]");
    assert.equal((msgs[4] as any).content, "[Old tool result cleared]");
  } finally {
    Date.now = origNow;
  }
});
