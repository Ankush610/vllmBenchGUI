"""Parse a vllm-bench result JSON into a `results` table row."""
from __future__ import annotations

import json
from pathlib import Path


class ResultParseError(Exception):
    pass


def _pick(data: dict, *keys: str):
    """First present, non-null key — result key names vary across versions."""
    for k in keys:
        if k in data and data[k] is not None:
            return data[k]
    return None


def parse_result_json(path: Path, run: dict) -> dict:
    if not path.is_file():
        raise ResultParseError(f"result file missing: {path}")
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as e:
        raise ResultParseError(f"cannot parse {path.name}: {e}")

    server = run["config"]["server"]
    bench = run["config"]["bench"]

    row = {
        "run_id": run["id"],
        "model": server["model"],
        "dataset": bench["dataset"],
        "backend": bench["backend"],
        "max_concurrency": bench.get("max_concurrency"),
        "request_rate": str(bench.get("request_rate")),
        "num_prompts": bench.get("num_prompts"),
        "input_len": bench.get("input_len"),
        "output_len": bench.get("output_len"),
        "req_per_sec": _pick(data, "request_throughput"),
        "output_tok_per_sec": _pick(data, "output_throughput",
                                    "output_token_throughput"),
        "total_tok_per_sec": _pick(data, "total_token_throughput",
                                   "total_throughput"),
        "ttft_p50_ms": _pick(data, "p50_ttft_ms", "median_ttft_ms"),
        "ttft_p99_ms": _pick(data, "p99_ttft_ms"),
        "tpot_p50_ms": _pick(data, "p50_tpot_ms", "median_tpot_ms"),
        "tpot_p99_ms": _pick(data, "p99_tpot_ms"),
        "e2el_p50_ms": _pick(data, "p50_e2el_ms", "median_e2el_ms"),
        "e2el_p99_ms": _pick(data, "p99_e2el_ms"),
        "result_path": str(path),
    }
    if row["req_per_sec"] is None and row["output_tok_per_sec"] is None:
        raise ResultParseError(
            f"{path.name} has no recognizable throughput metrics")
    return row
