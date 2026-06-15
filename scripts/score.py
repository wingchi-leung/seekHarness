#!/usr/bin/env python3
"""
Score seekHarness eval outputs with the official swebench==4.1.0 harness.

Workflow:
  1. Collect every outputs/patches/<instance_id>.diff into one predictions.json
     (the format swebench.harness.run_evaluation expects).
  2. Invoke swebench to run FAIL_TO_PASS / PASS_TO_PASS tests in Docker.
  3. Aggregate per-instance report.json files into a single summary.json.

Usage:
  python scripts/score.py --run-id seekharness_2026-06-13
  python scripts/score.py --predictions outputs/patches --dataset datasets/mini-instances.json

Notes:
  - First run builds (or pulls) the per-instance Docker images. With 5 tasks this
    can take 20-60 minutes; with 20 tasks 1-3 hours depending on disk + network.
  - Each instance gets a fresh container. 8 GB free disk per instance is safe.
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PREDICTIONS_DIR = REPO_ROOT / "outputs" / "patches"
DEFAULT_DATASET_FILE = REPO_ROOT / "datasets" / "mini-instances.json"
DEFAULT_REPORT_DIR = REPO_ROOT / "outputs" / "reports"


def collect_predictions(patches_dir: Path, model_name: str) -> list[dict]:
    """Read every <id>.diff under patches_dir and assemble the predictions list."""
    if not patches_dir.exists():
        sys.exit(f"Predictions dir not found: {patches_dir}")
    diff_files = sorted(patches_dir.glob("*.diff"))
    if not diff_files:
        sys.exit(f"No .diff files in {patches_dir}. Run `npm run eval` first.")

    preds = []
    for p in diff_files:
        preds.append({
            "instance_id": p.stem,
            "model_name_or_path": model_name,
            "model_patch": p.read_text(encoding="utf-8"),
        })
    print(f"Collected {len(preds)} predictions from {patches_dir}", file=sys.stderr)
    return preds


def ensure_swebench():
    try:
        from swebench.harness.run_evaluation import main as run_eval  # noqa: F401
    except ImportError:
        sys.exit(
            "Missing dependency `swebench`. Install with:\n"
            "  pip install swebench==4.1.0\n"
            "(On Windows, run inside WSL — Docker is required and is easiest on Linux/macOS.)"
        )


def write_predictions_file(preds: list[dict], out_path: Path) -> None:
    out_path.write_text(json.dumps(preds, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote predictions → {out_path}", file=sys.stderr)


def run_swebench(
    predictions_file: Path,
    dataset_file: Path,
    instance_ids: list,
    run_id: str,
    report_dir: Path,
    max_workers: int,
    timeout: int,
    cache_level: str,
    force_rebuild: bool,
    namespace: str | None,
):
    """Invoke swebench's main(). Returns nothing; reports written under report_dir."""
    from swebench.harness.run_evaluation import main as swebench_main

    swebench_main(
        dataset_name=str(dataset_file),
        split="test",
        instance_ids=instance_ids,
        predictions_path=str(predictions_file),
        max_workers=max_workers,
        force_rebuild=force_rebuild,
        cache_level=cache_level,
        clean=False,
        open_file_limit=4096,
        run_id=run_id,
        timeout=timeout,
        namespace=namespace,
        rewrite_reports=False,
        modal=False,
        instance_image_tag="latest",
        env_image_tag="latest",
        report_dir=str(report_dir),
    )


def aggregate_reports(run_id: str, report_dir: Path, instance_ids: list[str]) -> dict:
    """Walk the per-instance report.json files swebench wrote and sum them up."""
    # swebench writes a nested structure: <report_dir>/<run_id>/<model_name>/<instance_id>/report.json
    # The model name "seekharness" is what we passed in collect_predictions.
    candidates = list(report_dir.rglob("report.json"))
    if not candidates:
        print("WARN: no report.json files found — evaluation may have failed", file=sys.stderr)

    per_instance: dict[str, dict] = {}
    for rf in candidates:
        try:
            data = json.loads(rf.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"  could not parse {rf}: {e}", file=sys.stderr)
            continue
        if not isinstance(data, dict):
            continue
        iid = next(iter(data))
        if iid in per_instance:
            # keep first; should not happen
            continue
        per_instance[iid] = data[iid]

    # ensure every requested instance has a record (missing = not run / errored)
    for iid in instance_ids:
        per_instance.setdefault(iid, {"resolved": False, "missing": True})

    passed = sorted(iid for iid, r in per_instance.items() if r.get("resolved"))
    failed = sorted(iid for iid, r in per_instance.items() if not r.get("resolved"))
    n = len(per_instance)
    return {
        "run_id": run_id,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "total": n,
        "resolved": len(passed),
        "mean_acc": (len(passed) / n) if n else 0.0,
        "passed": passed,
        "failed": failed,
        "per_instance": per_instance,
    }


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--run-id", default=f"seekharness_{datetime.now().strftime('%Y%m%d_%H%M%S')}",
                   help="Identifier for this eval run (used as log dir name)")
    p.add_argument("--predictions", type=Path, default=DEFAULT_PREDICTIONS_DIR,
                   help=f"Dir with <id>.diff files (default: {DEFAULT_PREDICTIONS_DIR})")
    p.add_argument("--dataset", type=Path, default=DEFAULT_DATASET_FILE,
                   help=f"Path to mini-instances.json (default: {DEFAULT_DATASET_FILE})")
    p.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_DIR,
                   help=f"Where to write the report (default: {DEFAULT_REPORT_DIR})")
    p.add_argument("--max-workers", type=int, default=2,
                   help="Parallel containers (default: 2 — be gentle on memory)")
    p.add_argument("--timeout", type=int, default=1800,
                   help="Per-instance test timeout in seconds (default: 1800)")
    p.add_argument("--cache-level", default="env",
                   choices=["none", "base", "env", "instance"],
                   help="Docker image caching aggressiveness (default: env)")
    p.add_argument("--force-rebuild", action="store_true",
                   help="Rebuild all Docker images from scratch")
    p.add_argument("--namespace", default="swebench",
                   help="Docker image namespace prefix (use '' / null to disable)")
    p.add_argument("--model-name", default="seekharness",
                   help="Value written to model_name_or_path in predictions")
    p.add_argument("--aggregate-only", action="store_true",
                   help="Skip swebench run — just rebuild the summary from existing reports")
    args = p.parse_args()

    ensure_swebench()
    args.report_dir.mkdir(parents=True, exist_ok=True)

    # Always build a predictions.json — even in aggregate-only mode, so the file
    # at outputs/reports/<run_id>/predictions.json reflects what we scored.
    preds = collect_predictions(args.predictions, args.model_name)
    predictions_file = args.report_dir / args.run_id / "predictions.json"
    predictions_file.parent.mkdir(parents=True, exist_ok=True)
    write_predictions_file(preds, predictions_file)

    instance_ids = [p["instance_id"] for p in preds]

    if not args.aggregate_only:
        print(f"Running swebench evaluation (run_id={args.run_id})...", file=sys.stderr)
        run_swebench(
            predictions_file=predictions_file,
            dataset_file=args.dataset,
            instance_ids=instance_ids,
            run_id=args.run_id,
            report_dir=args.report_dir,
            max_workers=args.max_workers,
            timeout=args.timeout,
            cache_level=args.cache_level,
            force_rebuild=args.force_rebuild,
            namespace=(args.namespace or None),
        )

    summary = aggregate_reports(args.run_id, args.report_dir, instance_ids)
    summary_file = args.report_dir / args.run_id / "summary.json"
    summary_file.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n=== seekHarness eval result ({args.run_id}) ===")
    print(f"  resolved: {summary['resolved']}/{summary['total']}")
    print(f"  mean_acc: {summary['mean_acc']:.3f}")
    print(f"  summary:  {summary_file}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
