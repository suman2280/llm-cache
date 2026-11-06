"""benchmark/report.py: recommendation + markdown rendering."""

from llm_cache.benchmark.report import recommend_threshold, render_markdown


def _row(thr, hit, fp):
    return {
        "threshold": thr,
        "paraphrase_hits": int(hit * 30),
        "paraphrase_total": 30,
        "paraphrase_hit_rate": hit,
        "distractor_hits": int(fp * 10),
        "distractor_total": 10,
        "distractor_false_hit_rate": fp,
        "hit_latency_ms": {"p50": 14.0, "p95": 30.0},
        "miss_latency_ms": {"mean": 4200.0},
        "est_inference_ms_avoided": 120000.0,
        "wall_ms": 90000.0,
    }


def test_recommend_threshold_success_bar_picks_tightest():
    rows = [
        _row(0.05, 0.40, 0.0),
        _row(0.10, 0.87, 0.0),
        _row(0.20, 0.93, 0.0),
        _row(0.30, 0.97, 0.30),
    ]
    rec = recommend_threshold(rows)
    # 0.10 and 0.20 both pass; the tightest passing radius wins (max margin).
    assert rec["threshold"] == 0.10
    assert rec["criterion"] == "success_bar"


def test_recommend_threshold_falls_back_to_tradeoff():
    rows = [_row(0.10, 0.50, 0.0), _row(0.30, 0.85, 0.40)]
    rec = recommend_threshold(rows)
    assert rec["threshold"] == 0.10  # 0.50-0.0 beats 0.85-0.40


def test_render_markdown_contains_sections():
    rows = [_row(0.10, 0.87, 0.0)]
    md = render_markdown(
        {"path": "x.yaml", "model": "llama3.2:3b", "n_paraphrases": 30,
         "n_distractors": 10, "proxy_url": "http://localhost:8000"},
        {"n": 40, "mean_ms": 4300.0, "p50_ms": 4100.0, "p95_ms": 6200.0, "total_ms": 172000.0},
        rows,
        [],
        recommend_threshold(rows),
    )
    for section in ("Baseline", "Threshold sweep", "Recommendation",
                    "False-positive spot-checks", "Method"):
        assert section in md
    assert "87.0%" in md


def test_render_markdown_spot_check_rows():
    rows = [_row(0.10, 0.87, 0.1)]
    spot = [{"threshold": "population", "distractor_prompt": "How many legs does a spider have?",
             "source_prompt": "What is Redis?", "verdict": "false positive"}]
    md = render_markdown(
        {"path": "x.yaml", "model": "m", "n_paraphrases": 30, "n_distractors": 10,
         "proxy_url": "u"},
        {"n": 40, "mean_ms": 1.0, "p50_ms": 1.0, "p95_ms": 1.0, "total_ms": 1.0},
        rows, spot, recommend_threshold(rows),
    )
    assert "How many legs does a spider have?" in md
    assert "false positive" in md
