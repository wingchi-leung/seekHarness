#!/usr/bin/env node
import "./load-env.js";
import { createLlmClient, loadLlmConfig } from "./llm/client.js";
import { playSplash } from "./cli/splash.js";
import { runRepl } from "./cli/repl.js";

function parseArgs(argv: string[]): {
  noSplash: boolean;
  message?: string;
} {
  const rest: string[] = [];
  let noSplash = false;

  for (const arg of argv) {
    if (arg === "--no-splash") {
      noSplash = true;
    } else {
      rest.push(arg);
    }
  }

  return {
    noSplash,
    message: rest.length > 0 ? rest.join(" ") : undefined,
  };
}

async function main(): Promise<void> {
  const workspaceRoot = process.cwd();
  const { noSplash, message } = parseArgs(process.argv.slice(2));

  const llmConfig = loadLlmConfig();
  const client = createLlmClient(llmConfig);

  if (!noSplash) {
    await playSplash({
      workspace: workspaceRoot,
      model: llmConfig.model,
    });
  }
  // (Don't console.log here — Ink's patchConsole redirects console output
  // through the renderer, so any console output after render() begins would
  // be re-routed. The splash screen is the pre-REPL greeting.)

  await runRepl({
    client,
    llmConfig,
    workspaceRoot,
    initialMessage: message,
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
