"""BenchConfig: dataset_params validation + legacy blob migration."""
import pytest
from pydantic import ValidationError

from app.schemas import BenchConfig


def test_legacy_flat_config_migrates():
    b = BenchConfig(dataset="random", input_len=1024, output_len=128)
    assert b.dataset_params["random_input_len"] == 1024
    assert b.dataset_params["random_output_len"] == 128


def test_legacy_sonnet_prefix_migrates():
    b = BenchConfig(dataset="sonnet", input_len=550, output_len=150,
                    sonnet_prefix_len=42)
    assert b.dataset_params["sonnet_prefix_len"] == 42


def test_defaults_synthesized_when_nothing_given():
    b = BenchConfig()  # dataset=random, no params at all
    assert b.dataset_params["random_input_len"] == 1024


def test_unknown_keys_dropped():
    b = BenchConfig(dataset="random",
                    dataset_params={"random_input_len": 512,
                                    "random_output_len": 64,
                                    "sonnet_prefix_len": 999,
                                    "bogus": "x"})
    assert "sonnet_prefix_len" not in b.dataset_params
    assert "bogus" not in b.dataset_params


def test_invalid_dataset_id_rejected():
    with pytest.raises(ValidationError, match="dataset must be one of"):
        BenchConfig(dataset="not-a-dataset")


def test_invalid_param_value_rejected():
    with pytest.raises(ValidationError, match="random_input_len"):
        BenchConfig(dataset="random",
                    dataset_params={"random_input_len": 0,
                                    "random_output_len": 64})


def test_hf_requires_repo_id():
    with pytest.raises(ValidationError, match="dataset_path"):
        BenchConfig(dataset="hf", dataset_params={"hf_split": "train"})
    b = BenchConfig(dataset="hf",
                    dataset_params={"dataset_path": "org/name"})
    assert b.dataset_params["dataset_path"] == "org/name"


def test_file_dataset_accepted():
    b = BenchConfig(dataset="file:conv.json",
                    dataset_params={"sharegpt_output_len": 200})
    assert b.dataset == "file:conv.json"
