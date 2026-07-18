"""Pre-run checks: binary present, GPU free, disk space for downloads."""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from app import config

# Rough floor for a fresh model download; real need depends on the model.
MIN_FREE_GB_FOR_DOWNLOAD = 20


class PreflightError(Exception):
    pass


def check_binary() -> None:
    if not config.BENCH_BIN.is_file():
        raise PreflightError(f"vllm-bench binary not found at {config.BENCH_BIN}")
    if not os.access(config.BENCH_BIN, os.X_OK):
        try:
            config.BENCH_BIN.chmod(config.BENCH_BIN.stat().st_mode | 0o755)
        except OSError:
            raise PreflightError(f"vllm-bench at {config.BENCH_BIN} is not executable")


def gpu_info() -> list[dict]:
    """Per-GPU memory usage from nvidia-smi; empty list if unavailable."""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,memory.used,memory.total,utilization.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []
    if out.returncode != 0:
        return []
    gpus = []
    for line in out.stdout.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 4:
            gpus.append({
                "index": int(parts[0]),
                "mem_used_mb": int(parts[1]),
                "mem_total_mb": int(parts[2]),
                "util_pct": int(parts[3]),
            })
    return gpus


def check_gpu_free(tensor_parallel_size: int, server_is_ours: bool) -> None:
    """Fail when GPUs are already busy with someone else's work.

    Skipped when the busy process is our own reused vLLM server.
    """
    gpus = gpu_info()
    if not gpus:
        raise PreflightError("nvidia-smi not available or reported no GPUs")
    if len(gpus) < tensor_parallel_size:
        raise PreflightError(
            f"tensor_parallel_size={tensor_parallel_size} but only "
            f"{len(gpus)} GPU(s) detected")
    if server_is_ours:
        return
    busy = [g for g in gpus if g["mem_used_mb"] > 0.10 * g["mem_total_mb"]]
    if len(gpus) - len(busy) < tensor_parallel_size:
        raise PreflightError(
            f"not enough free GPUs: need {tensor_parallel_size}, "
            f"{len(busy)} of {len(gpus)} look busy (>10% VRAM in use)")


def check_disk_for_download(model_dir: str) -> None:
    path = Path(model_dir).expanduser()
    path.mkdir(parents=True, exist_ok=True)
    free_gb = shutil.disk_usage(path).free / 1e9
    if free_gb < MIN_FREE_GB_FOR_DOWNLOAD:
        raise PreflightError(
            f"only {free_gb:.1f} GB free in {path}; need at least "
            f"{MIN_FREE_GB_FOR_DOWNLOAD} GB to download a model")
