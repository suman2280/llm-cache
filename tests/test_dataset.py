"""Benchmark dataset sanity: the PoC's evidence quality depends on it."""

from pathlib import Path

import yaml

from llm_cache.benchmark.__main__ import load_dataset

DATASET = Path(__file__).parents[1] / "src/llm_cache/benchmark/dataset/qa.yaml"


def test_dataset_loads_with_expected_shape():
    ds = load_dataset(DATASET)
    assert ds["n_paraphrases"] == 30
    assert ds["n_distractors"] == 10
    assert sum(1 for i in ds["items"] if i["kind"] == "seed") == 10
    assert len(ds["items"]) == 50


def test_all_ids_unique():
    ds = load_dataset(DATASET)
    ids = [i["id"] for i in ds["items"]]
    assert len(ids) == len(set(ids))


def test_max_topics_limits():
    ds = load_dataset(DATASET, max_topics=2)
    assert ds["n_paraphrases"] == 6
    assert sum(1 for i in ds["items"] if i["kind"] == "seed") == 2


def test_topics_do_not_overlap_distractors():
    raw = yaml.safe_load(DATASET.read_text())
    topic_prompts = {t["original"].lower() for t in raw["topics"]}
    distractor_prompts = {d["prompt"].lower() for d in raw["distractors"]}
    assert topic_prompts.isdisjoint(distractor_prompts)
