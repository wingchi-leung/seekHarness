# harness04 — SWE-bench Eval

> 在 [SWE-bench Lite](https://www.swebench.com/lite.html) 上给 seekHarness 评一个能直接看的 baseline 分数。本文档覆盖 M1（mini 子集端到端）所需的全部操作。

## 0. 我们在评测什么

Lite 共 **300 个真实 GitHub issue**（覆盖 11 个 Python 仓库）。每个 instance 给定：

- `problem_statement`：原 issue 文本
- `base_commit`：仓库的某个 commit 状态（agent 在这个状态上动手）
- `repo` / `repo_dir_name`：要 clone 的 GitHub 仓库
- （评测器自带）`FAIL_TO_PASS` / `PASS_TO_PASS` 测试名 — 用来判定 pass/fail

**判定标准**：agent 提交 patch 后，应用到 `base_commit` 的工作树，跑 `FAIL_TO_PASS` 全部通过 + `PASS_TO_PASS` 不回归 = 1 个 resolved。

我们用 **5 题** 起步验证流程、**20 题** 出第一个 baseline 信号。完整 300 题算力/时间成本太高，留到后续阶段。

## 1. 架构（2 步流水线）

```
┌─────────────────────────────┐
│ scripts/build-mini-set.py   │  HF dataset → datasets/mini*.json
└──────────┬──────────────────┘
           ▼
┌─────────────────────────────┐
│ npm run eval                │  TS：seekHarness agent 跑每题
│ (src/eval/run.ts)           │  产出 outputs/patches/<id>.diff
└──────────┬──────────────────┘
           ▼
┌─────────────────────────────┐
│ npm run eval:score          │  Python：swebench + Docker 跑测
│ (scripts/score.py)          │  产出 outputs/reports/<run_id>/summary.json
└─────────────────────────────┘
```

为什么分两段？agent 跑 patch 这一步不依赖 Docker；评测跑测这一步每次重跑都要起容器，**分开后可以反复调 prompt 不用重复跑测**（前提是 patch 还在 `outputs/patches/`）。

## 2. 一次性环境准备

### 2.1 Python 依赖

```bash
pip install swebench==4.1.0 datasets
```

> ⚠️ `swebench` 会在内部拉 Docker 镜像。Linux/macOS 直接装；**Windows 上推荐 WSL2**（Docker Desktop 走 WSL2 后端最稳）。

### 2.2 Docker

确认 Docker 在跑：

```bash
docker ps     # 不报错即 OK
```

### 2.3 Node 依赖（已有）

```bash
npm install
```

### 2.4 LLM API Key

```bash
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY
```

## 3. 跑一次完整评测

### 3.1 生成 mini 子集

```bash
npm run eval:build -- --size 5     # 第一次：5 题，验证流程
# 或
npm run eval:build -- --size 20    # 之后：20 题，初步 baseline
```

脚本会：

1. 从 `princeton-nlp/SWE-bench_Lite` 拉 300 题
2. 过滤出 "易"的（patch ≤ 2 文件、≤ 100 行、issue 长度合理）
3. 随机抽 N 题（`--seed 42` 复现）
4. 写两份：
   - `datasets/mini.jsonl` — TS runner 吃这个（5 个字段）
   - `datasets/mini-instances.json` — swebench 跑测吃这个（含 FAIL_TO_PASS）

生成完会打印前 3 个 instance_id，可以肉眼挑一眼合不合理。

### 3.2 跑 agent 产 patch

```bash
npm run eval                                # 用默认 datasets/mini.jsonl
# 或
npx tsx src/eval/run.ts datasets/mini.jsonl # 显式指定
```

行为：

- 每个 instance_id 在 `datasets/workspaces/<id>/<repo>/` 下独立 clone 仓库
- `git checkout <base_commit>`
- 注入 `src/eval/system-prompt.ts` 里的 `EVAL_SYSTEM_PROMPT`
- 调 `runAgentTurn` 跑（默认 `maxTurns=30`，hard timeout 10 min）
- 抓 `git diff`（含新建文件） → `outputs/patches/<id>.diff`
- 写 `outputs/run-summary.json`

可调环境变量：

| 变量 | 默认 | 说明 |
|------|------|------|
| `SEEKHARNESS_EVAL_MAX_TURNS` | 30 | 单题最大 agent 轮数 |
| `SEEKHARNESS_EVAL_TIMEOUT_MS` | 600000 | 单题 hard timeout（毫秒） |

### 3.3 跑 swebench 评测

```bash
npm run eval:score
```

第一次会**构建/拉取每个 instance 的 Docker 镜像**（每题独立容器）。5 题大约 20-60 分钟，20 题 1-3 小时，取决于磁盘 + 网络。镜像缓存在 `cache_level=env` 下，重复跑能命中。

完成后看：

```
=== seekHarness eval result (seekharness_20260613_153000) ===
  resolved: 2/5
  mean_acc: 0.400
  summary:  outputs/reports/seekharness_20260613_153000/summary.json
```

## 4. 产物结构

```
datasets/
  mini.jsonl                  # TS runner 入口
  mini-instances.json         # swebench 跑测入口
  workspaces/                 # 每个 instance_id 一份独立 clone
    django__django-12345/
      django/                 # 完整 git 历史
    astropy__astropy-12345/
      astropy/

outputs/
  patches/
    django__django-12345.diff # 实际评估的 patch
    astropy__astropy-12345.diff
  run-summary.json            # TS 跑完的 step 1 摘要
  reports/
    seekharness_20260613_153000/
      predictions.json        # swebench 吃的合并 predictions
      summary.json            # 最终汇总（resolved / failed / mean_acc）
      <instance_id>/report.json   # swebench 写的 per-instance 报告
```

## 5. 调 prompt / 改 tool 后怎么重跑

### 5.1 只重跑 agent（保留之前的评测结果不动）

```bash
rm -rf outputs/patches/ outputs/run-summary.json
npm run eval
# 然后用同一个 run_id 重跑评测（覆盖之前的 summary）：
npm run eval:score -- --run-id seekharness_v2
```

### 5.2 agent 跑了但评测失败，要恢复 / 重新评分

```bash
# 用上次的 predictions 直接重新算 summary，不重跑容器
npm run eval:score -- --run-id seekharness_20260613_153000 --aggregate-only
```

或带上 `--force-rebuild` 强制重建所有 Docker 镜像（开发镜像时偶尔用得到）。

## 6. JSONL 任务格式

`src/eval/run.ts` 吃的每行：

```json
{
  "instance_id": "django__django-12345",
  "problem_statement": "Bug in X: ...",
  "base_commit": "abc123def456...",
  "repo": "https://github.com/django/django",
  "repo_dir_name": "django"
}
```

`repo_dir_name` 可选；省略时从 `repo` URL 末尾推导。**这 5 个字段是 `swebench` Lite 原始 instance 的子集**，所以手工从 Lite 抽题自己写 JSONL 也能直接喂。

## 7. Submission 协议

agent 必须告诉 runner"我提交了"。**当前协议：backticks 文本 + 哨兵字符串**（不是 function calling），见 [src/eval/system-prompt.ts](../src/eval/system-prompt.ts)：

- 正常提交：最后一条 assistant 消息含 `TASK_COMPLETE` 单独一行
- 主动放弃：含 `TASK_ABORT: <reason>` 单独一行（不写 diff，runner 不计分）

**关键细节**：patch 的"真相"是 `git diff` 抓的工作区快照，不是 agent 文本里那个 fenced diff block。两边对不上时以 `git diff` 为准（这是 swebench 应用 patch 的方式决定的）。

## 8. 已知限制（M1 scope 之外）

- **没有 oracle 模式**：直接调 LLM 一次出 patch 的 baseline 还没做（M1 不需要）
- **tool set 不全**：当前只有 read/write/edit/glob。Lite 上很多题需要 `bash` / `grep` / search-style 工具 — 分数会因此偏低
- **顺序跑**：并发=1，5 题要 30-60 分钟；评测时想快可以改 `npm run eval:score -- --max-workers 4`（吃内存）
- **没有 prompt 自动调优**：手工调完 `src/eval/system-prompt.ts` 重跑即可
- **数据集只看 Lite**：Verified（500 题）走另一个 HF dataset，结构同 Lite，改 `--dataset_name` 即可

## 9. 排错

| 现象 | 原因 / 修法 |
|------|-------------|
| `Missing dependency swebench` | 跑 `pip install swebench==4.1.0` |
| `predictions_path` 找不到 diff | 确认 `npm run eval` 跑过，`outputs/patches/*.diff` 存在 |
| docker pull / build 慢 | 第一次没办法；可用 `--cache-level base` 减少每实例的 layer 数 |
| `Empty response from model` | DeepSeek 限流或网络抖动；等几秒重跑那一题（runner 还没实现 retry，可在 run.ts 加） |
| 全部 instance "aborted" | system prompt 没读进去；确认 `src/eval/system-prompt.ts` 的导出名字 |
| Windows: `python` 不存在 | 用 `py -3` 替 `python`，或在 WSL 里跑评测步骤 |
| Test 跑不过但本地看 patch 对 | swebench 用了 `test_patch`，会覆盖测试文件 — 这是评测定义，不要"修"测试 |

## 10. 下一步（M2 候选）

- 接 Verified 500 题（成本高，~130GB 镜像）
- 加 `bash` / `grep` tool，预期 baseline 跳升 10-20pp
- oracle 模式（纯 LLM 一次生成 patch），用来量"工具能带来多少增益"
- 并发评测（`--max-workers 8`）
- 评测报告可视化（一个小网页，列出每题 patch / 测试输出 / resolved）
