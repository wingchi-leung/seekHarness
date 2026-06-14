/**
 * Bash 安全策略实现。
 *
 * deny() 返回 null=放行，字符串=拒绝原因。
 *
 * 黑名单命中的命令，需要 SEEKHARNESS_ALLOW_DANGEROUS=1 才放行（且会打印红色警告）。
 * 默认拒绝。
 */

import type { BashPolicy } from "./types.js";

/** 危险命令模式。匹配命令开头 + 关键参数。 */
const DANGEROUS_PATTERNS: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /^\s*rm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/,
    reason: "'rm -rf /' wipes the entire filesystem",
  },
  {
    pattern: /^\s*rm\s+(-[a-zA-Z]*[fF][a-zA-Z]*\s+)?~\s*$/,
    reason: "'rm -rf ~' wipes the home directory",
  },
  {
    pattern: /^\s*mkfs(\.\w+)?\s/,
    reason: "mkfs formats a filesystem",
  },
  {
    pattern: /^\s*dd\s+if=/,
    reason: "dd with input redirection can overwrite raw devices",
  },
  {
    pattern: /^\s*(shutdown|halt|reboot|poweroff|init\s+[06])\b/,
    reason: "system power commands",
  },
  {
    // fork 炸弹: :(){ :|:& };:
    pattern: /^\s*:?\(\)\s*\{[^}]*:\s*\|[^}]*:\s*&[^}]*\}\s*;\s*:/,
    reason: "fork bomb",
  },
  {
    // curl ... | sh / bash
    pattern: /\bcurl\b[^|]*\|\s*(ba)?sh\b/,
    reason: "piping curl into a shell executes remote code",
  },
  {
    pattern: /\bwget\b[^|]*\|\s*(ba)?sh\b/,
    reason: "piping wget into a shell executes remote code",
  },
  {
    // iwr ... | iex  (PowerShell)
    pattern: /\b(Invoke-Expression|iex)\b.*\bInvoke-WebRequest|iwr\b/i,
    reason: "Invoke-WebRequest piped to Invoke-Expression executes remote code",
  },
];

export class DefaultBashPolicy implements BashPolicy {
  /**
   * 检查命令是否被黑名单拦截。
   * 返回 null=放行；返回字符串=拒绝原因。
   */
  deny(command: string): string | null {
    for (const { pattern, reason } of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        if (process.env.SEEKHARNESS_ALLOW_DANGEROUS === "1") {
          // 用户开了门——打印红色警告到 stderr（model 看不到，但用户能看）
          process.stderr.write(
            `\x1b[31m[seekHarness]\x1b[0m \x1b[33mWARNING:\x1b[0m allowing dangerous command: ${reason}\n`
          );
          return null;
        }
        return (
          `${reason}. Set SEEKHARNESS_ALLOW_DANGEROUS=1 to override. ` +
          `(blocked command: ${command.slice(0, 80)}${command.length > 80 ? "…" : ""})`
        );
      }
    }
    return null;
  }
}
