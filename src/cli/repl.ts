import { render } from "ink";
import { createElement } from "react";
import type OpenAI from "openai";
import type { LlmConfig } from "../llm/client.js";
import { Repl } from "./ReplApp.js";

export interface ReplOptions {
  client: OpenAI;
  llmConfig: LlmConfig;
  workspaceRoot: string;
  initialMessage?: string;
}

export async function runRepl(options: ReplOptions): Promise<void> {
  const { waitUntilExit } = render(createElement(Repl, options));
  await waitUntilExit();
}
