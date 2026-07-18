"""Local model list for the model dropdown."""
from __future__ import annotations

from fastapi import APIRouter

from app import config
from app.services.model_scan import scan_models

router = APIRouter(prefix="/api/models", tags=["models"])


@router.get("")
def list_models() -> list[dict]:
    settings = config.get_settings()
    return scan_models(settings["model_dir"])
