import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import fs from "node:fs";
import path from "node:path";
import type OpenAI from "openai";
import type { LlmConfig } from "../llm/client.js";
import {
  createAgentSession,
  runAgentTurn,
  reconstructMessages,
  type AgentSession,
} from "../agent/loop.js";
import {
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  type SessionMeta,
} from "../session/persistence.js";
import { MessageList } from "./MessageList.js";
import { type Message } from "./MessageView.js";
import { Spinner } from "./Spinner.js";

export interface ReplProps {
  client: OpenAI;
  llmConfig: LlmConfig;
  workspaceRoot: string;
  initialMessage?: string;
  /** 要恢复的会话 ID */
  resumeSessionId?: string;
}

type Mode =
  | { kind: "idle" }
  | { kind: "streaming"; partial: string; pendingTool: { name: string; args: string } | null }
  | { kind: "sessions"; sessions: SessionMeta[]; loading: boolean }
  | { kind: "resume-picker"; sessions: SessionMeta[]; cursor: number; loading: boolean }
  | { kind: "deleting"; sessionId: string };

function printHelp(): string {
  return [
    "",
    "\x1b[1m命令\x1b[0m",
    "  /help, /?     显示帮助",
    "  /clear        清空当前对话历史",
    "  /save         保存当前会话",
    "  /resume       交互式恢复历史会话（↑↓选择，Enter确认）",
    "  /sessions     列出已保存的会话",
    "  /load <id>    恢复指定会话",
    "  /delete <id>  删除指定会话",
    "  /reload       重新加载工作目录下的 Agents.md",
    "  /exit, /quit  退出",
    "  Ctrl+C        停止当前操作",
    "",
  ].join("\n");
}

export function Repl(props: ReplProps): React.ReactElement {
  const { client, llmConfig, workspaceRoot, initialMessage, resumeSessionId } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 80;

  const sessionRef = useRef<AgentSession | null>(null);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const streamedTextRef = useRef("");
  const streamedToolRef = useRef<{ name: string; args: string; result: string } | null>(null);
  // 恢复选取后要做的事情的引用（在 useInput 中触发，在渲染中消费）
  const pendingResumeRef = useRef<(() => void) | null>(null);

  // ── Ctrl+C / 键盘导航 ────────────────────────────────────────────────────
  const abortControllerRef = useRef<AbortController | null>(null);
  const abortRequestedRef = useRef(false);
  const confirmExitRef = useRef(false);
  const modeRef = useRef<Mode>(mode);
  modeRef.current = mode;

  useInput((input, key) => {
    const currentMode = modeRef.current;

    // ── resume-picker 模式：↑↓ 导航 + Enter 选中 ──
    if (currentMode.kind === "resume-picker" && !currentMode.loading) {
      if (key.upArrow) {
        setMode((prev) =>
          prev.kind === "resume-picker"
            ? { ...prev, cursor: Math.max(0, prev.cursor - 1) }
            : prev,
        );
        return;
      }
      if (key.downArrow) {
        setMode((prev) =>
          prev.kind === "resume-picker"
            ? { ...prev, cursor: Math.min(prev.sessions.length - 1, prev.cursor + 1) }
            : prev,
        );
        return;
      }
      if (key.return) {
        const m = modeRef.current;
        if (m.kind === "resume-picker") {
          const session = m.sessions[m.cursor];
          if (session) {
            // 触发加载
            pendingResumeRef.current = () => {
              void doResume(session.id);
            };
            pendingResumeRef.current();
          }
        }
        return;
      }
      // Esc → 返回 idle
      if (key.escape) {
        setMode({ kind: "idle" });
        return;
      }
      // 在 picker 中键入其他字符不处理
      return;
    }

    // ── Ctrl+C ──
    if (!key.ctrl || input !== "c") return;

    if (currentMode.kind === "streaming") {
      const ctrl = abortControllerRef.current;
      if (ctrl && !ctrl.signal.aborted) {
        abortRequestedRef.current = true;
        ctrl.abort();
      }
    } else {
      if (confirmExitRef.current) {
        void trySave();
        exit();
      } else {
        confirmExitRef.current = true;
        setMessages((m) => [
          ...m,
          { kind: "assistant", text: "\x1b[33magent停止中... ⚠ 再按一次 Ctrl+C 退出程序\x1b[0m" },
        ]);
        setTimeout(() => {
          confirmExitRef.current = false;
        }, 3000);
      }
    }
  });

  const isBusy = mode.kind === "streaming";

  // ── 自动保存（fire-and-forget，不阻塞 UI）───────────────────────────────
  const trySave = useCallback(async (): Promise<string | undefined> => {
    const s = sessionRef.current;
    if (!s) return undefined;
    try {
      const id = await saveSession(
        s.messages,
        workspaceRoot,
        llmConfig.model,
        sessionId,
        s.toolTimestamps,
      );
      setSessionId(id);
      return id;
    } catch {
      return undefined;
    }
  }, [workspaceRoot, llmConfig.model, sessionId]);

  // ── 启动时：恢复历史对话 ────────────────────────────────────────────────
  useEffect(() => {
    if (!resumeSessionId) return;

    void doResume(resumeSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function doResume(id: string): Promise<void> {
    const loaded = await loadSession(id, workspaceRoot);
    if (!loaded) {
      setMessages((m) => [
        ...m,
        {
          kind: "assistant",
          text: `\x1b[31m✗ 未找到会话: ${id}\x1b[0m`,
        },
      ]);
      setMode({ kind: "idle" });
      return;
    }

    // 重建 session
    sessionRef.current = {
      id: loaded.meta.id,
      workspaceRoot: loaded.meta.workspaceRoot,
      messages: loaded.messages,
      toolTimestamps: (loaded as any).toolTimestamps ?? {},
    };
    setSessionId(loaded.meta.id);

    // 重建 UI 消息
    const uiMessages = reconstructMessages(loaded.messages) as Message[];
    setMessages(uiMessages);

    // workspace 不匹配时给个警告
    if (loaded.meta.workspaceRoot !== workspaceRoot) {
      setMessages((prev) => [
        ...prev,
        {
          kind: "assistant",
          text: `\x1b[33m⚠ 此会话创建于不同工作目录:\n  ${loaded.meta.workspaceRoot}\n  当前: ${workspaceRoot}\x1b[0m`,
        },
      ]);
    }

    setMode({ kind: "idle" });
  }

  // ── 初始化新会话（如果没有 resume） ──────────────────────────────────────
  useEffect(() => {
    if (sessionRef.current !== null) return;
    sessionRef.current = createAgentSession(workspaceRoot);
  }, [workspaceRoot]);

  // ── Initial message (one-shot) ───────────────────────────────────────────
  useEffect(() => {
    if (!initialMessage?.trim()) return;
    void runTurn(initialMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runTurn(line: string): Promise<void> {
    if (mode.kind === "streaming" || mode.kind === "resume-picker") return;
    const trimmed = line.trim();
    if (!trimmed) return;

    // ── Slash commands ────────────────────────────────────────────────────
    if (trimmed === "/help" || trimmed === "/?") {
      setMessages((m) => [
        ...m,
        { kind: "user", text: trimmed },
        { kind: "assistant", text: printHelp() },
      ]);
      setInput("");
      return;
    }

    if (trimmed === "/clear") {
      const s = sessionRef.current;
      if (s) {
        s.messages = s.messages.filter((m) => m.role === "system");
      }
      setMessages([]);
      setInput("");
      return;
    }

    if (trimmed === "/exit" || trimmed === "/quit" || trimmed === "/q") {
      await trySave();
      exit();
      return;
    }

    // ── /save ──
    if (trimmed === "/save") {
      setInput("");
      const s = sessionRef.current;
      if (!s || s.messages.length <= 1) {
        setMessages((m) => [
          ...m,
          { kind: "user", text: trimmed },
          { kind: "assistant", text: "当前会话为空，无需保存。" },
        ]);
        return;
      }
      try {
        const id = await trySave();
        if (id) {
          setMessages((m) => [
            ...m,
            { kind: "user", text: trimmed },
            { kind: "assistant", text: `\x1b[32m✓\x1b[0m 会话已保存  \x1b[2m${id}\x1b[0m` },
          ]);
        }
      } catch {
        setMessages((m) => [
          ...m,
          { kind: "user", text: trimmed },
          { kind: "assistant", text: "\x1b[31m✗ 保存失败\x1b[0m" },
        ]);
      }
      return;
    }

    // ── /resume ──
    if (trimmed === "/resume") {
      setInput("");
      setMessages((m) => [...m, { kind: "user", text: trimmed }]);
      setMode({ kind: "resume-picker", sessions: [], cursor: 0, loading: true });

      try {
        const sessions = await listSessions(workspaceRoot);
        setMode({ kind: "resume-picker", sessions, cursor: 0, loading: false });
      } catch {
        setMode({ kind: "resume-picker", sessions: [], cursor: 0, loading: false });
      }
      return;
    }

    // ── /sessions ──
    if (trimmed === "/sessions") {
      setInput("");
      setMode({ kind: "sessions", sessions: [], loading: true });
      setMessages((m) => [...m, { kind: "user", text: trimmed }]);

      try {
        const sessions = await listSessions(workspaceRoot);
        setMode({ kind: "sessions", sessions, loading: false });
      } catch {
        setMode({ kind: "sessions", sessions: [], loading: false });
      }
      return;
    }

    // ── /delete <id> ──
    if (trimmed.startsWith("/delete ")) {
      const id = trimmed.slice(8).trim();
      setInput("");
      if (!id) {
        setMessages((m) => [
          ...m,
          { kind: "user", text: trimmed },
          { kind: "assistant", text: "用法: /delete <session-id>" },
        ]);
        return;
      }
      const ok = await deleteSession(id, workspaceRoot);
      setMessages((m) => [
        ...m,
        { kind: "user", text: trimmed },
        { kind: "assistant", text: ok ? `\x1b[32m✓\x1b[0m 已删除 ${id}` : `\x1b[31m✗\x1b[0m 未找到 ${id}` },
      ]);
      return;
    }

    // ── /load <id> ──
    if (trimmed.startsWith("/load ")) {
      const id = trimmed.slice(6).trim();
      setInput("");
      if (!id) {
        setMessages((m) => [
          ...m,
          { kind: "user", text: trimmed },
          { kind: "assistant", text: "用法: /load <session-id>" },
        ]);
        return;
      }

      const loaded = await loadSession(id, workspaceRoot);
      if (!loaded) {
        setMessages((m) => [
          ...m,
          { kind: "user", text: trimmed },
          { kind: "assistant", text: `\x1b[31m✗\x1b[0m 未找到会话: ${id}` },
        ]);
        return;
      }

      sessionRef.current = {
        id: loaded.meta.id,
        workspaceRoot: loaded.meta.workspaceRoot,
        messages: loaded.messages,
        toolTimestamps: (loaded as any).toolTimestamps ?? {},
      };
      setSessionId(loaded.meta.id);
      const uiMessages = reconstructMessages(loaded.messages) as Message[];
      setMessages(uiMessages);

      setMessages((prev) => [
        ...prev,
        { kind: "assistant", text: `\x1b[32m✓\x1b[0m 已加载会话 ${id}` },
      ]);
      return;
    }

    // ── /reload — 查看当前 Agents.md ──
    if (trimmed === "/reload") {
      setInput("");
      const p = path.join(workspaceRoot, "Agents.md");
      let text = "\x1b[33m未找到 Agents.md\x1b[0m";
      try {
        if (fs.existsSync(p)) {
          text = `当前 \x1b[2mAgents.md\x1b[0m 内容：\n${fs.readFileSync(p, "utf-8").trim() || "(空)"}`;
        }
      } catch { /* ignore */ }
      setMessages((m) => [
        ...m,
        { kind: "user", text: trimmed },
        { kind: "assistant", text },
      ]);
      return;
    }

    // ── Real turn: push user msg, switch to streaming, run agent ───────────
    setMessages((m) => [...m, { kind: "user", text: trimmed }]);
    setInput("");
    setMode({ kind: "streaming", partial: "", pendingTool: null });
    streamedTextRef.current = "";
    streamedToolRef.current = null;
    abortRequestedRef.current = false;

    abortControllerRef.current = new AbortController();

    try {
      const result = await runAgentTurn(sessionRef.current!, trimmed, {
        client,
        llmConfig,
        signal: abortControllerRef.current.signal,
        onStream: (info) => {
          switch (info.type) {
            case "assistant_text":
              streamedTextRef.current += info.text;
              setMode((prev) =>
                prev.kind === "streaming"
                  ? { ...prev, partial: streamedTextRef.current }
                  : prev,
              );
              break;
            case "tool_start": {
              const name = info.text.split("(")[0] ?? info.text;
              streamedToolRef.current = { name, args: info.text, result: "" };
              if (streamedTextRef.current) {
                setMessages((m) => [...m, { kind: "assistant", text: streamedTextRef.current }]);
                streamedTextRef.current = "";
              }
              setMode((prev) =>
                prev.kind === "streaming"
                  ? { kind: "streaming", partial: "", pendingTool: { name, args: info.text } }
                  : prev,
              );
              break;
            }
            case "tool_end":
              if (streamedToolRef.current) {
                streamedToolRef.current = { ...streamedToolRef.current, result: info.text };
                setMessages((m) => [
                  ...m,
                  {
                    kind: "tool",
                    toolName: streamedToolRef.current!.name,
                    args: streamedToolRef.current!.args,
                    result: info.text,
                  },
                ]);
              }
              setMode((prev) =>
                prev.kind === "streaming"
                  ? { kind: "streaming", partial: "", pendingTool: null }
                  : prev,
              );
              break;
          }
        },
      });

      // ── Agent turn completed ──
      if (abortRequestedRef.current) {
        if (streamedTextRef.current) {
          setMessages((m) => [...m, { kind: "assistant", text: streamedTextRef.current }]);
        }
        setMessages((m) => [
          ...m,
          { kind: "assistant", text: "\x1b[33m⚠ 本轮工作已终止\x1b[0m" },
        ]);
      } else if (streamedTextRef.current) {
        setMessages((m) => [...m, { kind: "assistant", text: streamedTextRef.current }]);
      }
      setMode({ kind: "idle" });

      void trySave();
    } catch (err) {
      if (abortRequestedRef.current) {
        if (streamedTextRef.current) {
          setMessages((m) => [...m, { kind: "assistant", text: streamedTextRef.current }]);
        }
        setMessages((m) => [
          ...m,
          { kind: "assistant", text: "\x1b[33m⚠ 本轮工作已终止\x1b[0m" },
        ]);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setMessages((m) => [
          ...m,
          { kind: "assistant", text: `\x1b[31m✗\x1b[0m ${message}` },
        ]);
      }
      setMode({ kind: "idle" });
    } finally {
      abortControllerRef.current = null;
    }
  }

  // ── What message to show in the live-streaming row ───────────────────────
  let streamingMessage: Message | null = null;
  if (mode.kind === "streaming") {
    if (mode.pendingTool) {
      streamingMessage = {
        kind: "tool",
        toolName: mode.pendingTool.name,
        args: mode.pendingTool.args,
        result: "",
      };
    } else if (mode.partial) {
      streamingMessage = { kind: "assistant", text: mode.partial };
    } else {
      streamingMessage = { kind: "assistant", text: "" };
    }
  }

  // ── Sessions list view ──────────────────────────────────────────────────
  if (mode.kind === "sessions") {
    if (mode.loading) {
      streamingMessage = { kind: "assistant", text: "正在加载会话列表..." };
    } else {
      streamingMessage = null;
    }
  }

  // ── Rule lines ───────────────────────────────────────────────────────────
  const rule = "─".repeat(Math.max(columns, 1));

  return (
    <Box flexDirection="column">
      <MessageList completed={messages} streaming={streamingMessage} />

      {/* ── 普通 sessions 列表 ── */}
      {mode.kind === "sessions" && !mode.loading && (
        <Box flexDirection="column" marginTop={1}>
          {mode.sessions.length === 0 ? (
            <Text dimColor>暂无保存的会话。</Text>
          ) : (
            <>
              <Text bold underline>
                已保存的会话（共 {mode.sessions.length} 个）
              </Text>
              {mode.sessions.map((s) => (
                <Box key={s.id} flexDirection="column" marginTop={1}>
                  <Text>
                    <Text color="cyan">[{s.id}]</Text>{" "}
                    <Text dimColor>
                      {s.model} · {s.messageCount} 条消息 ·{" "}
                      {new Date(s.updatedAt).toLocaleString()}
                    </Text>
                  </Text>
                  {s.preview && (
                    <Text dimColor>
                      {"  "}↳ {s.preview}
                      {s.preview.length >= 80 ? "…" : ""}
                    </Text>
                  )}
                </Box>
              ))}
              <Box marginTop={1}>
                <Text dimColor>
                  使用 /load &lt;id&gt; 恢复，/delete &lt;id&gt; 删除
                </Text>
              </Box>
            </>
          )}
        </Box>
      )}

      {/* ── 交互式 resume picker ── */}
      {mode.kind === "resume-picker" && (
        <Box flexDirection="column" marginTop={1}>
          {mode.loading ? (
            <Text dimColor>正在加载会话列表...</Text>
          ) : mode.sessions.length === 0 ? (
            <Box flexDirection="column">
              <Text dimColor>暂无保存的会话。</Text>
              <Box marginTop={1}>
                <Text dimColor>按 Esc 返回</Text>
              </Box>
            </Box>
          ) : (
            <>
              <Text bold underline>
                选择要恢复的会话（↑↓ 导航，Enter 确认，Esc 取消）
              </Text>
              <Box flexDirection="column" marginTop={1}>
                {mode.sessions.map((s, i) => (
                  <Box key={s.id} flexDirection="column">
                    <Box>
                      <Text>
                        {i === mode.cursor ? (
                          <Text color="cyan" bold>
                            {"❯ "}
                          </Text>
                        ) : (
                          <Text>{"  "}</Text>
                        )}
                        <Text color={i === mode.cursor ? "cyan" : undefined}>
                          [{s.id}]
                        </Text>{" "}
                        <Text dimColor>
                          {s.model} · {s.messageCount} 条消息 ·{" "}
                          {new Date(s.updatedAt).toLocaleString()}
                        </Text>
                      </Text>
                    </Box>
                    {s.preview && (
                      <Box marginLeft={i === mode.cursor ? 2 : 2}>
                        <Text dimColor>
                          ↳ {s.preview}
                          {s.preview.length >= 80 ? "…" : ""}
                        </Text>
                      </Box>
                    )}
                  </Box>
                ))}
              </Box>
              <Box marginTop={1}>
                <Text dimColor>
                  {mode.sessions[mode.cursor]?.id
                    ? `将恢复 [${mode.sessions[mode.cursor]!.id}] — 按 Enter 确认`
                    : ""}
                </Text>
              </Box>
            </>
          )}
        </Box>
      )}

      {isBusy ? (
        <Box key="busy" marginTop={1}>
          <Spinner text="working..." />
        </Box>
      ) : mode.kind === "sessions" || mode.kind === "resume-picker" ? null : (
        <Box key="input-box" flexDirection="column" marginTop={1}>
          <Box key="top-rule">
            <Text color="cyan">{rule}</Text>
          </Box>
          <Box key="input-row">
            <Text color="cyan">❯ </Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={(v) => void runTurn(v)}
            />
          </Box>
          <Box key="bottom-rule">
            <Text color="cyan">{rule}</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
