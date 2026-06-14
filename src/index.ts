#!/usr/bin/env node
import "./load-env.js";
import { createLlmClient, loadLlmConfig } from "./llm/client.js";
import { playSplash } from "./cli/splash.js";
import { runRepl } from "./cli/repl.js";
import { getLatestSessionId } from "./session/persistence.js";

interface ParsedArgs {
  noSplash: boolean;
  message?: string;
  resumeSessionId?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const rest: string[] = [];
  let noSplash = false;
  let resumeSessionId: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--no-splash") {
      noSplash = true;
    } else if (arg === "--resume") {
      // --resume 后可以跟一个 session ID，也可以不跟（使用最近一次）
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        resumeSessionId = next;
        i++; // skip the ID value
      } else {
        resumeSessionId = "__latest__";
      }
    } else if (arg === "--session" || arg === "-s") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        resumeSessionId = next;
        i++;
      }
    } else {
      rest.push(arg);
    }
  }

  return {
    noSplash,
    message: rest.length > 0 ? rest.join(" ") : undefined,
    resumeSessionId,
  };
}

async function main(): Promise<void> {
  const workspaceRoot = process.cwd();
  const { noSplash, message, resumeSessionId: rawResumeId } = parseArgs(process.argv.slice(2));

  const llmConfig = loadLlmConfig();
  const client = createLlmClient(llmConfig);

  // 解析 resume 参数：__latest__ → 找最新的会话 ID
  let resumeSessionId: string | undefined;
  if (rawResumeId === "__latest__") {
    resumeSessionId = (await getLatestSessionId()) ?? undefined;
    if (!resumeSessionId) {
      console.error("没有找到可恢复的历史会话。");
      process.exit(1);
    }
  } else {
    resumeSessionId = rawResumeId;
  }

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
    resumeSessionId,
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
