"""Single asyncio queue worker: dequeue → lifecycle state machine.

Strictly serial: one run at a time. Blocking work (subprocess waits, health
polling) runs in threads via asyncio.to_thread so the event loop keeps
serving API requests.

Lifecycle per run (plan §7.1):
  queued → [preflight] → downloading? → starting_server → running_benchmark
         → parse → completed | failed | cancelled

Server reuse (local mode): after a run, the vLLM server is kept alive when
the next queued run has an identical server tuple; benchmark-only changes
never restart the server.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from app import config, db
from app.runners import slurm_runner
from app.runners.local_runner import LocalRunner, RunCancelled
from app.services import model_scan, preflight, results

log = logging.getLogger("queue_worker")

SLURM_POLL_S = 3


class QueueWorker:
    def __init__(self) -> None:
        self.local = LocalRunner()
        self.current_run_id: str | None = None
        self.current_slurm_job: str | None = None
        self._task: asyncio.Task | None = None
        self._stopping = False

    # ------------------------------------------------------------ control

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self._stopping = True
        if self._task:
            self._task.cancel()
        await asyncio.to_thread(self.local.stop_server)

    def cancel_run(self, run_id: str) -> bool:
        """Cancel a queued or active run. Returns True if something changed."""
        run = db.get_run(run_id)
        if not run:
            return False
        if run["status"] == "queued":
            db.set_status(run_id, "cancelled")
            return True
        if run_id != self.current_run_id:
            return False
        if run["runner"] == "slurm" and run.get("slurm_job_id"):
            slurm_runner.cancel(run["slurm_job_id"])
        self.local.cancel()  # kills active phase process + server if any
        return True

    def cancel_all(self) -> list[str]:
        cancelled = db.cancel_queued_runs()
        if self.current_run_id:
            if self.cancel_run(self.current_run_id):
                cancelled.append(self.current_run_id)
        return cancelled

    # ------------------------------------------------------------- status

    def status(self) -> dict:
        server = self.local.server
        return {
            "active_run_id": self.current_run_id,
            "server": None if server is None or not server.alive() else {
                "model": server.model, "port": server.port,
            },
            "gpus": preflight.gpu_info(),
        }

    # --------------------------------------------------------------- loop

    async def _loop(self) -> None:
        # Re-adopt SLURM jobs that survived a backend restart before
        # touching the regular queue.
        for run in db.active_runs():
            if run["runner"] == "slurm" and run.get("slurm_job_id"):
                await self._adopt_slurm(run)
        while not self._stopping:
            try:
                run = db.next_queued_run()
                if run is None:
                    # Queue drained → no reuse candidate → teardown.
                    if self.local.server is not None:
                        await asyncio.to_thread(self.local.stop_server)
                    await asyncio.sleep(1)
                    continue
                await self._execute(run)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("worker loop error")
                await asyncio.sleep(3)

    async def _execute(self, run: dict) -> None:
        self.current_run_id = run["id"]
        self.local.reset_cancel()
        settings = config.get_settings()
        try:
            if run["runner"] == "slurm":
                await self._execute_slurm(run, settings)
            else:
                await self._execute_local(run, settings)
        except RunCancelled:
            db.set_status(run["id"], "cancelled")
        except preflight.PreflightError as e:
            db.set_status(run["id"], "failed", f"preflight: {e}")
        except Exception as e:
            log.exception("run %s failed", run["id"])
            if self.local.cancelled:
                db.set_status(run["id"], "cancelled")
            else:
                db.set_status(run["id"], "failed", str(e))
        finally:
            self.current_run_id = None
            self.current_slurm_job = None

    def _check_cancel(self) -> None:
        if self.local.cancelled:
            raise RunCancelled()

    # --------------------------------------------------------- local mode

    async def _execute_local(self, run: dict, settings: dict) -> None:
        server_cfg = run["config"]["server"]

        # 2. Preflight
        preflight.check_binary()
        reuse = self._can_reuse(server_cfg)
        preflight.check_gpu_free(server_cfg["tensor_parallel_size"],
                                 server_is_ours=self.local.server is not None)

        # 3. Model check → download if missing (always local)
        if not model_scan.is_model_local(settings["model_dir"], server_cfg["model"]):
            preflight.check_disk_for_download(settings["model_dir"])
            db.set_status(run["id"], "downloading")
            rc = await asyncio.to_thread(self.local.run_download, run, settings)
            self._check_cancel()
            if rc != 0:
                raise RuntimeError(
                    f"model download exited with code {rc} (see download.log)")

        # 4–5. Serve + health check (skipped entirely on server reuse).
        # Re-check right before use: the server may have died since the
        # preflight decision (e.g. while a download ran).
        reuse = reuse and self._can_reuse(server_cfg)
        if reuse:
            db.set_status(run["id"], "starting_server", "reusing running server")
            port = self.local.server.port
        else:
            await asyncio.to_thread(self.local.stop_server)
            port = self.local.find_free_port(int(settings["port_range_start"]))
            db.update_run(run["id"], port=port)
            db.set_status(run["id"], "starting_server")
            handle = self.local.start_server(run, settings, port)
            timeout = int(settings.get("health_check_timeout", 600))
            await asyncio.to_thread(self.local.wait_healthy, handle, timeout)
        db.update_run(run["id"], port=port)
        self._check_cancel()

        # 6. Benchmark
        db.set_status(run["id"], "running_benchmark")
        rc = await asyncio.to_thread(self.local.run_bench, run, settings, port)
        self._check_cancel()
        if rc != 0:
            raise RuntimeError(f"vllm-bench exited with code {rc} (see bench.log)")

        # 7. Parse
        self._parse_and_store(run, settings)

        # 8. Teardown / reuse decision
        if not self._next_wants_this_server():
            await asyncio.to_thread(self.local.stop_server)

        # 9. Complete
        db.set_status(run["id"], "completed")

    def _can_reuse(self, server_cfg: dict) -> bool:
        s = self.local.server
        return (s is not None and s.alive()
                and s.reuse_key == LocalRunner._reuse_key(server_cfg))

    def _next_wants_this_server(self) -> bool:
        nxt = db.next_queued_run()
        return (nxt is not None and nxt["runner"] == "local"
                and self._can_reuse(nxt["config"]["server"]))

    # --------------------------------------------------------- slurm mode

    async def _execute_slurm(self, run: dict, settings: dict) -> None:
        server_cfg = run["config"]["server"]

        preflight.check_binary()

        # Download still happens locally — compute nodes have no internet.
        if not model_scan.is_model_local(settings["model_dir"], server_cfg["model"]):
            preflight.check_disk_for_download(settings["model_dir"])
            db.set_status(run["id"], "downloading")
            rc = await asyncio.to_thread(self.local.run_download, run, settings)
            self._check_cancel()
            if rc != 0:
                raise RuntimeError(
                    f"model download exited with code {rc} (see download.log)")

        job_id = await asyncio.to_thread(slurm_runner.submit, run, settings)
        self.current_slurm_job = job_id
        db.update_run(run["id"], slurm_job_id=job_id)
        db.set_status(run["id"], "starting_server", "waiting in SLURM queue")

        await self._poll_slurm(run, settings, job_id)

    async def _poll_slurm(self, run: dict, settings: dict, job_id: str) -> None:
        last_status = "starting_server"
        while True:
            self._check_cancel()
            state = await asyncio.to_thread(slurm_runner.job_state, job_id)
            status, detail = slurm_runner.map_state(state)
            if status in ("completed", "failed", "cancelled"):
                break
            if status != last_status:
                db.set_status(run["id"], status, detail)
                last_status = status
            await asyncio.sleep(SLURM_POLL_S)

        if status == "completed":
            self._parse_and_store(run, settings)
            db.set_status(run["id"], "completed")
        elif status == "cancelled":
            db.set_status(run["id"], "cancelled")
        else:
            raise RuntimeError(detail or "SLURM job failed")

    async def _adopt_slurm(self, run: dict) -> None:
        """Resume polling a SLURM job that survived a backend restart."""
        self.current_run_id = run["id"]
        self.current_slurm_job = run["slurm_job_id"]
        self.local.reset_cancel()
        settings = config.get_settings()
        try:
            await self._poll_slurm(run, settings, run["slurm_job_id"])
        except RunCancelled:
            db.set_status(run["id"], "cancelled")
        except Exception as e:
            log.exception("adopted run %s failed", run["id"])
            db.set_status(run["id"], "failed", str(e))
        finally:
            self.current_run_id = None
            self.current_slurm_job = None

    # ------------------------------------------------------------ parsing

    def _parse_and_store(self, run: dict, settings: dict) -> None:
        path = Path(settings["results_dir"]).expanduser() / f"{run['id']}.json"
        row = results.parse_result_json(path, run)
        db.insert_result(row)


worker = QueueWorker()


def startup_reconciliation() -> None:
    """Mark runs orphaned by a backend restart.

    SLURM runs are re-synced from squeue/sacct first — a job that survived
    the restart stays active and the worker re-adopts its polling loop at
    startup. Everything else stuck in an active status has no live process
    and is marked failed (interrupted).
    """
    for run in db.active_runs():
        if run["runner"] == "slurm" and run.get("slurm_job_id"):
            state = slurm_runner.job_state(run["slurm_job_id"])
            status, detail = slurm_runner.map_state(state)
            if status == "completed":
                # Job finished while we were down; the worker's adoption
                # pass will parse results, so leave it active here.
                continue
            if status in ("failed", "cancelled"):
                db.set_status(run["id"], status,
                              detail or "finished while backend was down")
            # else: still pending/running → leave for worker adoption
        else:
            db.set_status(run["id"], "failed", "failed (interrupted)")
