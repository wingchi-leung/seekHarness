import path from "node:path";
import fs from "node:fs/promises";

export async function resolveWorkspacePath(
  workspaceRoot: string,
  filePath: string
): Promise<string> {
  const resolved = path.resolve(workspaceRoot, filePath);
  const relative = path.relative(workspaceRoot, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${filePath}`);
  }

  return resolved;
}

export async function readTextFile(absPath: string): Promise<string> {
  const stat = await fs.stat(absPath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${absPath}`);
  }
  return fs.readFile(absPath, "utf-8");
}
