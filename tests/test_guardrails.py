"""guardrails.py: cacheability policy."""

from llm_cache.guardrails import evaluate_cacheability


def test_plain_request_is_cacheable():
    policy = evaluate_cacheability({"model": "m", "messages": [{"role": "user", "content": "hi"}]})
    assert policy.cacheable and policy.reason is None


def test_even_temperature_zero_is_cacheable():
    body = {"model": "m", "messages": [{"role": "user", "content": "hi"}], "temperature": 0}
    assert evaluate_cacheability(body).cacheable


def test_tools_are_not_cached():
    body = {
        "model": "m",
        "messages": [{"role": "user", "content": "hi"}],
        "tools": [{"type": "function", "function": {"name": "f"}}],
    }
    policy = evaluate_cacheability(body)
    assert not policy.cacheable and policy.reason == "tools"


def test_no_user_text_not_cached():
    body = {"model": "m", "messages": [{"role": "user", "content": ""}]}
    policy = evaluate_cacheability(body)
    assert not policy.cacheable and policy.reason == "no_user_text"


def test_empty_messages_not_cached():
    assert not evaluate_cacheability({"model": "m", "messages": []}).cacheable
