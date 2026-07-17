"""Shared command builders for both runners.

Assembling `vllm serve` / `vllm-bench` argv in one place keeps local and
SLURM behaviour identical; the SLURM runner just shell-quotes the same argv
into an sbatch script.
"""
from __future__ import annotations

import shlex
from pathlib import Path

from app import config
from app.services import dataset_schema


def serve_args(server: dict, port: int) -> list[str]:
    args = [
        "vllm", "serve", server["model"],
        "--port", str(port),
        "--tensor-parallel-size", str(server["tensor_parallel_size"]),
        "--gpu-memory-utilization", str(server["gpu_memory_utilization"]),
    ]
    if server.get("max_model_len"):
        args += ["--max-model-len", str(server["max_model_len"])]
    extra = (server.get("extra_server_args") or "").strip()
    if extra:
        args += shlex.split(extra)
    return args


def bench_args(run: dict, settings: dict, port: int) -> list[str]:
    server = run["config"]["server"]
    bench = run["config"]["bench"]
    results_dir = Path(settings["results_dir"]).expanduser()

    args = [
        str(config.BENCH_BIN),
        "--backend", bench["backend"],
        "--model", server["model"],
        "--num-prompts", str(bench["num_prompts"]),
        "--max-concurrency", str(bench["max_concurrency"]),
        "--request-rate", str(bench["request_rate"]),
        "--seed", str(bench["seed"]),
    ]
    if bench.get("ignore_eos", True):
        args.append("--ignore-eos")

    dataset = bench["dataset"]
    # Old queued runs replay from the DB blob without re-validation.
    dp = bench.get("dataset_params") or dataset_schema.legacy_to_params(bench)
    if dataset.startswith("file:"):
        from app.services.dataset_scan import resolve_dataset_file
        path = resolve_dataset_file(settings["dataset_dir"], dataset)
        if path is None:
            raise ValueError(f"dataset file not found: {dataset}")
        args += ["--dataset-name", "sharegpt", "--dataset-path", str(path)]
    else:
        args += ["--dataset-name", dataset]
    args += dataset_flag_args(dataset, dp)

    # Always sent silently (plan §6.2).
    args += [
        "--save-result",
        "--result-dir", str(results_dir),
        "--result-filename", f"{run['id']}.json",
        "--percentile-metrics", "ttft,tpot,itl,e2el",
        "--base-url", f"http://127.0.0.1:{port}",
    ]
    return args


def dataset_flag_args(dataset: str, dp: dict) -> list[str]:
    """Pure: dataset field specs + non-empty params -> argv fragment."""
    out: list[str] = []
    for f in dataset_schema.field_specs(dataset):
        v = dp.get(f["key"])
        if v is None or v == "":
            continue
        if f["type"] == "bool":
            if v:
                out.append(f["flag"])
        else:
            out += [f["flag"], str(v)]
    return out


def shell_join(args: list[str]) -> str:
    return " ".join(shlex.quote(a) for a in args)
