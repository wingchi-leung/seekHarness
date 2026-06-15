import React from "react";
import { Box, Static } from "ink";
import { MessageView, type Message } from "./MessageView.js";

/**
 * Renders the conversation history.
 * Completed messages use <Static> so Ink renders them once and never
 * re-renders — this keeps the terminal scroll position stable when
 * the list grows beyond viewport height.
 */
export function MessageList({
  completed,
  streaming,
}: {
  completed: Message[];
  streaming: Message | null;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Static items={completed}>
        {(m, i) => <MessageView key={i} message={m} />}
      </Static>
      {streaming && <MessageView message={streaming} />}
    </Box>
  );
}
