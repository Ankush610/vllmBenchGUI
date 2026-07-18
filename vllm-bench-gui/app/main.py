"""FastAPI app entry: routers, static frontend, startup reconciliation."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app import config, db
from app.api import dashboard, datasets_api, models_api, runs
from app.api import settings as settings_api
from app.queue_worker import startup_reconciliation, worker

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(name)s %(levelname)s %(message)s")

STATIC_DIR = config.APP_ROOT / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    startup_reconciliation()
    worker.start()
    yield
    await worker.stop()


app = FastAPI(title="vllm-bench GUI", lifespan=lifespan)

app.include_router(runs.router)
app.include_router(settings_api.router)
app.include_router(models_api.router)
app.include_router(datasets_api.router)
app.include_router(dashboard.router)


@app.get("/api/status")
def global_status() -> dict:
    """Worker state, active vLLM server, GPU snapshot — polled every 3 s."""
    settings = config.get_settings()
    status = worker.status()
    status["execution_mode"] = settings["execution_mode"]
    active = None
    if status["active_run_id"]:
        active = db.get_run(status["active_run_id"])
    status["active_run"] = active and {
        "id": active["id"], "name": active["name"],
        "status": active["status"], "status_detail": active["status_detail"],
        "slurm_job_id": active.get("slurm_job_id"),
    }
    return status


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/", StaticFiles(directory=STATIC_DIR), name="static")
