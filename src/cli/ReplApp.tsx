import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useApp, useStdout } from "ink";
import TextInput from "ink-text-input";
import type OpenAI from "openai";
import type { LlmConfig } from "../llm/client.js";
import {
  createAgentSession,
  runAgentTurn,
  type AgentSession,
} from "../agent/loop.js";
import { MessageList } from "./MessageList.js";
import { type Message } from "./MessageView.js";
import { Spinner } from "./Spinner.js";

export interface ReplProps {
  client: OpenAI;
  llmConfig: LlmConfig;
  workspaceRoot: string;
  initialMessage?: string;
}

type Mode =
  | { kind: "idle" }
  | { kind: "streaming"; partial: string; pendingTool: { name: string; args: string } | null };

function printHelp(): string {
  return [
    "",
    "\x1b[1m命令\x1b[0m",
    "  /help, /?     显示帮助",
    "  /clear        清空对话历史",
    "  /exit, /quit  退出",
    "  Ctrl+C        退出",
    "",
  ].join("\n");
}

export function Repl(props: ReplProps): React.ReactElement {
  const { client, llmConfig, workspaceRoot, initialMessage } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 80;
  const sessionRef = useRef<AgentSession | null>(null);
  if (sessionRef.current === null) {
    sessionRef.current = createAgentSession(workspaceRoot);
  }
  const session = sessionRef.current;

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const streamedTextRef = useRef("");
  const streamedToolRef = useRef<{ name: string; args: string; result: string } | null>(null);

  const isBusy = mode.kind === "streaming";

  // ── Initial message (one-shot, like before) ──────────────────────────────
  useEffect(() => {
    if (!initialMessage?.trim()) return;
    void runTurn(initialMessage);
    // runTurn is stable; we only want this to run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runTurn(line: string): Promise<void> {
    if (mode.kind === "streaming") return;
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
      session.messages = session.messages.filter((m) => m.role === "system");
      setMessages([]);
      setInput("");
      return;
    }

    if (trimmed === "/exit" || trimmed === "/quit" || trimmed === "/q") {
      exit();
      return;
    }

    // ── Real turn: push user msg, switch to streaming, run agent ───────────
    setMessages((m) => [...m, { kind: "user", text: trimmed }]);
    setInput("");
    setMode({ kind: "streaming", partial: "", pendingTool: null });
    streamedTextRef.current = "";
    streamedToolRef.current = null;

    try {
      const result = await runAgentTurn(session, trimmed, {
        client,
        llmConfig,
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

      if (streamedTextRef.current) {
        setMessages((m) => [...m, { kind: "assistant", text: result.finalText }]);
      }
      setMode({ kind: "idle" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMessages((m) => [...m, { kind: "assistant", text: `\x1b[31m✗\x1b[0m ${message}` }]);
      setMode({ kind: "idle" });
    }
  }

  // ── What message to show in the live-streaming row (above the input) ────
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
      // Waiting for the first response chunk → show a thinking indicator
      streamingMessage = { kind: "assistant", text: "" };
    }
  }

  // ── Rule lines that bracket the input ────────────────────────────────────
  const rule = "─".repeat(Math.max(columns, 1));

  return (
    <Box flexDirection="column">
      <MessageList completed={messages} streaming={streamingMessage} />

      {isBusy ? (
        <Box key="busy" marginTop={1}>
          <Spinner text="working..." />
        </Box>
      ) : (
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
