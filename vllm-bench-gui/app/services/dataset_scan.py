"""Dataset list: schema built-ins plus files scanned from the dataset dir."""
from __future__ import annotations

from pathlib import Path

from app.services import dataset_schema

SCAN_SUFFIXES = {".json", ".jsonl"}


def scan_datasets(dataset_dir: str) -> list[dict]:
    items = [dict(spec) for spec in dataset_schema.DATASETS.values()]
    root = Path(dataset_dir).expanduser()
    if root.is_dir():
        for f in sorted(root.iterdir()):
            if f.is_file() and f.suffix.lower() in SCAN_SUFFIXES:
                items.append({"id": f"file:{f.name}", "kind": "file",
                              "network": "offline", "path": str(f),
                              "note": "local file",
                              "fields": dataset_schema.FILE_FIELDS})
    return items


def resolve_dataset_file(dataset_dir: str, dataset_id: str) -> Path | None:
    """Map a 'file:<name>' dataset id back to a real path inside dataset_dir."""
    if not dataset_id.startswith("file:"):
        return None
    name = dataset_id[len("file:"):]
    root = Path(dataset_dir).expanduser().resolve()
    candidate = (root / name).resolve()
    # Path-traversal guard: the file must stay inside the dataset dir.
    if candidate.parent != root or not candidate.is_file():
        return None
    return candidate
