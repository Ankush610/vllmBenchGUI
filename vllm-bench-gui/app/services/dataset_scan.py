"""Dataset list: built-ins plus files scanned from the dataset directory."""
from __future__ import annotations

from pathlib import Path

BUILTINS = [
    {"id": "random", "kind": "builtin",
     "note": "synthetic exact-length prompts"},
    {"id": "sharegpt", "kind": "builtin",
     "note": "real conversations (auto-download)"},
    {"id": "sonnet", "kind": "builtin",
     "note": "built-in, prefix-cache friendly"},
]

SCAN_SUFFIXES = {".json", ".jsonl"}


def scan_datasets(dataset_dir: str) -> list[dict]:
    items = list(BUILTINS)
    root = Path(dataset_dir).expanduser()
    if root.is_dir():
        for f in sorted(root.iterdir()):
            if f.is_file() and f.suffix.lower() in SCAN_SUFFIXES:
                items.append({"id": f"file:{f.name}", "kind": "file",
                              "path": str(f), "note": "local file"})
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
