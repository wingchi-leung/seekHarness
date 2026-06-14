import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SessionMeta {
  id: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  workspaceRoot: string;
  model: string;
  messageCount: number;
  /** 最后一条用户消息的前 80 字，用于列表快速识别 */
  preview: string;
}

export interface SessionFile {
  version: 1;
  meta: SessionMeta;
  messages: ChatCompletionMessageParam[];
}

// ── Paths ──────────────────────────────────────────────────────────────────

const SESSIONS_DIR = path.join(os.homedir(), ".seekharness", "sessions");
const LATEST_FILE = path.join(SESSIONS_DIR, ".latest");

function sessionPath(id: string): string {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

function ensureDirSync(): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ── Core operations ────────────────────────────────────────────────────────

/** 生成简短 UUID（取前 8 位，够用且好读） */
export function generateSessionId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * 保存会话到磁盘。
 * - 如果 session 还没有 id，自动生成一个
 * - 原子写入（write-then-rename）
 * - 同时更新 .latest 指针
 */
export async function saveSession(
  messages: ChatCompletionMessageParam[],
  workspaceRoot: string,
  model: string,
  sessionId?: string,
): Promise<string> {
  ensureDirSync();

  const id = sessionId ?? generateSessionId();

  // 提取预览：最后一条 user 消息的前 80 字
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  const preview = lastUserMsg
    ? String(lastUserMsg.content ?? "").slice(0, 80)
    : "";

  const meta: SessionMeta = {
    id,
    createdAt: new Date().toISOString(), // 第一次创建时覆盖
    updatedAt: new Date().toISOString(),
    workspaceRoot,
    model,
    messageCount: messages.length,
    preview,
  };

  // 如果已有文件，保留原有的 createdAt
  const existingPath = sessionPath(id);
  try {
    const existingRaw = await fsPromises.readFile(existingPath, "utf-8");
    const existing: SessionFile = JSON.parse(existingRaw);
    meta.createdAt = existing.meta.createdAt;
  } catch {
    // 没有现有文件，用新生成的
  }

  const data: SessionFile = {
    version: 1,
    meta,
    messages,
  };

  // 原子写入：写到临时文件再 rename
  const tmpPath = path.join(SESSIONS_DIR, `.${id}.tmp.${process.pid}`);
  await fsPromises.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await fsPromises.rename(tmpPath, existingPath);

  // 更新 latest 指针
  await fsPromises.writeFile(LATEST_FILE, id, "utf-8");

  return id;
}

/** 按 ID 加载完整会话 */
export async function loadSession(id: string): Promise<SessionFile | null> {
  try {
    const raw = await fsPromises.readFile(sessionPath(id), "utf-8");
    return JSON.parse(raw) as SessionFile;
  } catch {
    return null;
  }
}

/** 获取最近一次保存的会话 ID */
export async function getLatestSessionId(): Promise<string | null> {
  try {
    const id = await fsPromises.readFile(LATEST_FILE, "utf-8");
    return id.trim() || null;
  } catch {
    return null;
  }
}

/** 列出所有保存的会话 */
export async function listSessions(
  workspaceRoot?: string,
): Promise<SessionMeta[]> {
  ensureDirSync();

  let files: string[];
  try {
    files = await fsPromises.readdir(SESSIONS_DIR);
  } catch {
    return [];
  }

  const sessions: SessionMeta[] = [];

  for (const file of files) {
    if (!file.endsWith(".json") || file.startsWith(".")) continue;
    try {
      const raw = await fsPromises.readFile(
        path.join(SESSIONS_DIR, file),
        "utf-8",
      );
      const session: SessionFile = JSON.parse(raw);
      // 可选：按 workspace 过滤
      if (workspaceRoot && session.meta.workspaceRoot !== workspaceRoot) {
        continue;
      }
      sessions.push(session.meta);
    } catch {
      // 跳过损坏的文件
    }
  }

  // 按更新时间倒序
  sessions.sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );

  return sessions;
}

/** 删除指定会话 */
export async function deleteSession(id: string): Promise<boolean> {
  try {
    await fsPromises.unlink(sessionPath(id));
    return true;
  } catch {
    return false;
  }
}
