"""Local execution: subprocess process groups, port allocation, server reuse.

Every spawned process gets its own process group (start_new_session=True) so
cancel can SIGTERM/SIGKILL the whole tree — vLLM forks workers that a plain
proc.kill() would orphan.
"""
from __future__ import annotations

import os
import signal
import socket
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import httpx

from app import config
from app.runners import base

TERM_GRACE_S = 10


@dataclass
class ServerHandle:
    proc: subprocess.Popen
    port: int
    model: str
    reuse_key: tuple

    def alive(self) -> bool:
        return self.proc.poll() is None


@dataclass
class LocalRunner:
    # Process of the currently running phase (download/server-start/bench);
    # cancel() targets this. The long-lived server is tracked separately.
    current_proc: Optional[subprocess.Popen] = None
    server: Optional[ServerHandle] = None
    cancelled: bool = field(default=False)

    # ------------------------------------------------------------- ports

    @staticmethod
    def find_free_port(start: int) -> int:
        for port in range(start, start + 200):
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                try:
                    s.bind(("127.0.0.1", port))
                    return port
                except OSError:
                    continue
        raise RuntimeError(f"no free port in range {start}-{start + 199}")

    # ------------------------------------------------------------ phases

    def _spawn(self, args: list[str], log_path: Path,
               env: Optional[dict] = None) -> subprocess.Popen:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log = open(log_path, "ab")
        log.write(f"\n$ {base.shell_join(args)}\n".encode())
        log.flush()
        return subprocess.Popen(
            args, stdout=log, stderr=subprocess.STDOUT,
            env=env, start_new_session=True,
        )

    def start_server(self, run: dict, settings: dict, port: int) -> ServerHandle:
        server_cfg = run["config"]["server"]
        args = base.serve_args(server_cfg, port)
        log_path = config.run_log_dir(run["id"]) / "server.log"
        proc = self._spawn(args, log_path, env=config.hf_env(settings))
        handle = ServerHandle(
            proc=proc, port=port, model=server_cfg["model"],
            reuse_key=self._reuse_key(server_cfg),
        )
        self.server = handle
        self.current_proc = proc
        return handle

    @staticmethod
    def _reuse_key(server_cfg: dict) -> tuple:
        return (server_cfg["model"], server_cfg["tensor_parallel_size"],
                server_cfg["gpu_memory_utilization"],
                server_cfg.get("max_model_len"),
                (server_cfg.get("extra_server_args") or "").strip())

    def wait_healthy(self, handle: ServerHandle, timeout_s: int) -> None:
        """Poll /health until ready; raise on timeout or server death."""
        deadline = time.monotonic() + timeout_s
        url = f"http://127.0.0.1:{handle.port}/health"
        while time.monotonic() < deadline:
            if self.cancelled:
                raise RunCancelled()
            if not handle.alive():
                raise RuntimeError(
                    f"vLLM server exited with code {handle.proc.returncode} "
                    "during startup (see server.log)")
            try:
                r = httpx.get(url, timeout=3)
                if r.status_code == 200:
                    self.current_proc = None  # server is now long-lived
                    return
            except httpx.HTTPError:
                pass
            time.sleep(2)
        raise RuntimeError(f"health check timed out after {timeout_s}s")

    def run_bench(self, run: dict, settings: dict, port: int) -> int:
        args = base.bench_args(run, settings, port)
        log_path = config.run_log_dir(run["id"]) / "bench.log"
        proc = self._spawn(args, log_path)
        self.current_proc = proc
        rc = proc.wait()
        self.current_proc = None
        return rc

    def run_download(self, run: dict, settings: dict) -> int:
        from app.services import downloader
        log_path = config.run_log_dir(run["id"]) / "download.log"
        proc = downloader.start_download(
            run["config"]["server"]["model"], settings, log_path)
        self.current_proc = proc
        rc = proc.wait()
        self.current_proc = None
        return rc

    # ---------------------------------------------------------- teardown

    @staticmethod
    def _kill_group(proc: subprocess.Popen) -> None:
        """SIGTERM the process group, wait, escalate to SIGKILL."""
        if proc.poll() is not None:
            return
        try:
            pgid = os.getpgid(proc.pid)
        except ProcessLookupError:
            return
        try:
            os.killpg(pgid, signal.SIGTERM)
        except ProcessLookupError:
            return
        deadline = time.monotonic() + TERM_GRACE_S
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                return
            time.sleep(0.25)
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()

    def stop_server(self) -> None:
        if self.server is not None:
            self._kill_group(self.server.proc)
            self.server = None

    def cancel(self) -> None:
        """Kill the active phase and the server; called from API thread."""
        self.cancelled = True
        proc = self.current_proc
        if proc is not None:
            self._kill_group(proc)
        self.stop_server()

    def reset_cancel(self) -> None:
        self.cancelled = False


class RunCancelled(Exception):
    pass
