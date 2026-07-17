"""Pydantic models: run configs, settings payloads, API responses.

Validation mirrors the frontend rules (plan §6) so a hand-crafted API call is
held to the same constraints as the UI.
"""
from __future__ import annotations

import re
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator

# Tokens that would let extra args escape into new shell commands.
UNSAFE_SHELL = re.compile(r"[;&|`\n]|\$\(")
HF_REPO_RE = re.compile(r"^[\w.\-]+/[\w.\-]+$")


class ServerConfig(BaseModel):
    model: str
    tensor_parallel_size: int = Field(1, ge=1, le=8)
    gpu_memory_utilization: float = Field(0.90, ge=0.1, le=0.99)
    max_model_len: Optional[int] = Field(None, ge=256)
    port: Optional[int] = Field(None, ge=1024, le=65535)
    extra_server_args: str = ""

    @field_validator("model")
    @classmethod
    def model_looks_like_repo(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("model is required")
        if not HF_REPO_RE.match(v):
            raise ValueError("model must look like org/name (HF repo id)")
        return v

    @field_validator("extra_server_args")
    @classmethod
    def shell_safe(cls, v: str) -> str:
        if UNSAFE_SHELL.search(v):
            raise ValueError("extra args may not contain ; & | ` $( or newlines")
        return v.strip()

    def reuse_key(self) -> tuple:
        """Server identity: two runs with the same key can share a server."""
        return (self.model, self.tensor_parallel_size,
                self.gpu_memory_utilization, self.max_model_len,
                self.extra_server_args)


class BenchConfig(BaseModel):
    backend: Literal["vllm", "openai-chat"] = "vllm"
    dataset: str = "random"          # random | sharegpt | sonnet | file:<name>
    input_len: int = Field(1024, ge=1, le=131072)
    output_len: int = Field(128, ge=1, le=32768)
    num_prompts: int = Field(1000, ge=1, le=1_000_000)
    max_concurrency: int = Field(200, ge=1)
    request_rate: str = "inf"        # float > 0 or "inf"
    ignore_eos: bool = True
    seed: int = Field(0, ge=0)
    # sonnet-only
    sonnet_prefix_len: int = Field(200, ge=0)

    @field_validator("request_rate")
    @classmethod
    def rate_valid(cls, v: str) -> str:
        v = v.strip()
        if v == "inf":
            return v
        try:
            if float(v) <= 0:
                raise ValueError
        except ValueError:
            raise ValueError("request rate must be a positive number or 'inf'")
        return v

    @field_validator("dataset")
    @classmethod
    def dataset_valid(cls, v: str) -> str:
        v = v.strip()
        if v in ("random", "sharegpt", "sonnet") or v.startswith("file:"):
            return v
        raise ValueError("dataset must be random, sharegpt, sonnet, or file:<name>")


class RunConfig(BaseModel):
    name: str = ""
    label: str = ""
    server: ServerConfig
    bench: BenchConfig


class QueueRunsRequest(BaseModel):
    runs: list[RunConfig] = Field(..., min_length=1)


class SettingsIn(BaseModel):
    model_dir: Optional[str] = None
    dataset_dir: Optional[str] = None
    hf_token: Optional[str] = None       # omitted/None = keep current
    results_dir: Optional[str] = None
    port_range_start: Optional[int] = Field(None, ge=1024, le=65000)
    execution_mode: Optional[Literal["local", "slurm"]] = None
    bind_address: Optional[Literal["127.0.0.1", "0.0.0.0"]] = None
    health_check_timeout: Optional[int] = Field(None, ge=30, le=7200)
    slurm_partition: Optional[str] = None
    slurm_gpus_per_job: Optional[int] = Field(None, ge=1, le=64)
    slurm_time_limit: Optional[str] = None
    slurm_account: Optional[str] = None
    slurm_extra_flags: Optional[str] = None

    @field_validator("slurm_time_limit")
    @classmethod
    def time_limit_valid(cls, v: Optional[str]) -> Optional[str]:
        if v is None or v == "":
            return v
        if not re.match(r"^(\d+-)?\d{1,2}:\d{2}:\d{2}$", v):
            raise ValueError("time limit must look like HH:MM:SS or D-HH:MM:SS")
        return v
