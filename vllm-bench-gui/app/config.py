"""Paths and settings load/save.

Settings live in the SQLite `settings` table as key/value strings; this module
owns the defaults and (de)serialization. Paths are anchored to the app root so
the tool works no matter what cwd uvicorn was launched from.
"""
from __future__ import annotations

import os
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = APP_ROOT / "data"
LOGS_DIR = DATA_DIR / "logs"
RESULTS_DIR = DATA_DIR / "results"
SLURM_DIR = DATA_DIR / "slurm"
DATASETS_DIR = DATA_DIR / "datasets"
DB_PATH = DATA_DIR / "app.db"
BENCH_BIN = APP_ROOT / "bin" / "vllm-bench"

SETTINGS_DEFAULTS: dict[str, str] = {
    "model_dir": str(Path.home() / ".cache" / "huggingface" / "hub"),
    "dataset_dir": str(DATASETS_DIR),
    "hf_token": "",
    "results_dir": str(RESULTS_DIR),
    "port_range_start": "8000",
    "offline_mode": "0",                # "1" = compute nodes have no egress
    "execution_mode": "local",          # local | slurm
    "bind_address": "127.0.0.1",        # 127.0.0.1 | 0.0.0.0
    "health_check_timeout": "600",      # seconds to wait for vLLM /health
    # SLURM-only settings
    "slurm_partition": "",
    "slurm_gpus_per_job": "1",
    "slurm_time_limit": "02:00:00",
    "slurm_account": "",
    "slurm_extra_flags": "",
}

# Keys whose values are never echoed back to the client verbatim.
SECRET_KEYS = {"hf_token"}


def ensure_dirs() -> None:
    for d in (DATA_DIR, LOGS_DIR, RESULTS_DIR, SLURM_DIR, DATASETS_DIR):
        d.mkdir(parents=True, exist_ok=True)


def get_settings() -> dict[str, str]:
    """Return effective settings: DB values over defaults."""
    from app import db
    stored = db.get_all_settings()
    merged = dict(SETTINGS_DEFAULTS)
    merged.update({k: v for k, v in stored.items() if k in SETTINGS_DEFAULTS})
    return merged


def save_settings(values: dict[str, str]) -> None:
    from app import db
    for key, value in values.items():
        if key not in SETTINGS_DEFAULTS:
            continue
        db.set_setting(key, value)


def public_settings() -> dict:
    """Settings safe to send to the frontend (token masked to a boolean)."""
    s = get_settings()
    out: dict = {k: v for k, v in s.items() if k not in SECRET_KEYS}
    out["hf_token_set"] = bool(s.get("hf_token"))
    return out


def run_log_dir(run_id: str) -> Path:
    return LOGS_DIR / run_id


def hf_env(settings: dict[str, str]) -> dict[str, str]:
    """Environment for subprocesses that talk to Hugging Face."""
    env = dict(os.environ)
    # model_dir is the hub cache dir (…/hub); HF_HOME is its parent.
    model_dir = Path(settings["model_dir"]).expanduser()
    env["HF_HUB_CACHE"] = str(model_dir)
    # `hf` suppresses its tqdm bars when stdout is not a terminal — and we always
    # capture to a log file — so without this the download phase logs nothing but
    # the final path. "0" forces the bars on so the UI can tail real progress.
    env.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "0")
    if settings.get("hf_token"):
        env["HF_TOKEN"] = settings["hf_token"]
        env["HUGGING_FACE_HUB_TOKEN"] = settings["hf_token"]
    return env
