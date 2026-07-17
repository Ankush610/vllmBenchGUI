"""SQLite access layer.

One short-lived connection per call keeps things simple and safe across the
asyncio worker + request handlers (all in one process). WAL mode avoids
writer/reader blocking for our tiny load.
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator

from app import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  name          TEXT,
  label         TEXT,
  status        TEXT NOT NULL,
  status_detail TEXT,
  config_json   TEXT NOT NULL,
  runner        TEXT NOT NULL,
  slurm_job_id  TEXT,
  port          INTEGER,
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT
);

CREATE TABLE IF NOT EXISTS results (
  run_id            TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  model             TEXT NOT NULL,
  dataset           TEXT NOT NULL,
  backend           TEXT NOT NULL,
  max_concurrency   INTEGER,
  request_rate      TEXT,
  num_prompts       INTEGER,
  input_len         INTEGER,
  output_len        INTEGER,
  req_per_sec       REAL,
  output_tok_per_sec REAL,
  total_tok_per_sec REAL,
  ttft_p50_ms       REAL, ttft_p99_ms REAL,
  tpot_p50_ms       REAL, tpot_p99_ms REAL,
  e2el_p50_ms       REAL, e2el_p99_ms REAL,
  result_path       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
"""

ACTIVE_STATUSES = ("downloading", "starting_server", "running_benchmark")


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(config.DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init() -> None:
    config.ensure_dirs()
    with connect() as conn:
        conn.executescript(SCHEMA)


# ---------------------------------------------------------------- settings

def get_all_settings() -> dict[str, str]:
    with connect() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
    return {r["key"]: r["value"] for r in rows}


def set_setting(key: str, value: str) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


# -------------------------------------------------------------------- runs

def insert_run(run_id: str, name: str, label: str, config_json: dict,
               runner: str) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO runs(id, name, label, status, config_json, runner, created_at) "
            "VALUES(?, ?, ?, 'queued', ?, ?, ?)",
            (run_id, name, label, json.dumps(config_json), runner, utcnow()),
        )


def get_run(run_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
    return _run_row(row) if row else None


def list_runs() -> list[dict]:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM runs ORDER BY created_at ASC").fetchall()
    return [_run_row(r) for r in rows]


def _run_row(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["config"] = json.loads(d.pop("config_json"))
    return d


def next_queued_run() -> dict | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM runs WHERE status='queued' ORDER BY created_at ASC LIMIT 1"
        ).fetchone()
    return _run_row(row) if row else None


def update_run(run_id: str, **fields: Any) -> None:
    if not fields:
        return
    cols = ", ".join(f"{k}=?" for k in fields)
    with connect() as conn:
        conn.execute(f"UPDATE runs SET {cols} WHERE id=?",
                     (*fields.values(), run_id))


def set_status(run_id: str, status: str, detail: str | None = None) -> None:
    fields: dict[str, Any] = {"status": status, "status_detail": detail}
    if status in ("downloading", "starting_server") :
        run = get_run(run_id)
        if run and not run.get("started_at"):
            fields["started_at"] = utcnow()
    if status in ("completed", "failed", "cancelled"):
        fields["finished_at"] = utcnow()
    update_run(run_id, **fields)


def cancel_queued_runs() -> list[str]:
    with connect() as conn:
        rows = conn.execute("SELECT id FROM runs WHERE status='queued'").fetchall()
        ids = [r["id"] for r in rows]
        conn.execute(
            "UPDATE runs SET status='cancelled', finished_at=? WHERE status='queued'",
            (utcnow(),),
        )
    return ids


def delete_run(run_id: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM runs WHERE id=?", (run_id,))


def active_runs() -> list[dict]:
    qmarks = ",".join("?" * len(ACTIVE_STATUSES))
    with connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM runs WHERE status IN ({qmarks})", ACTIVE_STATUSES
        ).fetchall()
    return [_run_row(r) for r in rows]


# ----------------------------------------------------------------- results

RESULT_COLS = (
    "run_id", "model", "dataset", "backend", "max_concurrency", "request_rate",
    "num_prompts", "input_len", "output_len", "req_per_sec",
    "output_tok_per_sec", "total_tok_per_sec", "ttft_p50_ms", "ttft_p99_ms",
    "tpot_p50_ms", "tpot_p99_ms", "e2el_p50_ms", "e2el_p99_ms", "result_path",
)


def insert_result(values: dict) -> None:
    cols = ", ".join(RESULT_COLS)
    qmarks = ", ".join("?" * len(RESULT_COLS))
    with connect() as conn:
        conn.execute(
            f"INSERT OR REPLACE INTO results({cols}) VALUES({qmarks})",
            tuple(values.get(c) for c in RESULT_COLS),
        )


def list_results() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT res.*, r.name, r.label, r.finished_at "
            "FROM results res JOIN runs r ON r.id = res.run_id "
            "ORDER BY r.finished_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_results_by_ids(ids: list[str]) -> list[dict]:
    if not ids:
        return []
    qmarks = ",".join("?" * len(ids))
    with connect() as conn:
        rows = conn.execute(
            f"SELECT res.*, r.name, r.label, r.finished_at "
            f"FROM results res JOIN runs r ON r.id = res.run_id "
            f"WHERE res.run_id IN ({qmarks}) ORDER BY r.finished_at DESC",
            ids,
        ).fetchall()
    return [dict(r) for r in rows]
