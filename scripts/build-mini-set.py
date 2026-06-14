#!/usr/bin/env python3
"""
Build a SWE-bench subset for seekHarness eval.

Supports any SWE-bench dataset on HuggingFace:
  princeton-nlp/SWE-bench_Lite       (300 instances)
  princeton-nlp/SWE-bench_Verified   (500 instances)
  princeton-nlp/SWE-bench            (2,294 instances — "Pro")
  princeton-nlp/SWE-bench_Multilingual
  ScaleAI/SWE-bench_Pro              (731 instances, multi-lang, less contaminated)

Outputs two files:
  datasets/<prefix>.jsonl              — what src/eval/run.ts reads (5 fields)
  datasets/<prefix>-instances.json     — what swebench's grader reads (full schema)

Usage:
  # Lite (default)
  python scripts/build-mini-set.py --size 5

  # Verified
  python scripts/build-mini-set.py --dataset princeton-nlp/SWE-bench_Verified --size 20

  # SWE-bench Pro: 5 Go 仓题试水 (镜像最小)
  python scripts/build-mini-set.py --dataset ScaleAI/SWE-bench_Pro --include-lang go --size 5

  # Pro: 限定到指定仓库白名单 (e.g. 只用 navidrome + flipt)
  python scripts/build-mini-set.py --dataset ScaleAI/SWE-bench_Pro --repo-filter navidrome/navidrome,flipt-io/flipt --size 10

  # Full set (no filter — 2,294 instances)
  python scripts/build-mini-set.py --dataset princeton-nlp/SWE-bench --no-filter --size 50

Filter strategy (pick the "easier" tasks first, skipped with --no-filter):
  - patch touches <= 2 files  (Lite/Verified/Full) | <= 4 files (Pro — patches run bigger)
  - patch has <= 100 lines    (Lite/Verified/Full) | <= 250 lines (Pro)
  - problem_statement is 40-2000 words (Lite) | 200-3000 words (Pro)
  - random sample of the survivors (seed for reproducibility)
"""

import argparse
import json
import random
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DATASETS_DIR = REPO_ROOT / "datasets"
DATASETS_DIR.mkdir(exist_ok=True)

DEFAULT_DATASET = "princeton-nlp/SWE-bench_Lite"

# SWE-bench Pro is multi-lingual. The 'repo_language' column is what Scale
# uses to label each instance — go / js / ts / python.
PRO_LANGUAGES = {"go", "js", "ts", "python"}

# Heuristic detector for "this looks like a Pro instance id" — Pro IDs have a
# `-v<hex>` suffix (Lite/Verified don't). Used to pick the right is_easy()
# thresholds and to drive the `--include-lang` / `--repo-filter` flags.
_PRO_ID_RE = re.compile(r"-v[0-9a-f]{8,}$")


def fetch_dataset(dataset_name: str):
    """Load a SWE-bench dataset from HuggingFace and return list of instance dicts."""
    try:
        from datasets import load_dataset
    except ImportError:
        sys.exit(
            "Missing dependency `datasets`. Install with:\n"
            "  pip install datasets\n"
            "(You can install the full eval stack with: pip install swebench==4.1.0)"
        )
    print(f"Loading {dataset_name} from HuggingFace...", file=sys.stderr)
    ds = load_dataset(dataset_name, split="test")
    return list(ds)


def is_easy(instance: dict) -> bool:
    """Heuristic filter — keep short, single-file-ish fixes (Lite/Verified)."""
    return _is_easy_impl(instance, max_files=2, max_patch_lines=100,
                          min_words=40, max_words=2000)


def _is_easy_impl(
    instance: dict,
    max_files: int,
    max_patch_lines: int,
    min_words: int,
    max_words: int,
) -> bool:
    """Shared body of the easy-task filter with parameterized thresholds."""
    patch = instance.get("patch", "") or ""
    n_files = patch.count("diff --git")
    if n_files < 1 or n_files > max_files:
        return False
    if patch.count("\n") > max_patch_lines:
        return False
    text = (instance.get("problem_statement") or "").strip()
    word_count = len(text.split())
    if word_count < min_words or word_count > max_words:
        return False
    return True


def is_easy_pro(instance: dict) -> bool:
    """Heuristic filter for SWE-bench Pro — patches run larger and problem
    statements run longer, so we use looser thresholds than Lite/Verified.
    """
    return _is_easy_impl(instance, max_files=4, max_patch_lines=250,
                          min_words=200, max_words=3000)


def is_pro_instance(instance: dict) -> bool:
    """Detect SWE-bench Pro instances by their `instance_id` shape.

    Pro ids look like `instance_<Owner__Repo>-<sha>-v<hex>`. Lite/Verified ids
    look like `<owner>__<repo>-<number>`. The `-v<hex>` suffix is the cheapest
    signal — it doesn't need the dataset name and works for any fork of Pro.
    """
    return bool(_PRO_ID_RE.search(instance.get("instance_id", "")))


def to_runner_task(instance: dict) -> dict:
    """Reduce the full instance to the 5 fields src/eval/run.ts needs.

    `instance["repo"]` in SWE-bench Lite/Pro is the short form `owner/name`
    (e.g. `navidrome/navidrome`). Expand it to a full GitHub URL so the runner
    can `git clone` it directly. Anything that already looks like a URL is
    kept as-is, so the function is also safe for non-GitHub repos.
    """
    raw_repo = instance["repo"]
    if raw_repo.startswith("http://") or raw_repo.startswith("https://"):
        repo_url = raw_repo
    else:
        repo_url = f"https://github.com/{raw_repo}"
    return {
        "instance_id": instance["instance_id"],
        "problem_statement": instance["problem_statement"],
        "base_commit": instance["base_commit"],
        "repo": repo_url,
        "repo_dir_name": raw_repo.rstrip("/").split("/")[-1].removesuffix(".git"),
    }


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--dataset", default=DEFAULT_DATASET,
                    help=f"HuggingFace dataset (default: {DEFAULT_DATASET})")
    p.add_argument("--size", type=int, required=True, help="Number of tasks to sample")
    p.add_argument("--seed", type=int, default=42, help="RNG seed for reproducibility")
    p.add_argument(
        "--out-prefix",
        default="mini",
        help="Output file prefix (default: mini → mini.jsonl, mini-instances.json)",
    )
    p.add_argument(
        "--no-filter",
        action="store_true",
        help="Skip the easy-task filter (sample uniformly from all instances)",
    )
    p.add_argument(
        "--repo-filter",
        default=None,
        help=(
            "Comma-separated owner/repo whitelist, e.g. 'navidrome/navidrome,flipt-io/flipt'. "
            "Applies before the easy-task filter. Useful for SWE-bench Pro mini subsets."
        ),
    )
    p.add_argument(
        "--include-lang",
        default=None,
        choices=sorted(PRO_LANGUAGES),
        help=(
            "Restrict to instances whose repo_language matches (e.g. 'go', 'js'). "
            "Only meaningful for SWE-bench Pro — other datasets don't carry a language field."
        ),
    )
    args = p.parse_args()

    if args.size < 1:
        sys.exit("--size must be >= 1")

    # --include-lang and --repo-filter imply a Pro-style dataset
    if args.include_lang is not None and "Pro" not in args.dataset:
        sys.exit(
            f"--include-lang only applies to SWE-bench Pro, got {args.dataset!r}.\n"
            "Use --dataset ScaleAI/SWE-bench_Pro"
        )

    rng = random.Random(args.seed)
    instances = fetch_dataset(args.dataset)
    print(f"Loaded {len(instances)} instances from {args.dataset}", file=sys.stderr)

    # Pipeline of filters: repo whitelist → language → easy-task → sample
    if args.repo_filter:
        whitelist = {r.strip() for r in args.repo_filter.split(",") if r.strip()}
        instances = [i for i in instances if i.get("repo") in whitelist]
        print(
            f"After --repo-filter {sorted(whitelist)}: {len(instances)} candidates",
            file=sys.stderr,
        )

    if args.include_lang is not None:
        before = len(instances)
        instances = [
            i for i in instances
            if (i.get("repo_language") or "").lower() == args.include_lang
        ]
        print(
            f"After --include-lang {args.include_lang}: {len(instances)} candidates "
            f"(was {before})",
            file=sys.stderr,
        )

    # Auto-pick the easy filter based on dataset shape: Pro ids have a
    # `-v<hex>` suffix, Lite/Verified don't. This way the same script works
    # for any of {Lite, Verified, Full, Multilingual, Pro} without an extra
    # flag.
    is_pro = is_pro_instance(instances[0]) if instances else False

    if args.no_filter:
        pool = instances
    elif is_pro:
        pool = [i for i in instances if is_easy_pro(i)]
        print(
            f"After Pro easy-filter (≤4 files, ≤250 lines, 200-3000 words): "
            f"{len(pool)} candidates",
            file=sys.stderr,
        )
    else:
        pool = [i for i in instances if is_easy(i)]
        print(f"After easy-filter: {len(pool)} candidates", file=sys.stderr)

    if not pool:
        sys.exit(
            "No instances survived filtering. Try --no-filter, broaden --repo-filter, "
            "or pick another --include-lang."
        )

    if args.size > len(pool):
        print(
            f"WARNING: Requested {args.size} tasks but only {len(pool)} available. "
            f"Using all {len(pool)}.",
            file=sys.stderr,
        )
        picked = pool
    else:
        picked = rng.sample(pool, args.size)
    picked.sort(key=lambda i: i["instance_id"])  # stable, easy to diff

    out_jsonl = DATASETS_DIR / f"{args.out_prefix}.jsonl"
    out_instances = DATASETS_DIR / f"{args.out_prefix}-instances.json"

    with out_jsonl.open("w", encoding="utf-8") as f:
        for inst in picked:
            f.write(json.dumps(to_runner_task(inst), ensure_ascii=False) + "\n")
    print(f"Wrote {len(picked)} tasks → {out_jsonl}", file=sys.stderr)

    # swebench grader expects the original Lite instance dicts (with FAIL_TO_PASS etc.)
    with out_instances.open("w", encoding="utf-8") as f:
        json.dump(picked, f, ensure_ascii=False, indent=2)
    print(f"Wrote full instance data → {out_instances}", file=sys.stderr)

    # Helpful preview
    print(f"\nFirst 3 tasks from {args.dataset}:")
    for inst in picked[:3]:
        print(f"  - {inst['instance_id']}  ({inst['repo']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
