import React from "react";
import { Box } from "ink";
import { MessageView, type Message } from "./MessageView.js";

/**
 * Renders the conversation history. We deliberately do NOT use Ink's
 * <Static> here: in V1 the entire list is rendered live (no flicker since
 * the input box is small and only the streaming row actually changes).
 * Upgrading to <Static> for true "history stays put" rendering is a
 * future optimization.
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
      {completed.map((m, i) => (
        <MessageView key={i} message={m} />
      ))}
      {streaming && <MessageView message={streaming} />}
    </Box>
  );
}
