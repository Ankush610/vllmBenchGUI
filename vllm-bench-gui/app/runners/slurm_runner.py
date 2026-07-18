"""SLURM execution: one self-contained sbatch job per run.

The generated script runs entirely on the compute node: start vLLM in the
background, health-check it over localhost, run vllm-bench, kill the server.
A single job avoids cross-node server discovery; logs land on the shared
filesystem so the normal log-tail endpoint works unchanged.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

from app import config
from app.runners import base

SBATCH_TEMPLATE = """#!/bin/bash
{headers}

set -u
PORT={port}
LOGDIR={log_dir}

echo "=== VLLM SERVER ==="
{serve_cmd} >> "$LOGDIR/server.log" 2>&1 &
SERVER_PID=$!

echo "waiting for vLLM /health on port $PORT (timeout {health_timeout}s)"
ELAPSED=0
until curl -sf "http://127.0.0.1:$PORT/health" > /dev/null; do
  if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "vLLM server died during startup" >&2
    exit 1
  fi
  if [ $ELAPSED -ge {health_timeout} ]; then
    echo "health check timed out after {health_timeout}s" >&2
    kill $SERVER_PID 2>/dev/null
    exit 1
  fi
  sleep 5
  ELAPSED=$((ELAPSED + 5))
done
echo "server healthy after ${{ELAPSED}}s"

echo "=== BENCHMARK ==="
{bench_cmd} >> "$LOGDIR/bench.log" 2>&1
RC=$?

echo "stopping server"
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
exit $RC
"""

# squeue/sacct state → (run status, detail)
STATE_MAP = {
    "PENDING": ("starting_server", "waiting in SLURM queue"),
    "CONFIGURING": ("starting_server", "waiting in SLURM queue"),
    "RUNNING": ("running_benchmark", None),
    "COMPLETING": ("running_benchmark", None),
    "COMPLETED": ("completed", None),
    "FAILED": ("failed", "SLURM job failed"),
    "TIMEOUT": ("failed", "SLURM job hit time limit"),
    "OUT_OF_MEMORY": ("failed", "SLURM job out of memory"),
    "NODE_FAIL": ("failed", "SLURM node failure"),
    "CANCELLED": ("cancelled", None),
}


def build_sbatch(run: dict, settings: dict) -> Path:
    log_dir = config.run_log_dir(run["id"])
    log_dir.mkdir(parents=True, exist_ok=True)

    headers = [
        f"#SBATCH --job-name=vbench-{run['id'][:8]}",
        f"#SBATCH --output={log_dir}/slurm-%j.out",
        f"#SBATCH --gres=gpu:{settings['slurm_gpus_per_job']}",
        f"#SBATCH --time={settings['slurm_time_limit']}",
    ]
    if settings.get("slurm_partition"):
        headers.append(f"#SBATCH --partition={settings['slurm_partition']}")
    if settings.get("slurm_account"):
        headers.append(f"#SBATCH --account={settings['slurm_account']}")
    for flag in (settings.get("slurm_extra_flags") or "").split():
        headers.append(f"#SBATCH {flag}")

    port = run["config"]["server"].get("port") or int(
        settings["port_range_start"])
    serve_cmd = base.shell_join(base.serve_args(run["config"]["server"], port))
    bench_cmd = base.shell_join(base.bench_args(run, settings, port))

    script = SBATCH_TEMPLATE.format(
        headers="\n".join(headers),
        port=port,
        log_dir=str(log_dir),
        health_timeout=int(settings.get("health_check_timeout", 600)),
        serve_cmd=serve_cmd,
        bench_cmd=bench_cmd,
    )
    path = config.SLURM_DIR / f"{run['id']}.sbatch"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(script)
    return path


def submit(run: dict, settings: dict) -> str:
    """sbatch the generated script; return the SLURM job id."""
    script = build_sbatch(run, settings)
    out = subprocess.run(["sbatch", str(script)], capture_output=True,
                         text=True, timeout=30, env=None)
    if out.returncode != 0:
        raise RuntimeError(f"sbatch failed: {out.stderr.strip() or out.stdout.strip()}")
    m = re.search(r"Submitted batch job (\d+)", out.stdout)
    if not m:
        raise RuntimeError(f"could not parse sbatch output: {out.stdout.strip()}")
    return m.group(1)


def job_state(job_id: str) -> str | None:
    """Current SLURM state, or None if the job is unknown to both tools."""
    try:
        out = subprocess.run(["squeue", "-h", "-j", job_id, "-o", "%T"],
                             capture_output=True, text=True, timeout=15)
        state = out.stdout.strip().splitlines()[0].strip() if out.stdout.strip() else ""
        if state:
            return state
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None
    try:
        out = subprocess.run(
            ["sacct", "-j", job_id, "--format=State", "-n", "-X"],
            capture_output=True, text=True, timeout=15)
        state = out.stdout.strip().splitlines()[0].strip() if out.stdout.strip() else ""
        # sacct reports e.g. "CANCELLED by 1234"
        return state.split()[0] if state else None
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None


def map_state(state: str | None) -> tuple[str, str | None]:
    if state is None:
        return ("failed", "SLURM job vanished (not in squeue/sacct)")
    base_state = state.split("+")[0]
    return STATE_MAP.get(base_state, ("running_benchmark", f"SLURM state {state}"))


def cancel(job_id: str) -> None:
    subprocess.run(["scancel", job_id], capture_output=True, timeout=15)
