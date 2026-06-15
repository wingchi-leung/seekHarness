#!/usr/bin/env python3
"""
Lightweight SWE-bench-style scorer for seekHarness patches.

Why this exists
---------------
The official swebench==4.1.0 harness can't run on Windows because its
`prepare_images.py` imports `resource` (a Linux-only stdlib). This script
is a Windows-friendly substitute that:

  1. For each <id>.diff in outputs/patches/
     a. Re-checkouts the repo to base_commit (in the existing workspace)
     b. Applies the seekharness agent's patch
     c. Applies SWE-bench's test_patch (which contains the FAIL_TO_PASS tests)
     d. Runs the FAIL_TO_PASS tests + a sample of PASS_TO_PASS tests
     e. Records pass/fail per test
  2. Marks the instance resolved iff every FAIL_TO_PASS test passes AND
     no PASS_TO_PASS test regresses.

It's not a 1:1 replacement for the official harness — swebench also builds
a Docker image per repo with the exact pinned dependencies. Here we just
trust that the workspaces already on disk are close enough to base_commit
state. The result is a useful *upper-bound* estimate of resolve rate.

Usage:
  python scripts/score-simple.py
  python scripts/score-simple.py --patches-dir outputs/patches \
                                 --dataset datasets/pro-v2-instances.json \
                                 --timeout 300
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PATCHES_DIR = REPO_ROOT / "outputs" / "patches"
DEFAULT_DATASET = REPO_ROOT / "datasets" / "pro-v2-instances.json"
DEFAULT_REPORT_DIR = REPO_ROOT / "outputs" / "reports"
DEFAULT_WORKSPACE_ROOT = REPO_ROOT / "datasets" / "workspaces"


def run(cmd: list[str], cwd: Path, timeout: int = 300,
        check: bool = False) -> subprocess.CompletedProcess:
    """Run a command without shell (works on Windows + Linux)."""
    try:
        return subprocess.run(
            cmd,
            cwd=str(cwd),
            shell=False,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=check,
        )
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(cmd, -1, "", f"timeout after {timeout}s")


def repo_dir_for(instance_id: str, repo: str, workspace_root: Path) -> Path | None:
    """Find the cloned repo dir for an instance_id. Mirrors the layout
    produced by src/eval/run.ts: <workspace>/<id>/<repo_dir_name>."""
    repo_dir_name = repo.rstrip("/").split("/")[-1].removesuffix(".git")
    candidate = workspace_root / instance_id / repo_dir_name
    if (candidate / ".git").exists():
        return candidate
    # Fallback: any repo dir under the instance workspace
    inst_dir = workspace_root / instance_id
    if inst_dir.exists():
        for child in inst_dir.iterdir():
            if (child / ".git").exists():
                return child
    return None


def reset_to_base(repo_dir: Path, base_commit: str) -> bool:
    """Hard-reset the working tree to base_commit, including untracked files.

    The agent writes files directly to the working tree without committing,
    so `git reset --hard` alone won't restore them. We need:
      1. checkout -- .   to restore tracked files the agent modified
      2. clean -fdx      to remove any new untracked files the agent created
      3. reset --hard    to make sure HEAD is at base_commit
    """
    run(["git", "checkout", base_commit, "--", "."], cwd=repo_dir, timeout=120)
    run(["git", "clean", "-fdx"], cwd=repo_dir, timeout=120)
    run(["git", "reset", "--hard", base_commit], cwd=repo_dir, timeout=120)
    return True


def apply_patch(patch_text: str, repo_dir: Path, label: str) -> tuple[bool, str]:
    """Apply a unified diff via `git apply`. Returns (ok, msg).

    We write the patch to a temp file rather than piping stdin, because on
    Windows, shell=True + stdin pipe can corrupt bytes or lose the '-' arg.
    """
    if not patch_text.strip():
        return False, f"{label}: empty patch"
    import tempfile, os
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".patch", delete=False, encoding="utf-8"
    ) as tf:
        tf.write(patch_text)
        tmp_path = tf.name
    try:
        proc = subprocess.run(
            ["git", "apply", "--whitespace=nowarn", "--ignore-whitespace", tmp_path],
            cwd=str(repo_dir),
            capture_output=True,
            text=True,
            timeout=60,
        )
        if proc.returncode == 0:
            return True, "applied"
        return False, f"{label}: {proc.stderr.strip()[:200]}"
    finally:
        os.unlink(tmp_path)


def detect_test_runner(repo_dir: Path, instance_id: str) -> str:
    """Pick the right test command for this repo."""
    # Most Python repos in our set use pytest
    if (repo_dir / "pytest.ini").exists() or (repo_dir / "pyproject.toml").exists():
        return "pytest"
    if (repo_dir / "setup.py").exists() or (repo_dir / "setup.cfg").exists():
        return "pytest"
    # Django uses its own runner
    if "django" in instance_id:
        return "django"
    # SymPy uses bin/test
    if "sympy" in instance_id:
        return "sympy"
    return "pytest"


def run_tests(cmd: list[str], cwd: Path, timeout: int) -> tuple[int, str, str]:
    """Run a test command in a clean environment (no inherited PYTHONPATH)."""
    import os
    env = os.environ.copy()
    # Clear any PYTHONPATH that might point at another workspace's source tree.
    env.pop("PYTHONPATH", None)
    try:
        proc = subprocess.run(
            " ".join(cmd),
            cwd=str(cwd),
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        return -1, "", f"test timeout after {timeout}s"


def score_instance(
    instance: dict,
    patches_dir: Path,
    workspace_root: Path,
    timeout: int,
) -> dict:
    """Score one instance. Returns a result dict."""
    iid = instance["instance_id"]
    base_commit = instance["base_commit"]
    repo = instance["repo"]
    fail_to_pass = instance.get("FAIL_TO_PASS", [])
    pass_to_pass = instance.get("PASS_TO_PASS", [])
    test_patch = instance.get("test_patch", "")

    patch_path = patches_dir / f"{iid}.diff"
    if not patch_path.exists():
        return {
            "instance_id": iid, "resolved": False,
            "reason": f"no patch at {patch_path.name}",
        }
    patch_text = patch_path.read_text(encoding="utf-8")

    repo_dir = repo_dir_for(iid, repo, workspace_root)
    if repo_dir is None:
        return {
            "instance_id": iid, "resolved": False,
            "reason": f"no workspace for {iid}",
        }

    # Step 1: reset to base_commit
    reset_to_base(repo_dir, base_commit)

    # Step 2: apply agent patch
    agent_ok, agent_msg = apply_patch(patch_text, repo_dir, "agent")
    if not agent_ok:
        return {
            "instance_id": iid, "resolved": False,
            "reason": f"agent patch failed: {agent_msg}",
        }

    # Step 3: apply SWE-bench test_patch (the FAIL_TO_PASS tests)
    test_ok, test_msg = apply_patch(test_patch, repo_dir, "test_patch")
    if not test_ok:
        return {
            "instance_id": iid, "resolved": False,
            "reason": f"test_patch failed: {test_msg}",
            "agent_patch_applied": True,
        }

    # Step 4: run FAIL_TO_PASS tests
    runner = detect_test_runner(repo_dir, iid)
    # Subset of PASS_TO_PASS to verify we didn't break existing behavior.
    # We pick at most 10 to keep things fast.
    p2p_sample = pass_to_pass[:10]

    fail_results = []
    if fail_to_pass:
        if runner == "pytest":
            cmd = ["pytest", "-x", "--tb=line", "-q", *fail_to_pass]
        elif runner == "django":
            cmd = ["pytest", "-x", "--tb=line", "-q", *fail_to_pass]
        elif runner == "sympy":
            cmd = ["pytest", "-x", "--tb=line", "-q", *fail_to_pass]
        else:
            cmd = ["pytest", "-x", "--tb=line", "-q", *fail_to_pass]
        rc, out, err = run_tests(cmd, repo_dir, timeout)
        fail_results.append({
            "tests": fail_to_pass, "returncode": rc,
            "stdout_tail": out[-1000:], "stderr_tail": err[-500:],
        })
        all_fail_passed = (rc == 0)
    else:
        all_fail_passed = True  # nothing to check

    # Step 5: run a sample of PASS_TO_PASS
    p2p_results = []
    p2p_regressed = False
    if p2p_sample:
        cmd = ["pytest", "-x", "--tb=line", "-q", *p2p_sample]
        rc, out, err = run_tests(cmd, repo_dir, timeout)
        p2p_results.append({"tests": p2p_sample, "returncode": rc})
        if rc != 0:
            p2p_regressed = True

    # Final verdict
    resolved = all_fail_passed and not p2p_regressed
    return {
        "instance_id": iid,
        "resolved": resolved,
        "reason": (
            "all FAIL_TO_PASS passed" if resolved
            else "FAIL_TO_PASS failed" if not all_fail_passed
            else "PASS_TO_PASS regressed"
        ),
        "fail_to_pass": fail_results,
        "pass_to_pass_sample": p2p_results,
        "agent_patch_applied": True,
        "test_patch_applied": True,
    }


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--patches-dir", type=Path, default=DEFAULT_PATCHES_DIR)
    p.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    p.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_DIR)
    p.add_argument("--workspace-root", type=Path, default=DEFAULT_WORKSPACE_ROOT)
    p.add_argument("--timeout", type=int, default=300,
                   help="Per-instance test timeout in seconds")
    p.add_argument("--max-workers", type=int, default=1,
                   help="Parallel instances (1 = safe on Windows)")
    p.add_argument("--run-id", default=None)
    args = p.parse_args()

    args.report_dir.mkdir(parents=True, exist_ok=True)
    run_id = args.run_id or f"simple_{time.strftime('%Y%m%d_%H%M%S')}"
    out_dir = args.report_dir / run_id
    out_dir.mkdir(parents=True, exist_ok=True)

    dataset = json.loads(args.dataset.read_text(encoding="utf-8"))
    diff_files = sorted(args.patches_dir.glob("*.diff"))
    print(f"Found {len(diff_files)} patches, {len(dataset)} instances in dataset",
          file=sys.stderr)

    instances_by_id = {x["instance_id"]: x for x in dataset}

    started = time.time()
    results: list[dict] = []

    def _work(iid_path):
        iid, patch_path = iid_path
        if iid not in instances_by_id:
            return {
                "instance_id": iid, "resolved": False,
                "reason": f"{iid} not in dataset (stale patch?)",
            }
        return score_instance(
            instances_by_id[iid], args.patches_dir,
            args.workspace_root, args.timeout,
        )

    work = [(p.stem, p) for p in diff_files]
    if args.max_workers <= 1:
        for w in work:
            r = _work(w)
            results.append(r)
            mark = "✓" if r["resolved"] else "✗"
            print(f"  {mark} {r['instance_id']:50s} {r.get('reason', '')}",
                  file=sys.stderr)
    else:
        with ThreadPoolExecutor(max_workers=args.max_workers) as ex:
            futs = {ex.submit(_work, w): w[0] for w in work}
            for fut in as_completed(futs):
                r = fut.result()
                results.append(r)

    # Sort by instance_id for stable output
    results.sort(key=lambda r: r["instance_id"])

    elapsed = time.time() - started
    resolved = sum(1 for r in results if r["resolved"])
    summary = {
        "run_id": run_id,
        "total": len(results),
        "resolved": resolved,
        "mean_acc": (resolved / len(results)) if results else 0.0,
        "elapsed_sec": round(elapsed, 1),
        "per_instance": results,
    }
    out_file = out_dir / "summary.json"
    out_file.write_text(json.dumps(summary, ensure_ascii=False, indent=2),
                        encoding="utf-8")

    print(f"\n=== seekHarness simple-scorer ({run_id}) ===", file=sys.stderr)
    print(f"  resolved: {resolved}/{len(results)} "
          f"({summary['mean_acc']*100:.1f}%)", file=sys.stderr)
    print(f"  elapsed:  {elapsed:.1f}s", file=sys.stderr)
    print(f"  summary:  {out_file}", file=sys.stderr)

    # Print PASS/FAIL table
    print("\n  per-instance:", file=sys.stderr)
    for r in results:
        mark = "PASS" if r["resolved"] else "FAIL"
        print(f"    [{mark}] {r['instance_id']:50s} {r.get('reason', '')}",
              file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
