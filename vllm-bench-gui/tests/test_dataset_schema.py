"""dataset_schema: validation, legacy migration, dashboard length summary."""
import pytest

from app.services import dataset_schema as ds


def test_defaults_validate_for_every_dataset():
    for dataset_id in ds.DATASETS:
        errors = ds.validate_params(dataset_id, ds.default_params(dataset_id))
        # Only required fields with no sensible default may complain
        # (hf's repo ID must be typed by the user).
        empty_required = {f["key"] for f in ds.field_specs(dataset_id)
                          if f.get("required") is True and f["default"] == ""}
        assert set(errors) == empty_required, f"{dataset_id}: {errors}"


def test_file_dataset_uses_file_fields():
    assert ds.field_specs("file:conv.json") == ds.FILE_FIELDS
    assert ds.validate_params("file:conv.json", {}) == {}


def test_unknown_dataset_rejected():
    assert "dataset" in ds.validate_params("nope", {})


def test_required_field_missing():
    errors = ds.validate_params("random", {"random_output_len": 128})
    assert errors == {"random_input_len": "required"}


def test_int_type_and_range():
    assert "random_input_len" in ds.validate_params(
        "random", {"random_input_len": "abc", "random_output_len": 128})
    assert "random_input_len" in ds.validate_params(
        "random", {"random_input_len": 0, "random_output_len": 128})
    assert "random_input_len" in ds.validate_params(
        "random", {"random_input_len": 1.5, "random_output_len": 128})
    # numeric strings are tolerated (legacy blobs)
    assert ds.validate_params(
        "random", {"random_input_len": "1024", "random_output_len": 128}) == {}


def test_float_range():
    ok = {"random_input_len": 1, "random_output_len": 1}
    assert "random_range_ratio" in ds.validate_params(
        "random", {**ok, "random_range_ratio": 1.5})
    assert ds.validate_params(
        "random", {**ok, "random_range_ratio": 0.5}) == {}


def test_select_options():
    assert "speed_bench_config" in ds.validate_params(
        "speed-bench", {"speed_bench_config": "bogus"})
    assert ds.validate_params(
        "speed-bench", {"speed_bench_config": "throughput_8k"}) == {}


def test_hf_repo_id_not_a_path():
    assert "dataset_path" in ds.validate_params(
        "hf", {"dataset_path": "/data/wildchat.json"})
    assert ds.validate_params(
        "hf", {"dataset_path": "allenai/WildChat-4.8M"}) == {}


def test_path_rejects_shell_metachars():
    errors = ds.validate_params(
        "sharegpt", {"dataset_path": "/tmp/x.json; rm -rf /"})
    assert "dataset_path" in errors


@pytest.mark.parametrize("offline,expect_keys", [
    (False, set()),
    (True, {"hf_subset", "hf_split"}),
])
def test_offline_requiredness_only_bites_when_offline(offline, expect_keys):
    errors = ds.validate_params("hf", {"dataset_path": "org/name"},
                                offline=offline)
    assert set(errors) == expect_keys


@pytest.mark.parametrize("dataset,expected", [
    ("random", {"random_input_len": 550, "random_output_len": 150}),
    ("sonnet", {"sonnet_input_len": 550, "sonnet_output_len": 150,
                "sonnet_prefix_len": 42}),
    ("sharegpt", {"sharegpt_output_len": 150}),
    ("file:x.json", {"sharegpt_output_len": 150}),
])
def test_legacy_to_params(dataset, expected):
    legacy = {"dataset": dataset, "input_len": 550, "output_len": 150,
              "sonnet_prefix_len": 42}
    dp = ds.legacy_to_params(legacy)
    for key, value in expected.items():
        assert dp[key] == value
    # everything else falls back to schema defaults
    for f in ds.field_specs(dataset):
        assert f["key"] in dp


@pytest.mark.parametrize("bench,expected", [
    ({"dataset": "random",
      "dataset_params": {"random_input_len": 1024, "random_output_len": 128}},
     (1024, 128)),
    ({"dataset": "sonnet",
      "dataset_params": {"sonnet_input_len": 550, "sonnet_output_len": 150}},
     (550, 150)),
    ({"dataset": "sharegpt", "dataset_params": {"sharegpt_output_len": 200}},
     (None, 200)),
    ({"dataset": "sharegpt", "dataset_params": {"dataset_path": "/x.json"}},
     (None, None)),
    ({"dataset": "speed-bench",
      "dataset_params": {"speed_bench_config": "qualitative", "output_len": 256}},
     (None, 256)),
    ({"dataset": "hf", "dataset_params": {"dataset_path": "o/n",
                                          "hf_output_len": 300}},
     (None, 300)),
    # pre-schema blob: flat fields win
    ({"dataset": "random", "input_len": 111, "output_len": 22}, (111, 22)),
])
def test_summary_lengths(bench, expected):
    assert ds.summary_lengths(bench) == expected
