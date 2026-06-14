import React, { useEffect, useState } from "react";
import { Text } from "ink";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * An animated spinner for Ink-based CLIs.
 * Cycles through Unicode braille spinner frames at 80ms intervals.
 */
export function Spinner({ text = "thinking" }: { text?: string }): React.ReactElement {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text dimColor>
      {FRAMES[frame]} {text}
    </Text>
  );
}
