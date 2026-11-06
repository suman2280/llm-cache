"""benchmark/metrics.py: pure metric math."""

from llm_cache.benchmark.metrics import compute_sweep_row, percentile, rate, summarize_latencies


def test_percentile_interpolates():
    vals = [1, 2, 3, 4]
    assert percentile(vals, 50) == 2.5
    assert percentile(vals, 0) == 1
    assert percentile(vals, 100) == 4


def test_summarize_latencies_shape():
    s = summarize_latencies([1.0, 2.0, 3.0, 10.0])
    assert s["n"] == 4 and s["max"] == 10.0 and 2 < s["p50"] < 3
    assert summarize_latencies([])["n"] == 0


def _rec(id, kind, status, latency=100.0):
    return {"id": id, "kind": kind, "status": status, "latency_ms": latency, "similarity": None}


def test_sweep_row_hit_rate_and_false_hits():
    records = [
        _rec("t:seed", "seed", "miss", 5000.0),
        _rec("d1", "distractor", "miss", 5000.0),
        _rec("d2", "distractor", "semantic-hit", 20.0),
        _rec("t:p1", "paraphrase", "semantic-hit", 15.0),
        _rec("t:p2", "paraphrase", "semantic-hit", 12.0),
        _rec("t:p3", "paraphrase", "miss", 4000.0),
    ]
    baseline = {"t:p1": {"latency_ms": 5100.0}, "t:p2": {"latency_ms": 5200.0},
                "d2": {"latency_ms": 5050.0}, "t:seed": {"latency_ms": 5000.0}}
    row = compute_sweep_row(0.10, records, baseline)

    assert row["paraphrase_hits"] == 2 and row["paraphrase_total"] == 3
    assert row["paraphrase_hit_rate"] == round(2 / 3, 4)
    assert row["distractor_false_hit_rate"] == round(1 / 2, 4)
    assert row["cache_hits"] == 3
    assert row["est_inference_ms_avoided"] == (5100 + 5200 + 5050)
    assert row["hit_latency_ms"]["p50"] == 15.0


def test_rate_zero_division():
    assert rate(0, 0) == 0.0
