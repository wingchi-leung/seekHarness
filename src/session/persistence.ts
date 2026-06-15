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
  /** tool result 时间戳（tool_call_id → epoch ms），防线2 用 */
  toolTimestamps: Record<string, number>;
}

// ── Path helpers ────────────────────────────────────────────────────────────
// 完整对话 → <workspaceRoot>/.seekharness/sessions/<id>.json
// 全局索引 → ~/.seekharness/sessions-index.json（仅元数据，轻量汇总）

function sessionsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".seekharness", "sessions");
}

function latestFilePath(workspaceRoot: string): string {
  return path.join(sessionsDir(workspaceRoot), ".latest");
}

function sessionPath(workspaceRoot: string, id: string): string {
  return path.join(sessionsDir(workspaceRoot), `${id}.json`);
}

function ensureDirSync(workspaceRoot: string): void {
  fs.mkdirSync(sessionsDir(workspaceRoot), { recursive: true });
}

/** 全局索引文件路径（C 盘 ~/.seekharness/ 下），只存 SessionMeta，不存完整对话 */
const GLOBAL_INDEX_PATH = path.join(os.homedir(), ".seekharness", "sessions-index.json");

/** 向全局索引追加/更新一条会话元数据 */
async function updateGlobalIndex(meta: SessionMeta): Promise<void> {
  let index: SessionMeta[] = [];
  try {
    const raw = await fsPromises.readFile(GLOBAL_INDEX_PATH, "utf-8");
    index = JSON.parse(raw);
    if (!Array.isArray(index)) index = [];
  } catch {
    // 还没有索引文件，新建
  }

  const existingIdx = index.findIndex((e) => e.id === meta.id);
  if (existingIdx >= 0) {
    index[existingIdx] = meta;
  } else {
    index.push(meta);
  }

  // 确保 ~/.seekharness/ 目录存在
  fs.mkdirSync(path.dirname(GLOBAL_INDEX_PATH), { recursive: true });
  await fsPromises.writeFile(GLOBAL_INDEX_PATH, JSON.stringify(index, null, 2), "utf-8");
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
 * - 存储位置：<workspaceRoot>/.seekharness/sessions/<id>.json
 */
export async function saveSession(
  messages: ChatCompletionMessageParam[],
  workspaceRoot: string,
  model: string,
  sessionId?: string,
  toolTimestamps: Record<string, number> = {},
): Promise<string> {
  ensureDirSync(workspaceRoot);

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
  const existingPath = sessionPath(workspaceRoot, id);
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
    toolTimestamps,
  };

  // 原子写入：写到临时文件再 rename
  const tmpPath = path.join(sessionsDir(workspaceRoot), `.${id}.tmp.${process.pid}`);
  await fsPromises.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await fsPromises.rename(tmpPath, existingPath);

  // 更新 latest 指针
  await fsPromises.writeFile(latestFilePath(workspaceRoot), id, "utf-8");

  // 全局索引（C 盘汇总）：只写元数据，不写完整对话
  await updateGlobalIndex(meta);

  return id;
}

/** 按 ID 加载完整会话 */
export async function loadSession(
  id: string,
  workspaceRoot: string,
): Promise<SessionFile | null> {
  try {
    const raw = await fsPromises.readFile(sessionPath(workspaceRoot, id), "utf-8");
    return JSON.parse(raw) as SessionFile;
  } catch {
    return null;
  }
}

/** 获取最近一次保存的会话 ID */
export async function getLatestSessionId(
  workspaceRoot: string,
): Promise<string | null> {
  try {
    const id = await fsPromises.readFile(latestFilePath(workspaceRoot), "utf-8");
    return id.trim() || null;
  } catch {
    return null;
  }
}

/** 列出工作目录下所有保存的会话 */
export async function listSessions(
  workspaceRoot: string,
): Promise<SessionMeta[]> {
  const dir = sessionsDir(workspaceRoot);
  let files: string[];
  try {
    files = await fsPromises.readdir(dir);
  } catch {
    return [];
  }

  const sessions: SessionMeta[] = [];

  for (const file of files) {
    if (!file.endsWith(".json") || file.startsWith(".")) continue;
    try {
      const raw = await fsPromises.readFile(
        path.join(dir, file),
        "utf-8",
      );
      const session: SessionFile = JSON.parse(raw);
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

/** 从全局索引（C 盘汇总）读取所有会话的元数据，按更新时间倒序 */
export async function listGlobalSessions(): Promise<SessionMeta[]> {
  try {
    const raw = await fsPromises.readFile(GLOBAL_INDEX_PATH, "utf-8");
    const index: SessionMeta[] = JSON.parse(raw);
    if (!Array.isArray(index)) return [];
    index.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    return index;
  } catch {
    return [];
  }
}

/** 删除指定会话 */
export async function deleteSession(
  id: string,
  workspaceRoot: string,
): Promise<boolean> {
  try {
    await fsPromises.unlink(sessionPath(workspaceRoot, id));
    return true;
  } catch {
    return false;
  }
}

/**
 * 将所有会话导出为 JSONL 格式（每行一个 JSON 对象）。
 * 用于训练数据提取或备份分析。
 *
 * 用法：
 * ```
 * import { exportSessionsToJsonl } from "./session/persistence.js";
 * await exportSessionsToJsonl("./all.jsonl", process.cwd());
 * ```
 */
export async function exportSessionsToJsonl(
  outputFile: string,
  workspaceRoot: string,
): Promise<{ sessions: number; messages: number }> {
  const metas = await listSessions(workspaceRoot);
  const outStream = fs.createWriteStream(outputFile, { flags: "w", encoding: "utf-8" });

  let totalMessages = 0;

  for (const meta of metas) {
    const data = await loadSession(meta.id, workspaceRoot);
    if (!data) continue;

    // session_meta 行
    outStream.write(JSON.stringify({
      type: "session_meta",
      session: data.meta.id,
      model: data.meta.model,
      createdAt: data.meta.createdAt,
      updatedAt: data.meta.updatedAt,
      workspaceRoot: data.meta.workspaceRoot,
      messageCount: data.meta.messageCount,
      preview: data.meta.preview,
    }) + "\n");

    // messages 行
    for (let idx = 0; idx < data.messages.length; idx++) {
      const msg = data.messages[idx];
      const base: Record<string, unknown> = {
        type: "msg",
        session: data.meta.id,
        idx,
        role: msg.role,
      };

      if (msg.role === "system") {
        base.content = msg.content;
      } else if (msg.role === "user") {
        base.content = msg.content;
      } else if (msg.role === "assistant") {
        base.content = msg.content;
        const tc = (msg as any).tool_calls;
        if (tc && tc.length > 0) {
          base.tool_calls = tc.map((t: any) => ({
            name: t.function.name,
            args: t.function.arguments,
          }));
        }
      } else if (msg.role === "tool") {
        base.tool_call_id = msg.tool_call_id;
        base.content = msg.content;
      }

      outStream.write(JSON.stringify(base) + "\n");
      totalMessages++;
    }
  }

  outStream.end();
  return { sessions: metas.length, messages: totalMessages };
}
