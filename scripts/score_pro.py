#!/usr/bin/env python3
"""
Score seekHarness SWE-bench Pro eval outputs.

Host-mode runner: no Docker, no sweap-images. Reuses each instance's
official `run_script.sh` + `parser.py` from the SWE-bench_Pro-os repo
(https://github.com/scaleapi/SWE-bench_Pro-os). Works because the
`run_script.sh` for Go repos just shells out to `go test -v -run ...`,
which the host can do directly as long as the right Go toolchain is
installed.

Workflow per instance:
  1. Locate the agent's workspace  (datasets/workspaces/<id>/<repo_dir_name>)
  2. git reset --hard <base_commit>           (drop any agent changes)
  3. shell out to instance["before_repo_set_cmd"]  (the official "setup")
  4. if instance["test_patch"]: git apply it  (some Pro tasks need this)
  5. git apply outputs/patches/<id>.diff      (the agent's actual patch)
  6. bash run_script.sh <fail_to_pass_csv>    → stdout.log / stderr.log
  7. python parser.py stdout.log stderr.log output.json
  8. resolved = fail_to_pass all PASSED  +  pass_to_pass all PASSED

Usage:
  python scripts/score_pro.py --pro-eval-root C:/path/to/SWE-bench_Pro-os
  python scripts/score_pro.py --pro-eval-root /tmp/swe_bench_pro --run-id m2

Notes:
  - Unlike Lite, Pro's `pass_to_pass` is empty for most tasks in the easy
    subset, so we only require `fail_to_pass` to be PASSED. If `pass_to_pass`
    is non-empty we check it too.
  - Each instance has its own `parser.py` (regex varies per-language). The
    parser is invoked as a subprocess; if it returns non-zero we treat the
    instance as "not resolved" with the parser stderr captured.
"""

import argparse
import ast
import json
import os
import shlex
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PREDICTIONS_DIR = REPO_ROOT / "outputs" / "patches"
DEFAULT_DATASET_FILE = REPO_ROOT / "datasets" / "pro-try-instances.json"
DEFAULT_REPORT_DIR = REPO_ROOT / "outputs" / "reports"
DEFAULT_PRO_EVAL_ROOT = Path("C:/Users/g0132/AppData/Local/Temp/swe_bench_pro")
DEFAULT_WORKSPACE_ROOT = REPO_ROOT / "datasets" / "workspaces"


def _normalize_test_list(raw) -> list[str]:
    """HF stores fail_to_pass / pass_to_pass as a Python list REPR string
    (e.g. `"['TestFoo', 'TestBar']"`) when you read it back from JSON, NOT a
    proper JSON list. ast.literal_eval is the safe way to recover it; if
    it's already a list we just hand it back.
    """
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(x) for x in raw]
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return []
        try:
            v = ast.literal_eval(s)
            if isinstance(v, list):
                return [str(x) for x in v]
        except (ValueError, SyntaxError):
            # fall through to comma-split below
            pass
        return [t.strip().strip("'\"") for t in s.split(",") if t.strip()]
    return [str(raw)]


def collect_predictions(patches_dir: Path) -> list[dict]:
    """Read every <id>.diff under patches_dir and return [{instance_id, model_patch}, ...]."""
    if not patches_dir.exists():
        sys.exit(f"Predictions dir not found: {patches_dir}")
    diff_files = sorted(patches_dir.glob("*.diff"))
    if not diff_files:
        sys.exit(f"No .diff files in {patches_dir}. Run `npm run eval:pro` first.")
    preds = []
    for p in diff_files:
        preds.append({
            "instance_id": p.stem,
            "model_patch": p.read_text(encoding="utf-8"),
        })
    print(f"Collected {len(preds)} predictions from {patches_dir}", file=sys.stderr)
    return preds


def write_predictions_file(preds: list[dict], out_path: Path) -> None:
    out_path.write_text(json.dumps(preds, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote predictions → {out_path}", file=sys.stderr)


def _run(
    cmd: list[str],
    cwd: Path,
    timeout: int,
    input_text: str | None = None,
) -> subprocess.CompletedProcess:
    """Run a command in cwd, return CompletedProcess. Decodes output as utf-8
    with replacement (Go test output sometimes has weird bytes). Inherits the
    host env plus the toolchain dirs we know about (Go, etc.)."""
    return subprocess.run(
        cmd,
        cwd=cwd,
        input=input_text,
        env=_subprocess_env(),
        capture_output=True,
        text=True,
        timeout=timeout,
        encoding="utf-8",
        errors="replace",
    )


def _resolve_bash() -> str:
    """Locate a bash.exe on Windows. Falls back to whatever's in PATH."""
    candidates = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
        r"D:\code\Git\usr\bin\bash.exe",   # custom install path on this box
        shutil.which("bash") or "bash",
    ]
    for c in candidates:
        if Path(c).exists():
            return c
    return candidates[-1]


def _resolve_go_dir() -> str | None:
    """Locate the Go install dir (containing bin/go.exe). Returns None if
    Go isn't installed — in that case Go-dependent instances will fail
    with a clear error in the run_script step.
    """
    candidates = [
        r"C:\Go\bin",
        r"C:\Program Files\Go\bin",
        r"D:\Go\bin",
    ]
    for c in candidates:
        if Path(c).joinpath("go.exe").exists():
            return c
    which = shutil.which("go")
    if which:
        return str(Path(which).parent)
    return None


def _subprocess_env() -> dict:
    """Build the env for child processes. We prepend common toolchain dirs
    (Go, etc.) that may not be in the user's PATH yet — e.g. after a
    manual Go zip install. Idempotent / no-op when Go is already on PATH.
    """
    env = os.environ.copy()
    extra_dirs: list[str] = []
    go_dir = _resolve_go_dir()
    if go_dir:
        extra_dirs.append(go_dir)
    if extra_dirs:
        env["PATH"] = os.pathsep.join(extra_dirs + [env.get("PATH", "")])
    return env


def _resolve_python() -> str:
    """Use the current interpreter (sys.executable) for invoking parser.py —
    we already know it works because we ARE this interpreter."""
    return sys.executable


def score_one(
    instance: dict,
    model_patch: str,
    pro_eval_root: Path,
    report_dir: Path,
    workspace_root: Path,
    timeout: int,
) -> dict:
    """Score a single instance. Returns a report dict (also written to disk)."""
    iid = instance["instance_id"]
    base_commit = instance["base_commit"]
    repo_dir_name = instance.get("repo_dir_name") or instance["repo"].split("/")[-1]
    workspace = workspace_root / iid / repo_dir_name

    inst_report_dir = report_dir / iid
    inst_report_dir.mkdir(parents=True, exist_ok=True)
    stdout_log = inst_report_dir / "stdout.log"
    stderr_log = inst_report_dir / "stderr.log"
    parsed_json = inst_report_dir / "output.json"
    report_path = inst_report_dir / "report.json"

    report = {
        "instance_id": iid,
        "base_commit": base_commit,
        "fail_to_pass": _normalize_test_list(instance.get("fail_to_pass")),
        "pass_to_pass": _normalize_test_list(instance.get("pass_to_pass")),
        "resolved": False,
        "steps": [],   # ordered list of {step, ok, detail} for debugging
    }

    def step(name: str, ok: bool, detail: str = "") -> None:
        report["steps"].append({"step": name, "ok": ok, "detail": detail[:500]})

    # --- Step 1: workspace present ---
    if not (workspace / ".git").exists():
        step("workspace", False, f"missing: {workspace}")
        report["error"] = "workspace missing — run `npm run eval:pro` first"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        return report

    # --- Step 2: reset to base_commit (drop any prior agent changes) ---
    r = _run(["git", "reset", "--hard", base_commit], cwd=workspace, timeout=30)
    step("git_reset", r.returncode == 0, r.stderr.strip() or r.stdout.strip())
    if r.returncode != 0:
        report["error"] = f"git reset failed: {r.stderr.strip()}"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        return report

    # --- Step 3: before_repo_set_cmd (multi-line shell) ---
    before_cmd = (instance.get("before_repo_set_cmd") or "").strip()
    if before_cmd:
        # The cmd is a series of `git` invocations separated by newlines.
        # We run them as a single shell command under bash (not the Windows
        # default cmd.exe), in the repo's cwd. Using bash keeps behavior
        # consistent with run_script.sh below and avoids Git's "fatal: not
        # a git repository" error you get when cmd.exe calls git without a
        # proper PATH that includes git's bin dir.
        bash = _resolve_bash()
        r = subprocess.run(
            [bash, "-c", before_cmd],
            cwd=workspace,
            env=_subprocess_env(),
            capture_output=True,
            text=True,
            timeout=60,
            encoding="utf-8",
            errors="replace",
        )
        step("before_repo_set_cmd", r.returncode == 0,
             (r.stderr.strip() or r.stdout.strip())[:500])
        if r.returncode != 0:
            report["error"] = f"before_repo_set_cmd failed: {r.stderr.strip()[:500]}"
            report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            return report

    # --- Step 4: apply test_patch (if any) ---
    test_patch = (instance.get("test_patch") or "").strip()
    if test_patch:
        test_patch_path = inst_report_dir / "test_patch.diff"
        test_patch_path.write_text(test_patch, encoding="utf-8")
        r = _run(["git", "apply", "--ignore-whitespace", str(test_patch_path)],
                 cwd=workspace, timeout=30)
        step("apply_test_patch", r.returncode == 0,
             r.stderr.strip() or r.stdout.strip())
        # Pro mini subset often has test_patch empty; failure here is non-fatal
        # but logged — if the FAIL_TO_PASS test then doesn't exist, the
        # subsequent `go test` will simply report "no tests to run" and the
        # parser will return an empty list, which fails the resolved check.

    # --- Step 5: apply agent's model patch ---
    model_patch_path = inst_report_dir / "model_patch.diff"
    model_patch_path.write_text(model_patch, encoding="utf-8")
    r = _run(["git", "apply", "--ignore-whitespace", str(model_patch_path)],
             cwd=workspace, timeout=30)
    step("apply_model_patch", r.returncode == 0,
         r.stderr.strip() or r.stdout.strip())
    if r.returncode != 0:
        report["error"] = f"model patch failed to apply: {r.stderr.strip()[:500]}"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        return report

    # --- Step 6: run the test script ---
    fail_to_pass = _normalize_test_list(instance.get("fail_to_pass"))
    run_script = pro_eval_root / "run_scripts" / iid / "run_script.sh"
    if not run_script.exists():
        report["error"] = f"run_script.sh missing: {run_script}"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        return report

    bash = _resolve_bash()
    # Wrap the script with an explicit PATH export so the bash subshell sees
    # Go (which may live at C:\Go\bin but isn't on the Git Bash default
    # PATH). `export PATH=...` is POSIX-portable and works on every Git
    # Bash on Windows. We also pin GOPROXY to goproxy.cn — the default
    # proxy.golang.org frequently times out from mainland China, which
    # would silently break `go mod download` on the first test run.
    go_dir = _resolve_go_dir()
    prefix_lines: list[str] = []
    if go_dir:
        if go_dir[1:3] == ":\\":
            drive = go_dir[0].lower()
            path_for_bash = f"/{drive}" + go_dir[2:].replace("\\", "/")
        else:
            path_for_bash = go_dir.replace("\\", "/")
        prefix_lines.append(f'export PATH="{path_for_bash}:$PATH"')
    prefix_lines.append('export GOPROXY="${GOPROXY:-https://goproxy.cn,direct}"')
    prefix_lines.append('export GOSUMDB=off')   # skip checksum DB lookup; speeds things up
    if prefix_lines:
        wrapped = "\n".join(prefix_lines) + "\n" + Path(run_script).read_text(encoding="utf-8")
        try:
            r = _run([bash, "-c", wrapped], cwd=workspace, timeout=timeout)
        except subprocess.TimeoutExpired as e:
            # Persist whatever partial output was captured so we can debug.
            stdout_log.write_text(
                (e.stdout or b"").decode("utf-8", errors="replace")
                if isinstance(e.stdout, (bytes, bytearray)) else (e.stdout or ""),
                encoding="utf-8",
            )
            stderr_log.write_text(
                f"[score_pro] run_script timed out after {timeout}s\n"
                + (e.stderr or b"").decode("utf-8", errors="replace")
                if isinstance(e.stderr, (bytes, bytearray)) else (e.stderr or ""),
                encoding="utf-8",
            )
            step("run_script", False, f"TIMEOUT after {timeout}s")
            report["error"] = f"run_script timed out after {timeout}s"
            report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            return report
    else:
        r = _run([bash, str(run_script), *fail_to_pass], cwd=workspace, timeout=timeout)
    stdout_log.write_text(r.stdout, encoding="utf-8")
    stderr_log.write_text(r.stderr, encoding="utf-8")
    step("run_script", r.returncode in (0, 1),
         f"exit={r.returncode}  stdout={len(r.stdout)}B  stderr={len(r.stderr)}B")
    # NOTE: `go test` returns non-zero when tests fail, which is the *normal*
    # case for the pre-patch baseline. We don't bail on non-zero here — we
    # let the parser decide.

    # --- Step 7: parse the test output ---
    parser = pro_eval_root / "run_scripts" / iid / "parser.py"
    if not parser.exists():
        report["error"] = f"parser.py missing: {parser}"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        return report

    py = _resolve_python()
    r = _run([py, str(parser), str(stdout_log), str(stderr_log), str(parsed_json)],
             cwd=inst_report_dir, timeout=30)
    step("parser", r.returncode == 0, r.stderr.strip() or r.stdout.strip())
    if r.returncode != 0 or not parsed_json.exists():
        report["error"] = f"parser failed (exit={r.returncode}): {r.stderr.strip()[:500]}"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        return report

    # --- Step 8: judge ---
    try:
        parsed = json.loads(parsed_json.read_text(encoding="utf-8"))
    except Exception as e:
        report["error"] = f"could not parse parser output: {e}"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        return report

    # Build name → status map (parser returns FAILED/PASSED/SKIPPED/ERROR)
    by_name: dict[str, str] = {}
    for t in parsed.get("tests", []):
        by_name[t["name"]] = t["status"]

    fail_to_pass_status = {n: by_name.get(n, "MISSING") for n in fail_to_pass}
    pass_to_pass = _normalize_test_list(instance.get("pass_to_pass"))
    pass_to_pass_status = {n: by_name.get(n, "MISSING") for n in pass_to_pass}

    report["fail_to_pass_status"] = fail_to_pass_status
    report["pass_to_pass_status"] = pass_to_pass_status

    # resolved = all fail_to_pass PASSED  AND  (no pass_to_pass OR all PASSED)
    all_f2p_pass = bool(fail_to_pass) and all(
        s == "PASSED" for s in fail_to_pass_status.values()
    )
    all_p2p_pass = (not pass_to_pass) or all(
        s == "PASSED" for s in pass_to_pass_status.values()
    )
    report["resolved"] = all_f2p_pass and all_p2p_pass
    if not report["resolved"]:
        # Human-friendly failure reason
        reasons = []
        for n, s in fail_to_pass_status.items():
            if s != "PASSED":
                reasons.append(f"fail_to_pass {n}={s}")
        for n, s in pass_to_pass_status.items():
            if s != "PASSED":
                reasons.append(f"pass_to_pass {n}={s}")
        report["failure_reason"] = "; ".join(reasons) or "no tests found in output"

    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def aggregate_reports(run_id: str, report_dir: Path, instance_ids: list[str]) -> dict:
    """Walk per-instance report.json files and produce a summary."""
    per_instance: dict[str, dict] = {}
    for iid in instance_ids:
        rp = report_dir / iid / "report.json"
        if not rp.exists():
            per_instance[iid] = {"resolved": False, "missing": True}
            continue
        try:
            data = json.loads(rp.read_text(encoding="utf-8"))
        except Exception:
            per_instance[iid] = {"resolved": False, "error": "could not parse report.json"}
            continue
        per_instance[iid] = data

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
    p.add_argument("--run-id",
                   default=f"seekharness_pro_{datetime.now().strftime('%Y%m%d_%H%M%S')}",
                   help="Identifier for this eval run (used as report subdir)")
    p.add_argument("--predictions", type=Path, default=DEFAULT_PREDICTIONS_DIR,
                   help=f"Dir with <id>.diff files (default: {DEFAULT_PREDICTIONS_DIR})")
    p.add_argument("--dataset", type=Path, default=DEFAULT_DATASET_FILE,
                   help=f"Path to <prefix>-instances.json (default: {DEFAULT_DATASET_FILE})")
    p.add_argument("--pro-eval-root", type=Path, default=DEFAULT_PRO_EVAL_ROOT,
                   help="Path to a clone of scaleapi/SWE-bench_Pro-os (must contain run_scripts/)")
    p.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_DIR,
                   help=f"Where to write the report (default: {DEFAULT_REPORT_DIR})")
    p.add_argument("--workspace-root", type=Path, default=DEFAULT_WORKSPACE_ROOT,
                   help=f"Where eval runner dropped the clones (default: {DEFAULT_WORKSPACE_ROOT})")
    p.add_argument("--timeout", type=int, default=600,
                   help="Per-instance test timeout in seconds (default: 600)")
    p.add_argument("--instance-id", action="append", default=None,
                   help="Only score these instance_ids (repeatable). Default: all predictions.")
    args = p.parse_args()

    if not args.pro_eval_root.exists():
        sys.exit(
            f"--pro-eval-root {args.pro_eval_root} does not exist.\n"
            "Clone the SWE-bench_Pro-os repo and pass the path:\n"
            "  git clone --depth 1 https://github.com/scaleapi/SWE-bench_Pro-os <path>"
        )
    if not (args.pro_eval_root / "run_scripts").exists():
        sys.exit(
            f"--pro-eval-root {args.pro_eval_root} has no run_scripts/ subdir — "
            "is this really a SWE-bench_Pro-os clone?"
        )

    args.report_dir.mkdir(parents=True, exist_ok=True)

    # Always materialize a predictions.json snapshot, even if we only score
    # a subset. Helps debugging.
    preds = collect_predictions(args.predictions)
    if args.instance_id:
        wanted = set(args.instance_id)
        preds = [p for p in preds if p["instance_id"] in wanted]
        print(f"Filtered to {len(preds)} instance(s) via --instance-id", file=sys.stderr)
    if not preds:
        sys.exit("No predictions left after filtering.")

    run_report_dir = args.report_dir / args.run_id
    run_report_dir.mkdir(parents=True, exist_ok=True)
    write_predictions_file(preds, run_report_dir / "predictions.json")

    # Load the instance dicts so we have fail_to_pass / before_repo_set_cmd / etc.
    instances_by_id: dict[str, dict] = {}
    if args.dataset.exists():
        for inst in json.loads(args.dataset.read_text(encoding="utf-8")):
            instances_by_id[inst["instance_id"]] = inst
    else:
        sys.exit(f"--dataset {args.dataset} does not exist. Run `build-mini-set.py` first.")

    # Score each prediction sequentially. SWE-Pro's run_script is fast for Go
    # (1-5 min incl. go mod download), and parallel test runs on the same
    # box fight for CPU — sequential is fine for a 2-5 task mini subset.
    print(f"\nScoring {len(preds)} instance(s) — run_id={args.run_id}\n", file=sys.stderr)
    for p in preds:
        iid = p["instance_id"]
        inst = instances_by_id.get(iid)
        if not inst:
            print(f"  [skip] {iid}: not in {args.dataset}", file=sys.stderr)
            continue
        print(f"  [run]  {iid}  ({len(p['model_patch'])}B patch)", file=sys.stderr)
        report = score_one(
            instance=inst,
            model_patch=p["model_patch"],
            pro_eval_root=args.pro_eval_root,
            report_dir=run_report_dir,
            workspace_root=args.workspace_root,
            timeout=args.timeout,
        )
        verdict = "PASS" if report["resolved"] else "FAIL"
        reason = report.get("failure_reason") or report.get("error") or ""
        print(f"         → {verdict}  {reason[:200]}", file=sys.stderr)

    summary = aggregate_reports(args.run_id, run_report_dir, [p["instance_id"] for p in preds])
    summary_file = run_report_dir / "summary.json"
    summary_file.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n=== seekHarness Pro eval result ({args.run_id}) ===", file=sys.stderr)
    print(f"  resolved: {summary['resolved']}/{summary['total']}", file=sys.stderr)
    print(f"  mean_acc: {summary['mean_acc']:.3f}", file=sys.stderr)
    print(f"  summary:  {summary_file}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
