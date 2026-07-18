"""Run queue endpoints: submit, list, cancel, delete, log tailing."""
from __future__ import annotations

import re
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from app import config, db
from app.queue_worker import worker
from app.schemas import QueueRunsRequest
from app.services import dataset_schema

router = APIRouter(prefix="/api/runs", tags=["runs"])

LOG_FILES = {"download": "download.log", "server": "server.log",
             "bench": "bench.log"}
# Which log file the UI should follow for a given status.
PHASE_FILE = {"downloading": "download", "starting_server": "server",
              "running_benchmark": "bench"}


def _short_name(model: str) -> str:
    return model.split("/")[-1]


def _dedupe_name(base: str, taken: set[str]) -> str:
    if base not in taken:
        return base
    i = 2
    while f"{base}-{i}" in taken:
        i += 1
    return f"{base}-{i}"


@router.post("")
def queue_runs(req: QueueRunsRequest) -> dict:
    settings = config.get_settings()
    runner = settings["execution_mode"]
    # Base validation ran in the model; offline-only requiredness (e.g. hf
    # subset/split) depends on settings, so it is enforced here.
    if settings.get("offline_mode") == "1":
        for rc in req.runs:
            errs = dataset_schema.validate_params(
                rc.bench.dataset, rc.bench.dataset_params, offline=True)
            if errs:
                raise HTTPException(422, detail={"dataset_params": errs})
    taken = {r["name"] for r in db.list_runs() if r.get("name")}
    ids = []
    for rc in req.runs:
        run_id = str(uuid.uuid4())
        name = _dedupe_name(rc.name.strip() or _short_name(rc.server.model),
                            taken)
        taken.add(name)
        db.insert_run(run_id, name, rc.label.strip(),
                      rc.model_dump(), runner)
        ids.append(run_id)
    return {"ids": ids}


@router.get("")
def list_runs() -> list[dict]:
    return db.list_runs()


@router.post("/cancel-all")
def cancel_all() -> dict:
    return {"cancelled": worker.cancel_all()}


@router.post("/{run_id}/cancel")
def cancel_run(run_id: str) -> dict:
    if not db.get_run(run_id):
        raise HTTPException(404, "run not found")
    changed = worker.cancel_run(run_id)
    if not changed:
        raise HTTPException(409, "run is not queued or active")
    return {"ok": True}


@router.delete("/{run_id}")
def delete_run(run_id: str) -> dict:
    run = db.get_run(run_id)
    if not run:
        raise HTTPException(404, "run not found")
    if run["status"] in db.ACTIVE_STATUSES:
        raise HTTPException(409, "cancel the run before deleting it")
    db.delete_run(run_id)  # results row goes via ON DELETE CASCADE
    settings = config.get_settings()
    result_file = Path(settings["results_dir"]).expanduser() / f"{run_id}.json"
    result_file.unlink(missing_ok=True)
    shutil.rmtree(config.run_log_dir(run_id), ignore_errors=True)
    sbatch = config.SLURM_DIR / f"{run_id}.sbatch"
    sbatch.unlink(missing_ok=True)
    return {"ok": True}


@router.get("/{run_id}/logs")
def tail_logs(run_id: str,
              file: str = Query("auto"),
              offset: int = Query(0, ge=0)) -> dict:
    """Byte-offset log tail: returns new bytes + the next offset."""
    run = db.get_run(run_id)
    if not run:
        raise HTTPException(404, "run not found")

    log_dir = config.run_log_dir(run_id)
    if file == "auto":
        file = PHASE_FILE.get(run["status"], "bench")

    if file == "slurm":
        path = _latest_slurm_log(log_dir)
    elif file in LOG_FILES:
        path = log_dir / LOG_FILES[file]
        # SLURM runs write server/bench logs too, but the job header/output
        # lives in slurm-<jobid>.out; fall back to it when phase log absent.
        if not path.is_file() and run["runner"] == "slurm":
            path = _latest_slurm_log(log_dir)
    else:
        raise HTTPException(400, f"unknown log file {file!r}")

    if path is None or not path.is_file():
        return {"file": file, "exists": False, "data": "", "offset": 0}

    size = path.stat().st_size
    if offset > size:  # log was truncated/rotated — restart from zero
        offset = 0
    with open(path, "rb") as f:
        f.seek(offset)
        chunk = f.read(256 * 1024)
    return {
        "file": file,
        "exists": True,
        "data": chunk.decode("utf-8", errors="replace"),
        "offset": offset + len(chunk),
    }


def _latest_slurm_log(log_dir: Path) -> Path | None:
    if not log_dir.is_dir():
        return None
    candidates = sorted(log_dir.glob("slurm-*.out"),
                        key=lambda p: p.stat().st_mtime)
    return candidates[-1] if candidates else None
