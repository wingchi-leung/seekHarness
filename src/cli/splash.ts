const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const LOGO_LINES = [
  "",
  "   ███████╗███████╗███████╗██╗  ██╗",
  "   ██╔════╝██╔════╝██╔════╝██║ ██╔╝",
  "   ███████╗█████╗  █████╗  █████╔╝ ",
  "   ╚════██║██╔══╝  ██╔══╝  ██╔═██╗ ",
  "   ███████║███████╗███████╗██║  ██╗",
  "   ╚══════╝╚══════╝╚══════╝╚═╝  ╚═╝",
  "",
  "   ██╗  ██╗ █████╗ ██████╗ ███╗   ██╗███████╗███████╗",
  "   ██║  ██║██╔══██╗██╔══██╗████╗  ██║██╔════╝██╔════╝",
  "   ███████║███████║██████╔╝██╔██╗ ██║█████╗  ███████╗",
  "   ██╔══██║██╔══██║██╔══██╗██║╚██╗██║██╔══╝  ╚════██║",
  "   ██║  ██║██║  ██║██║  ██║██║ ╚████║███████╗███████║",
  "   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝",
  "",
];

function ansi(code: string, text: string): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function hideCursor(): void {
  if (process.stdout.isTTY) process.stdout.write("\x1b[?25l");
}

function showCursor(): void {
  if (process.stdout.isTTY) process.stdout.write("\x1b[?25h");
}

/** 清除当前行（跨平台：不依赖全屏清屏） */
function clearLine(): void {
  process.stdout.write("\r\x1b[2K");
}

function colorLogoLine(line: string, index: number, total: number): string {
  const t = index / Math.max(total - 1, 1);
  if (t < 0.35) return ansi("36", line);
  if (t < 0.7) return ansi("96", line);
  return ansi("34", line);
}

export interface SplashInfo {
  workspace: string;
  model: string;
}

export async function playSplash(info: SplashInfo): Promise<void> {
  if (!process.stdout.isTTY) {
    console.log(`seekHarness · ${info.model}\n`);
    return;
  }

  hideCursor();

  // 单行 spinner：用 \r 覆盖同一行，避免 Windows 上清屏失效导致刷屏
  for (let i = 0; i < 8; i++) {
    const spin = SPINNER[i % SPINNER.length]!;
    process.stdout.write(
      `\r  ${ansi("2", spin)} ${ansi("36", "seekHarness")} ${ansi("2", "starting...")}   `
    );
    await sleep(70);
  }
  clearLine();

  console.log("\n");
  for (let i = 0; i < LOGO_LINES.length; i++) {
    const line = LOGO_LINES[i]!;
    if (line === "") {
      console.log("");
      continue;
    }
    console.log(colorLogoLine(line, i, LOGO_LINES.length));
  }

  console.log(`\n   ${ansi("2", "›")} ${ansi("1", "local coding agent")}\n`);
  console.log(
    `   ${ansi("2", "workspace")} ${ansi("37", info.workspace)}`
  );
  console.log(`   ${ansi("2", "model    ")} ${ansi("37", info.model)}\n`);
  console.log(
    `   ${ansi("2", "输入消息开始对话，")}${ansi("33", "/help")}${ansi("2", " 查看命令")}\n`
  );

  await sleep(200);
  showCursor();
}
