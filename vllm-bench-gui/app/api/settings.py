"""Settings endpoints. The HF token is write-only: accepted on PUT, never
returned; GET only reports whether one is set."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException

from app import config
from app.schemas import SettingsIn

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("")
def get_settings() -> dict:
    return config.public_settings()


@router.put("")
def put_settings(body: SettingsIn) -> dict:
    values = {k: v for k, v in body.model_dump().items() if v is not None}

    # Booleans are stored as "1"/"0" strings (settings table is key/value text).
    if "offline_mode" in values:
        values["offline_mode"] = "1" if values["offline_mode"] else "0"

    # Validate/create directories. Dirs inside the project are auto-created;
    # outside paths must already exist.
    for key in ("model_dir", "dataset_dir", "results_dir"):
        if key not in values:
            continue
        path = Path(str(values[key])).expanduser()
        if not path.is_dir():
            try:
                inside_project = path.resolve().is_relative_to(config.APP_ROOT)
            except (OSError, ValueError):
                inside_project = False
            if inside_project or key != "model_dir":
                try:
                    path.mkdir(parents=True, exist_ok=True)
                except OSError as e:
                    raise HTTPException(400, f"{key}: cannot create {path}: {e}")
            else:
                raise HTTPException(400, f"{key}: directory does not exist: {path}")
        values[key] = str(path)

    # Empty-string token clears it; None (omitted) keeps the stored one.
    config.save_settings({k: str(v) for k, v in values.items()})
    return config.public_settings()
