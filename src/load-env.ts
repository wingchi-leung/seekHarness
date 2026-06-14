import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// 优先从工作目录加载 .env（全局安装时用户在自己项目目录下放 .env）
config({ path: path.join(process.cwd(), ".env") });

// 也尝试从包安装目录加载（开发时用的 .env 在项目根目录）
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
config({ path: path.join(projectRoot, ".env") });
