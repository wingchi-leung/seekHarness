import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "./Spinner.js";

/**
 * One row in the conversation history. Three kinds:
 *   - "user":      the user's typed input, prefixed with ❯
 *   - "assistant": the model's final reply (post-streaming)
 *   - "tool":      a tool call + its truncated result, shown as a single line
 */
export type Message =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; toolName: string; args: string; result: string };

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

/** Visual of a single message. Pure function of `message`; no state. */
export function MessageView({ message }: { message: Message }): React.ReactElement {
  switch (message.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text>
            <Text color="cyan">❯ </Text>
            {message.text}
          </Text>
        </Box>
      );

    case "assistant":
      if (!message.text) {
        // Empty text → we're waiting for the first response chunk
        return (
          <Box marginTop={1}>
            <Spinner text="thinking" />
          </Box>
        );
      }
      return (
        <Box marginTop={1}>
          <Text>{message.text}</Text>
        </Box>
      );

    case "tool":
      return (
        <Box>
          <Text dimColor>
            {"  ⚙ "}
            {message.toolName}({truncate(message.args, 80)})
          </Text>
        </Box>
      );
  }
}
