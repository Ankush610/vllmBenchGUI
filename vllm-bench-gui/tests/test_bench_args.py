"""Golden argv per dataset: base.bench_args / dataset_flag_args.

These are pure functions; a wrong flag here means a wrong flag in every
local and SLURM run, so assert exact argv.
"""
import pytest

from app import config
from app.runners import base


def make_run(dataset, dataset_params=None, **bench_extra):
    bench = {"backend": "vllm", "dataset": dataset, "num_prompts": 1000,
             "max_concurrency": 200, "request_rate": "inf",
             "ignore_eos": True, "seed": 0}
    if dataset_params is not None:
        bench["dataset_params"] = dataset_params
    bench.update(bench_extra)
    return {"id": "run1", "config": {
        "server": {"model": "org/model"}, "bench": bench}}


SETTINGS = {"results_dir": "/tmp/results", "dataset_dir": "/tmp/datasets"}

COMMON_HEAD = [str(config.BENCH_BIN), "--backend", "vllm",
               "--model", "org/model", "--num-prompts", "1000",
               "--max-concurrency", "200", "--request-rate", "inf",
               "--seed", "0", "--ignore-eos"]


def dataset_part(args):
    """Slice out the dataset-driven argv between the head and the tail."""
    assert args[:len(COMMON_HEAD)] == COMMON_HEAD
    tail_start = args.index("--save-result")
    return args[len(COMMON_HEAD):tail_start]


def test_random_all_fields():
    run = make_run("random", {"random_input_len": 1024,
                              "random_output_len": 128,
                              "random_prefix_len": 100,
                              "random_range_ratio": 0.8,
                              "prompt_token_ids": True})
    assert dataset_part(base.bench_args(run, SETTINGS, 8000)) == [
        "--dataset-name", "random",
        "--random-input-len", "1024", "--random-output-len", "128",
        "--random-prefix-len", "100", "--random-range-ratio", "0.8",
        "--prompt-token-ids"]


def test_random_bool_false_omitted():
    run = make_run("random", {"random_input_len": 512,
                              "random_output_len": 64,
                              "prompt_token_ids": False})
    part = dataset_part(base.bench_args(run, SETTINGS, 8000))
    assert "--prompt-token-ids" not in part


def test_sonnet_with_and_without_custom_path():
    run = make_run("sonnet", {"sonnet_input_len": 550,
                              "sonnet_output_len": 150,
                              "sonnet_prefix_len": 200,
                              "dataset_path": ""})
    assert dataset_part(base.bench_args(run, SETTINGS, 8000)) == [
        "--dataset-name", "sonnet",
        "--sonnet-input-len", "550", "--sonnet-output-len", "150",
        "--sonnet-prefix-len", "200"]

    run = make_run("sonnet", {"sonnet_input_len": 550,
                              "sonnet_output_len": 150,
                              "dataset_path": "/data/custom.txt"})
    part = dataset_part(base.bench_args(run, SETTINGS, 8000))
    assert part[-2:] == ["--dataset-path", "/data/custom.txt"]


def test_sharegpt_minimal_and_full():
    run = make_run("sharegpt", {})
    assert dataset_part(base.bench_args(run, SETTINGS, 8000)) == [
        "--dataset-name", "sharegpt"]

    run = make_run("sharegpt", {"dataset_path": "/data/sgpt.json",
                                "sharegpt_output_len": 200})
    assert dataset_part(base.bench_args(run, SETTINGS, 8000)) == [
        "--dataset-name", "sharegpt",
        "--dataset-path", "/data/sgpt.json",
        "--sharegpt-output-len", "200"]


def test_speed_bench_minimal_and_full():
    run = make_run("speed-bench", {"speed_bench_config": "qualitative",
                                   "output_len": 256})
    assert dataset_part(base.bench_args(run, SETTINGS, 8000)) == [
        "--dataset-name", "speed-bench",
        "--speed-bench-config", "qualitative", "--output-len", "256"]

    run = make_run("speed-bench", {"speed_bench_config": "throughput_8k",
                                   "speed_bench_category": "coding",
                                   "speed_bench_max_input_len": 8192,
                                   "output_len": 256,
                                   "dataset_path": "/cache/sb.json"})
    assert dataset_part(base.bench_args(run, SETTINGS, 8000)) == [
        "--dataset-name", "speed-bench",
        "--speed-bench-config", "throughput_8k",
        "--speed-bench-category", "coding",
        "--speed-bench-max-input-len", "8192",
        "--output-len", "256", "--dataset-path", "/cache/sb.json"]


def test_hf_minimal_and_full():
    run = make_run("hf", {"dataset_path": "allenai/WildChat-4.8M"})
    assert dataset_part(base.bench_args(run, SETTINGS, 8000)) == [
        "--dataset-name", "hf", "--dataset-path", "allenai/WildChat-4.8M"]

    run = make_run("hf", {"dataset_path": "THUDM/LongBench",
                          "hf_subset": "narrativeqa", "hf_split": "test",
                          "hf_output_len": 300, "hf_text_column": "text"})
    assert dataset_part(base.bench_args(run, SETTINGS, 8000)) == [
        "--dataset-name", "hf", "--dataset-path", "THUDM/LongBench",
        "--hf-subset", "narrativeqa", "--hf-split", "test",
        "--hf-output-len", "300", "--hf-text-column", "text"]


def test_file_dataset_resolves_and_runs_as_sharegpt(tmp_path):
    f = tmp_path / "conv.json"
    f.write_text("[]")
    settings = dict(SETTINGS, dataset_dir=str(tmp_path))
    run = make_run("file:conv.json", {"sharegpt_output_len": 200})
    part = dataset_part(base.bench_args(run, settings, 8000))
    assert part[:2] == ["--dataset-name", "sharegpt"]
    assert part[2] == "--dataset-path" and part[3].endswith("conv.json")
    assert part[4:] == ["--sharegpt-output-len", "200"]


def test_file_dataset_missing_raises(tmp_path):
    run = make_run("file:absent.json", {})
    with pytest.raises(ValueError, match="dataset file not found"):
        base.bench_args(run, dict(SETTINGS, dataset_dir=str(tmp_path)), 8000)


def test_legacy_blob_replays_with_old_flags():
    """A pre-schema run straight from the DB keeps its exact old semantics."""
    run = make_run("sonnet", None, input_len=550, output_len=150,
                   sonnet_prefix_len=200)
    part = dataset_part(base.bench_args(run, SETTINGS, 8000))
    assert part == ["--dataset-name", "sonnet",
                    "--sonnet-input-len", "550", "--sonnet-output-len", "150",
                    "--sonnet-prefix-len", "200"]

    run = make_run("sharegpt", None, input_len=1024, output_len=128)
    assert dataset_part(base.bench_args(run, SETTINGS, 8000)) == [
        "--dataset-name", "sharegpt", "--sharegpt-output-len", "128"]


def test_tail_flags_present():
    run = make_run("random", {"random_input_len": 1, "random_output_len": 1})
    args = base.bench_args(run, SETTINGS, 8123)
    assert args[-2:] == ["--base-url", "http://127.0.0.1:8123"]
    assert "--save-result" in args
    assert args[args.index("--result-filename") + 1] == "run1.json"
