"""Seed the dashboard with realistic demo runs (dev/UI-testing only).

Inserts completed runs + parsed results for two models across a concurrency
sweep, shaped like real serving curves: throughput saturates while p99 TTFT
explodes past the knee. Also writes a minimal raw result JSON per run so
delete / export behave exactly like real runs.

Usage (from vllm-bench-gui/):
    python scripts/seed_demo.py           # insert demo rows (idempotent)
    python scripts/seed_demo.py --remove  # delete all demo rows + JSONs

Demo rows are identifiable by run id prefix "demo-" and label "demo sweep".
"""
from __future__ import annotations

import json
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, db  # noqa: E402

MODELS = [
    # (repo id, peak output tok/s, per-token pace ms)
    ("Qwen/Qwen2.5-7B-Instruct", 2450.0, 11.5),
    ("meta-llama/Llama-3.1-8B-Instruct", 2080.0, 13.0),
]
CONCURRENCIES = [8, 32, 64, 128, 200]
INPUT_LEN, OUTPUT_LEN, NUM_PROMPTS = 1024, 128, 1000
KNEE = 110  # concurrency where the server saturates and tails blow up


def curve(peak: float, pace_ms: float, c: int, rng: random.Random) -> dict:
    """Synthesize one result row's metrics for concurrency `c`."""
    jitter = lambda v, pct=0.04: v * rng.uniform(1 - pct, 1 + pct)  # noqa: E731

    # throughput saturates smoothly toward `peak`
    out_tps = jitter(peak * c / (c + 45))
    req_ps = out_tps / OUTPUT_LEN
    total_tps = req_ps * (INPUT_LEN + OUTPUT_LEN)

    # latency: linear-ish until the knee, then the tail explodes
    over = max(0, c - KNEE)
    ttft_p50 = jitter(28 + 0.9 * c + 0.02 * over * over)
    ttft_p99 = jitter(55 + 2.6 * c + 0.45 * over * over)
    tpot_p50 = jitter(pace_ms + 0.045 * c)
    tpot_p99 = jitter(pace_ms * 1.6 + 0.16 * c + 0.01 * over * over)
    e2el_p50 = ttft_p50 + OUTPUT_LEN * tpot_p50
    e2el_p99 = ttft_p99 + OUTPUT_LEN * tpot_p99

    return {
        "req_per_sec": round(req_ps, 2),
        "output_tok_per_sec": round(out_tps, 1),
        "total_tok_per_sec": round(total_tps, 1),
        "ttft_p50_ms": round(ttft_p50, 1),
        "ttft_p99_ms": round(ttft_p99, 1),
        "tpot_p50_ms": round(tpot_p50, 2),
        "tpot_p99_ms": round(tpot_p99, 2),
        "e2el_p50_ms": round(e2el_p50, 1),
        "e2el_p99_ms": round(e2el_p99, 1),
    }


def insert() -> None:
    rng = random.Random(42)  # reproducible demo data
    results_dir = Path(config.get_settings()["results_dir"])
    results_dir.mkdir(parents=True, exist_ok=True)

    now = datetime.now(timezone.utc)
    n = 0
    for mi, (model, peak, pace) in enumerate(MODELS):
        short = model.split("/")[-1].lower()
        for ci, c in enumerate(CONCURRENCIES):
            run_id = f"demo-{short}-c{c}"
            metrics = curve(peak, pace, c, rng)

            # raw result JSON on disk, vllm-bench-shaped, so export/delete work
            result_path = results_dir / f"{run_id}.json"
            result_path.write_text(json.dumps({
                "model_id": model, "backend": "vllm", "dataset_name": "random",
                "num_prompts": NUM_PROMPTS, "max_concurrency": c,
                "request_rate": "inf", "random_input_len": INPUT_LEN,
                "random_output_len": OUTPUT_LEN,
                "request_throughput": metrics["req_per_sec"],
                "output_throughput": metrics["output_tok_per_sec"],
                "total_token_throughput": metrics["total_tok_per_sec"],
                "median_ttft_ms": metrics["ttft_p50_ms"],
                "p99_ttft_ms": metrics["ttft_p99_ms"],
                "median_tpot_ms": metrics["tpot_p50_ms"],
                "p99_tpot_ms": metrics["tpot_p99_ms"],
                "median_e2el_ms": metrics["e2el_p50_ms"],
                "p99_e2el_ms": metrics["e2el_p99_ms"],
                "__demo__": True,
            }, indent=2))

            finished = now - timedelta(hours=(len(MODELS) - mi) * 6,
                                       minutes=(len(CONCURRENCIES) - ci) * 9)
            started = finished - timedelta(minutes=7)

            cfg = {
                "server": {"model": model, "tensor_parallel_size": 1,
                           "gpu_memory_utilization": 0.9},
                "bench": {"backend": "vllm", "dataset": "random",
                          "input_len": INPUT_LEN, "output_len": OUTPUT_LEN,
                          "num_prompts": NUM_PROMPTS, "max_concurrency": c,
                          "request_rate": "inf", "ignore_eos": True, "seed": 0},
            }
            with db.connect() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO runs(id, name, label, status, "
                    "config_json, runner, port, created_at, started_at, finished_at) "
                    "VALUES(?, ?, 'demo sweep', 'completed', ?, 'local', 8000, ?, ?, ?)",
                    (run_id, f"{short}-c{c}", json.dumps(cfg),
                     started.isoformat(timespec="seconds"),
                     started.isoformat(timespec="seconds"),
                     finished.isoformat(timespec="seconds")),
                )
            db.insert_result({
                "run_id": run_id, "model": model, "dataset": "random",
                "backend": "vllm", "max_concurrency": c, "request_rate": "inf",
                "num_prompts": NUM_PROMPTS, "input_len": INPUT_LEN,
                "output_len": OUTPUT_LEN, "result_path": str(result_path),
                **metrics,
            })
            n += 1
    print(f"Seeded {n} demo runs. Remove them with: python scripts/seed_demo.py --remove")


def remove() -> None:
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT res.result_path FROM results res WHERE res.run_id LIKE 'demo-%'"
        ).fetchall()
        for r in rows:
            Path(r["result_path"]).unlink(missing_ok=True)
        cur = conn.execute("DELETE FROM runs WHERE id LIKE 'demo-%'")
    print(f"Removed {cur.rowcount} demo runs (results cascade-deleted).")


if __name__ == "__main__":
    db.init()
    if "--remove" in sys.argv:
        remove()
    else:
        insert()
