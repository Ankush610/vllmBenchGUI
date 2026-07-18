"""Dataset list for the dataset dropdown: built-ins + scanned files."""
from __future__ import annotations

from fastapi import APIRouter

from app import config
from app.services.dataset_scan import scan_datasets

router = APIRouter(prefix="/api/datasets", tags=["datasets"])


@router.get("")
def list_datasets() -> list[dict]:
    settings = config.get_settings()
    return scan_datasets(settings["dataset_dir"])
