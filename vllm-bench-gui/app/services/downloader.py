"""Model download via `hf download` subprocess.

Always runs locally (compute nodes have no internet in SLURM mode). `hf`
resumes partial downloads, so a cancelled download is never wasted work.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from app import config


def download_cmd(repo_id: str) -> list[str]:
    # Prefer the new `hf` CLI; fall back to `huggingface-cli download`.
    if shutil.which("hf"):
        return ["hf", "download", repo_id]
    return ["huggingface-cli", "download", repo_id]


def start_download(repo_id: str, settings: dict, log_path: Path) -> subprocess.Popen:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log = open(log_path, "ab")
    return subprocess.Popen(
        download_cmd(repo_id),
        stdout=log,
        stderr=subprocess.STDOUT,
        env=config.hf_env(settings),
        start_new_session=True,
    )
