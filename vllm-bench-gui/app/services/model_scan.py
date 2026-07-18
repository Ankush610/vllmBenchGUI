"""Scan the HF hub cache directory for locally available models.

The hub cache layout is `<hub>/models--<org>--<name>/snapshots/<rev>/…`.
A model counts as local only if it has at least one snapshot containing
weight files (or any files at all, for robustness across formats).
"""
from __future__ import annotations

from pathlib import Path


def repo_id_from_cache_dir(dirname: str) -> str | None:
    if not dirname.startswith("models--"):
        return None
    parts = dirname[len("models--"):].split("--")
    if len(parts) < 2:
        return None
    return parts[0] + "/" + "--".join(parts[1:])


def scan_models(model_dir: str) -> list[dict]:
    root = Path(model_dir).expanduser()
    if not root.is_dir():
        return []
    models = []
    for entry in sorted(root.iterdir()):
        if not entry.is_dir():
            continue
        repo_id = repo_id_from_cache_dir(entry.name)
        if not repo_id:
            continue
        snapshots = entry / "snapshots"
        has_snapshot = snapshots.is_dir() and any(
            s.is_dir() and any(s.iterdir()) for s in snapshots.iterdir()
        )
        if has_snapshot:
            models.append({"repo_id": repo_id, "local": True})
    return models


def is_model_local(model_dir: str, repo_id: str) -> bool:
    return any(m["repo_id"].lower() == repo_id.lower()
               for m in scan_models(model_dir))
