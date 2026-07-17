"""Single source of truth for benchmark datasets.

Each entry here drives: the dataset dropdown (+ network badge), the
per-dataset sub-fields the frontend renders, frontend/backend validation,
and the CLI flags `runners/base.py` emits. Adding a dataset (or a flag to
an existing one) means adding one field spec here — nothing else.

Field spec keys:
    key       param name inside bench.dataset_params (globally unique)
    flag      CLI flag emitted by bench_args; bool fields emit the bare flag
    label/tip UI strings
    type      int | float | bool | str | select | hf_repo | path
    default   initial value; "" / False means "optional, flag omitted"
    required  True = always required; "offline" = required in offline mode
    min/max   numeric bounds; options = allowed values for select
    offline_nudge  show a non-blocking hint when offline mode is on and empty
"""
from __future__ import annotations

import re

# Tokens that would let a value escape into new shell commands (sbatch path).
UNSAFE_SHELL = re.compile(r"[;&|`\n]|\$\(")
HF_REPO_RE = re.compile(r"^[\w.\-]+/[\w.\-]+$")

# Network badges: offline = never touches the network; cached = one-time
# download (offline afterwards, or immediately with --dataset-path);
# hf = needs --hf-subset + --hf-split pinned for offline cache hits.
NETWORK_NOTES = {
    "offline": "offline",
    "cached": "cached after first run",
    "hf": "needs subset+split for offline",
}

# Shared between sharegpt and file:* entries (a scanned file is run as
# sharegpt with --dataset-path pre-resolved from the id).
_SHAREGPT_OUTPUT_LEN = {
    "key": "sharegpt_output_len", "flag": "--sharegpt-output-len",
    "label": "Output length (override)", "type": "int", "default": "",
    "min": 1, "max": 32768,
    "tip": "Cap generated tokens per request; empty keeps each "
           "conversation's own output length.",
}

FILE_FIELDS: list[dict] = [_SHAREGPT_OUTPUT_LEN]

DATASETS: dict[str, dict] = {
    "random": {
        "id": "random", "kind": "builtin", "network": "offline",
        "note": "synthetic exact-length prompts",
        "fields": [
            {"key": "random_input_len", "flag": "--random-input-len",
             "label": "Input length", "type": "int", "default": 1024,
             "required": True, "min": 1, "max": 131072,
             "tip": "Prompt length in tokens per request."},
            {"key": "random_output_len", "flag": "--random-output-len",
             "label": "Output length", "type": "int", "default": 128,
             "required": True, "min": 1, "max": 32768,
             "tip": "Tokens generated per request."},
            {"key": "random_prefix_len", "flag": "--random-prefix-len",
             "label": "Prefix length", "type": "int", "default": 0,
             "min": 0, "max": 131072,
             "tip": "Shared prefix tokens prepended to every prompt "
                    "(prefix-cache testing)."},
            {"key": "random_range_ratio", "flag": "--random-range-ratio",
             "label": "Range ratio", "type": "float", "default": 1.0,
             "min": 0.0, "max": 1.0, "step": "0.05",
             "tip": "Length jitter: 1.0 = exact lengths, lower = wider "
                    "spread around the target."},
            {"key": "prompt_token_ids", "flag": "--prompt-token-ids",
             "label": "Prompt token IDs", "type": "bool", "default": False,
             "tip": "Send token IDs instead of text (skips server-side "
                    "tokenization)."},
        ],
    },
    "sonnet": {
        "id": "sonnet", "kind": "builtin", "network": "offline",
        "note": "built-in, prefix-cache friendly",
        "fields": [
            {"key": "sonnet_input_len", "flag": "--sonnet-input-len",
             "label": "Input length", "type": "int", "default": 1024,
             "required": True, "min": 1, "max": 131072,
             "tip": "Prompt length in tokens per request."},
            {"key": "sonnet_output_len", "flag": "--sonnet-output-len",
             "label": "Output length", "type": "int", "default": 128,
             "required": True, "min": 1, "max": 32768,
             "tip": "Tokens generated per request."},
            {"key": "sonnet_prefix_len", "flag": "--sonnet-prefix-len",
             "label": "Prefix length", "type": "int", "default": 200,
             "min": 0, "max": 131072,
             "tip": "Shared prefix length in tokens."},
            {"key": "dataset_path", "flag": "--dataset-path",
             "label": "Custom sonnet file", "type": "path", "default": "",
             "tip": "Optional path to a custom sonnet-format text file; "
                    "empty uses the text baked into the binary."},
        ],
    },
    "sharegpt": {
        "id": "sharegpt", "kind": "builtin", "network": "cached",
        "note": "real conversations (auto-download)",
        "fields": [
            {"key": "dataset_path", "flag": "--dataset-path",
             "label": "Dataset path", "type": "path", "default": "",
             "offline_nudge": True,
             "tip": "Optional local ShareGPT JSON; empty auto-downloads "
                    "into the HF hub cache on first use."},
            _SHAREGPT_OUTPUT_LEN,
        ],
    },
    "speed-bench": {
        "id": "speed-bench", "kind": "builtin", "network": "cached",
        "note": "NVIDIA SPEED-Bench suite (auto-download)",
        "fields": [
            {"key": "speed_bench_config", "flag": "--speed-bench-config",
             "label": "Config", "type": "select", "default": "qualitative",
             "required": True,
             "options": ["qualitative", "throughput_1k", "throughput_2k",
                         "throughput_8k", "throughput_16k",
                         "throughput_32k"],
             "tip": "Which SPEED-Bench split to run; each split caches "
                    "separately, so pre-warm every one you plan to use."},
            {"key": "speed_bench_category", "flag": "--speed-bench-category",
             "label": "Category", "type": "select", "default": "",
             "options": ["", "low_entropy", "high_entropy", "mixed_entropy",
                         "coding", "math"],
             "tip": "Optional filter to one prompt category."},
            {"key": "speed_bench_max_input_len",
             "flag": "--speed-bench-max-input-len",
             "label": "Max input length", "type": "int", "default": "",
             "min": 1, "max": 131072,
             "tip": "Drop prompts longer than this many tokens."},
            {"key": "output_len", "flag": "--output-len",
             "label": "Output length", "type": "int", "default": 256,
             "min": 1, "max": 32768,
             "tip": "Tokens generated per request."},
            {"key": "dataset_path", "flag": "--dataset-path",
             "label": "Dataset path", "type": "path", "default": "",
             "offline_nudge": True,
             "tip": "Optional cached speed-bench-<config>.json for "
                    "fully-offline runs."},
        ],
    },
    "hf": {
        "id": "hf", "kind": "builtin", "network": "hf",
        "note": "any HF dataset by repo ID",
        "fields": [
            {"key": "dataset_path", "flag": "--dataset-path",
             "label": "HF dataset repo", "type": "hf_repo", "default": "",
             "required": True, "placeholder": "org/dataset-name",
             "tip": "HF dataset repo ID (org/name), not a file path."},
            {"key": "hf_subset", "flag": "--hf-subset",
             "label": "Subset", "type": "str", "default": "",
             "required": "offline",
             "tip": "Dataset config name; pinning it (with split) lets a "
                    "warm cache work offline."},
            {"key": "hf_split", "flag": "--hf-split",
             "label": "Split", "type": "str", "default": "",
             "required": "offline", "placeholder": "train",
             "tip": "Dataset split; pinning it (with subset) lets a warm "
                    "cache work offline."},
            {"key": "hf_output_len", "flag": "--hf-output-len",
             "label": "Output length (override)", "type": "int",
             "default": "", "min": 1, "max": 32768,
             "tip": "Cap generated tokens per request."},
            {"key": "hf_text_column", "flag": "--hf-text-column",
             "label": "Text column", "type": "str", "default": "",
             "tip": "Column holding the prompt text, when auto-detect "
                    "picks the wrong one."},
        ],
    },
    # random-mm (multimodal) intentionally excluded; to support it later,
    # add an entry here — nothing else needs touching.
}


def field_specs(dataset_id: str) -> list[dict]:
    if dataset_id.startswith("file:"):
        return FILE_FIELDS
    ds = DATASETS.get(dataset_id)
    return ds["fields"] if ds else []


def default_params(dataset_id: str) -> dict:
    return {f["key"]: f["default"] for f in field_specs(dataset_id)}


def _unset(value) -> bool:
    return value is None or value == ""


def _as_number(value):
    """int/float or numeric string -> float; None when not numeric."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def validate_params(dataset_id: str, params: dict | None,
                    offline: bool = False) -> dict[str, str]:
    """Generic per-field checks; returns {field_key: message}, empty if ok."""
    if not dataset_id.startswith("file:") and dataset_id not in DATASETS:
        return {"dataset": f"unknown dataset {dataset_id!r}"}
    params = params or {}
    errors: dict[str, str] = {}
    for f in field_specs(dataset_id):
        v = params.get(f["key"])
        req = f.get("required")
        if _unset(v):
            if req is True or (req == "offline" and offline):
                errors[f["key"]] = ("required" if req is True
                                    else "required in offline mode")
            continue
        t = f["type"]
        if t in ("int", "float"):
            n = _as_number(v)
            if n is None or (t == "int" and n != int(n)):
                errors[f["key"]] = f"must be a {'whole number' if t == 'int' else 'number'}"
                continue
            lo, hi = f.get("min"), f.get("max")
            if (lo is not None and n < lo) or (hi is not None and n > hi):
                errors[f["key"]] = f"must be between {lo} and {hi}"
        elif t == "bool":
            if not isinstance(v, bool):
                errors[f["key"]] = "must be true or false"
        elif t == "select":
            if str(v) not in [str(o) for o in f["options"]]:
                errors[f["key"]] = "invalid choice"
        elif t == "hf_repo":
            if not HF_REPO_RE.match(str(v).strip()):
                errors[f["key"]] = "must look like org/name (HF repo id)"
        else:  # str | path — lands in argv, keep shell-metachar parity
            if UNSAFE_SHELL.search(str(v)):
                errors[f["key"]] = "shell metacharacters ; & | ` $( not allowed"
    return errors


def legacy_to_params(bench: dict) -> dict:
    """Map a pre-schema flat config (input_len/output_len/sonnet_prefix_len)
    onto the selected dataset's params, preserving old flag emission."""
    ds = bench.get("dataset", "random")
    dp = default_params(ds)
    in_len = bench.get("input_len")
    out_len = bench.get("output_len")
    prefix = bench.get("sonnet_prefix_len")
    if ds == "random":
        if in_len is not None:
            dp["random_input_len"] = in_len
        if out_len is not None:
            dp["random_output_len"] = out_len
    elif ds == "sonnet":
        if in_len is not None:
            dp["sonnet_input_len"] = in_len
        if out_len is not None:
            dp["sonnet_output_len"] = out_len
        if prefix is not None:
            dp["sonnet_prefix_len"] = prefix
    elif ds == "sharegpt" or ds.startswith("file:"):
        if out_len is not None:
            dp["sharegpt_output_len"] = out_len
    return dp


def summary_lengths(bench: dict) -> tuple[int | None, int | None]:
    """(input_len, output_len) for the dashboard row, best effort."""
    def num(v):
        n = _as_number(v)
        return int(n) if n is not None else None

    dp = bench.get("dataset_params") or {}
    if not dp:  # pre-schema config
        return num(bench.get("input_len")), num(bench.get("output_len"))
    ds = bench.get("dataset", "")
    if ds == "random":
        return num(dp.get("random_input_len")), num(dp.get("random_output_len"))
    if ds == "sonnet":
        return num(dp.get("sonnet_input_len")), num(dp.get("sonnet_output_len"))
    if ds == "sharegpt" or ds.startswith("file:"):
        return None, num(dp.get("sharegpt_output_len"))
    if ds == "speed-bench":
        return num(dp.get("speed_bench_max_input_len")), num(dp.get("output_len"))
    if ds == "hf":
        return None, num(dp.get("hf_output_len"))
    return None, None
