# seekHarness 工具扩展设计

> 第一阶段：补齐 `glob` / `write` 工具，让 agent 拥有"找文件 + 创建/覆盖文件"的能力。
> 后续阶段：`grep` / `bash`。

## 设计目标

- 复刻 Claude Code 的工具心智模型（参数风格、返回格式、错误风格）
- 不破坏现有 `read` / `edit` 的语义
- 为后续 `bash` 工具预留状态字段（`readFiles` / `largeOutputDir` / `bashPolicy`）

## 整体架构

### ToolContext 扩展

会话级共享状态，从 `ToolContext` 接口注入工具。新增字段：

```ts
export interface ToolContext {
  workspaceRoot: string;
  readFiles: Set<string>;     // NEW: 记录本会话已 Read 的文件绝对路径
  largeOutputDir?: string;    // NEW: 给后续 bash 用，glob/write 暂不需要
  bashPolicy?: BashPolicy;    // NEW: 给后续 bash 用
}
```

`readFiles` 的作用：实现"覆盖文件前必须先 Read"的状态机。

### 改动文件清单

| 文件 | 改动 |
|---|---|
| [src/tools/types.ts](../src/tools/types.ts) | `ToolContext` 加 `readFiles: Set<string>`；引入 `BashPolicy` 接口（暂不实现） |
| [src/tools/read.ts](../src/tools/read.ts) | execute 成功后 `ctx.readFiles.add(absPath)` |
| [src/tools/registry.ts](../src/tools/registry.ts) | `ALL_TOOLS` 数组追加 `globTool`、`writeTool` |
| [src/agent/loop.ts](../src/agent/loop.ts) | `ToolContext` 初始化 `new Set<string>()`；system prompt 升级 |
| [src/tools/glob.ts](../src/tools/glob.ts) | **新建** |
| [src/tools/write.ts](../src/tools/write.ts) | **新建** |

## 工具规格

### glob

**用途**：按文件名模式找文件，不读内容。Agent 用来"摸清项目结构"。

**参数**：

```ts
{
  pattern: string         // 必填。glob 模式，例 "src/**/*.ts" / "**/*.json" / "*.md"
  path?: string           // 可选。搜索根，相对 workspaceRoot，默认 "."
}
```

**行为**：
- 走 `fast-glob`（需新增依赖）
- 按 mtime 降序排序
- 最多返回 100 条；超出时返回截断提示
- **不**遵守 `.gitignore`（和 Claude Code 一致——能 glob 到 `.env`）
- 路径统一返回相对 `workspaceRoot` 的形式

**返回（成功）**：

```
Found 42 files in src (sorted by mtime, capped at 100):
src/index.ts
src/agent/loop.ts
src/cli/repl.ts
...
```

**返回（命中上限）**：

```
Found 100+ files matching "**/*.ts" (capped at 100, sorted by mtime).
Narrow the pattern or use grep with output_mode "files_with_matches" to count first.
[前 100 条路径]
```

**返回（零结果）**：

```
No files matched "build/*.tmp" in .
```

**错误**：
- `pattern` 为空 / 不是合法 glob → 工具内部 `zod` 校验失败（沿用现有 [read.ts](../src/tools/read.ts) 风格）
- `path` 越界 workspace → `Path escapes workspace: <path>`

**Zod schema**：

```ts
const globSchema = z.object({
  pattern: z.string().min(1).describe("Glob pattern, e.g. 'src/**/*.ts' or '**/*.json'"),
  path: z.string().optional().describe("Search root, relative to workspace root. Defaults to '.'"),
});
```

**Fast-glob 调用**：

```ts
import fg from "fast-glob";

const entries = await fg(input.pattern, {
  cwd: searchRoot,        // workspaceRoot + path（已校验过不越界）
  absolute: false,        // 返回相对路径
  stats: true,            // 需要 mtime
  onlyFiles: true,
  dot: false,             // 不包含 .开头的文件，除非 pattern 显式要求
  ignore: [],             // 不读 .gitignore
});

// 按 mtime 降序
entries.sort((a, b) => b.stats!.mtimeMs - a.stats!.mtimeMs);

// 取前 100
const capped = entries.slice(0, 100);
```

### write

**用途**：创建新文件，或完整覆盖已存在文件。

**参数**：

```ts
{
  file_path: string       // 必填。相对 workspaceRoot
  content: string         // 必填。完整文件内容
}
```

**Read-before-Write 状态机**：
- 执行前查 `ctx.readFiles.has(absolutePath)`
- 文件**已存在** + 路径**不在** `readFiles` → 返回错误，不写入
- 文件**不存在**（新建）→ 直接写入，把路径加入 `readFiles`
- 文件**已存在** + 路径**在** `readFiles` → 覆盖写入，保留 `readFiles` 中的记录

**为什么用绝对路径做 key**：
相对路径在 `chdir` 后会解析到不同位置。`fs.realpath` 一下得到唯一标识。

**返回（新建）**：

```
Created <file_path> (1234 bytes)
```

**返回（覆盖）**：

```
Overwrote <file_path> (5678 bytes)
```

**错误**：
- 未 read 过的已存在文件：

  ```
  Error: Must read <file_path> before overwriting. Use the read tool first to see the current contents.
  ```

- `file_path` 越界 workspace → `Path escapes workspace: <file_path>`
- 父目录不存在 → 自动 `mkdir -p`（write 是"创建文件"语义，不应让用户先 mkdir）

**Zod schema**：

```ts
const writeSchema = z.object({
  file_path: z.string().min(1).describe("Relative path to the file inside the workspace"),
  content: z.string().describe("Full contents to write to the file"),
});
```

**实现骨架**：

```ts
async execute(input, ctx) {
  const absPath = await resolveWorkspacePath(ctx.workspaceRoot, input.file_path);

  // 检查文件存在性
  let exists = false;
  try {
    const stat = await fs.stat(absPath);
    exists = stat.isFile();
  } catch {
    exists = false;
  }

  if (exists && !ctx.readFiles.has(absPath)) {
    return {
      success: false,
      output: `Error: Must read ${input.file_path} before overwriting. Use the read tool first to see the current contents.`,
    };
  }

  // 自动建父目录
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, input.content, "utf-8");

  // 记录已读（包括新建后）
  ctx.readFiles.add(absPath);

  const bytes = Buffer.byteLength(input.content, "utf-8");
  return {
    success: true,
    output: `${exists ? "Overwrote" : "Created"} ${input.file_path} (${bytes} bytes)`,
  };
}
```

## 配套改动

### 1. `read.ts` 记录已读

在 [src/tools/read.ts:35-52](../src/tools/read.ts#L35-L52) 的 `execute` 成功路径上：

```ts
async execute(input, ctx) {
  try {
    const absPath = await resolveWorkspacePath(ctx.workspaceRoot, input.path);
    const content = await readTextFile(absPath);
    // NEW:
    ctx.readFiles.add(absPath);
    // ... 现有格式化逻辑
  } catch (err) { ... }
}
```

### 2. `loop.ts` 初始化状态

在 [src/agent/loop.ts:52](../src/agent/loop.ts#L52) 附近：

```ts
const toolCtx: ToolContext = {
  workspaceRoot: session.workspaceRoot,
  readFiles: new Set<string>(),
};
```

### 3. system prompt 升级

[src/agent/loop.ts:10-16](../src/agent/loop.ts#L10-L16) 替换为：

```ts
const SYSTEM_PROMPT = `You are seekHarness, a coding agent that helps modify a local codebase.

You have tools:
- read:    read a file (workspace-relative path)
- write:   create or overwrite a file. Overwriting an existing file requires reading it first in this session.
- edit:    replace an exact unique substring in a file. Use read first to get exact content.
- glob:    find files by name pattern, e.g. "src/**/*.ts". Sorted by mtime, capped at 100. Does not respect .gitignore.

Workflow:
1. Understand: use glob to map the codebase before guessing paths.
2. Read before you write: read first, then edit/write. Use edit for small changes, write for new files.
3. Recover: if a tool returns an error, read the error, adjust, retry. Don't repeat the same failing call.
4. Finish: when done, reply to the user without calling more tools.

Constraints:
- All file paths in read/write/edit/glob are relative to the workspace root.`;
```

## 错误风格统一

所有工具错误遵循：

1. **参数校验错误**（zod 抛出）→ 走 [registry.ts:27-29](../src/tools/registry.ts#L27-L29) 的 `Validation error: <message>`
2. **执行时异常**（文件不存在、权限拒绝等）→ 工具内 try/catch，返回 `{ success: false, output: <err.message> }`
3. **业务规则错误**（如 write 未读先写）→ 工具内显式判断，返回 `{ success: false, output: "Error: <人话描述>" }`

错误消息要**告诉模型怎么修**，不要只说"失败"。

## 测试策略

每个工具至少覆盖：

| 场景 | glob | write |
|---|---|---|
| 新建文件 | — | ✅ 写入成功，路径加入 readFiles |
| 覆盖已读文件 | — | ✅ 覆盖成功 |
| 覆盖未读文件 | — | ✅ 拒绝，提示先 read |
| 父目录不存在 | — | ✅ 自动 mkdir |
| 路径越界 | ✅ 拒绝 | ✅ 拒绝 |
| 空 pattern / 空 path | ✅ 校验失败 | ✅ 校验失败 |
| 零匹配 | ✅ 返回空 | — |
| 100+ 匹配 | ✅ 截断 + 提示 | — |
| mtime 排序 | ✅ 验证顺序 | — |

测试位置：`src/tools/__tests__/glob.test.ts` 和 `write.test.ts`（用 `node:test` 内置 runner，无新依赖）。

## 依赖新增

```json
{
  "dependencies": {
    "fast-glob": "^3.3.2"
  }
}
```

## 落地顺序

1. 装 `fast-glob`
2. 改 [types.ts](../src/tools/types.ts)（加 readFiles）
3. 改 [read.ts](../src/tools/read.ts)（记录 readFiles）
4. 新建 [glob.ts](../src/tools/glob.ts)
5. 新建 [write.ts](../src/tools/write.ts)
6. 改 [registry.ts](../src/tools/registry.ts)（注册）
7. 改 [loop.ts](../src/agent/loop.ts)（初始化 + system prompt）
8. 跑 `npm run build` 验证类型
9. 手动跑：`npm run dev -- "用 glob 找出 src 下所有 .ts 文件"`
10. 手动跑：`npm run dev -- "创建一个新文件 src/hello.ts 内容是 console.log('hi')"`

## 后续阶段（不在本文档范围）

- **grep**：装 `@vscode/ripgrep`，新增 `output_mode` 三态
- **bash**：`spawn` + 超时 + 30k 截断 + 黑名单 + `SEEKHARNESS_ALLOW_DANGEROUS` 环境变量门
- **monitor**（可选）：长任务后台运行

## 参考

- [Claude Code Tools Reference](https://code.claude.com/docs/en/tools-reference) — 工具设计心智模型来源
- [fast-glob](https://www.npmjs.com/package/fast-glob) — glob 实现
- 现有工具实现：[read.ts](../src/tools/read.ts)、[edit.ts](../src/tools/edit.ts)
