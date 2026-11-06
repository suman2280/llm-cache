"""canonical.py: exact-tier hashing and prompt extraction."""

from llm_cache.canonical import (
    canonical_request_hash,
    last_user_text,
    normalize_prompt_text,
    semantic_doc_key,
)

M = [{"role": "user", "content": "What is Redis?"}]


def test_hash_is_stable_for_identical_requests():
    a = canonical_request_hash("llama3.2:3b", M, {"temperature": 0})
    b = canonical_request_hash("llama3.2:3b", M, {"temperature": 0})
    assert a == b


def test_hash_changes_with_sampling_param():
    base = canonical_request_hash("llama3.2:3b", M, {})
    with_temp = canonical_request_hash("llama3.2:3b", M, {"temperature": 0.7})
    assert base != with_temp


def test_hash_changes_with_model():
    a = canonical_request_hash("llama3.2:3b", M, {})
    b = canonical_request_hash("qwen3:8b", M, {})
    assert a != b


def test_hash_changes_with_message_order():
    msgs = [
        {"role": "user", "content": "a"},
        {"role": "assistant", "content": "b"},
        {"role": "user", "content": "c"},
    ]
    a = canonical_request_hash("llama3.2:3b", msgs, {})
    b = canonical_request_hash("llama3.2:3b", list(reversed(msgs)), {})
    assert a != b


def test_hash_ignores_uncacheable_fields():
    a = canonical_request_hash("llama3.2:3b", M, {"user": "someone", "stream": False})
    b = canonical_request_hash("llama3.2:3b", M, {})
    assert a == b


def test_last_user_text_string_and_parts():
    assert last_user_text(M) == "What is Redis?"
    parts = [
        {"role": "user", "content": [
            {"type": "text", "text": "part one"},
            {"type": "text", "text": "part two"},
        ]}
    ]
    assert last_user_text(parts) == "part one\npart two"


def test_last_user_text_returns_none_without_text():
    assert last_user_text([{"role": "assistant", "content": "hi"}]) is None
    assert last_user_text([{"role": "user", "content": ""}]) is None
    assert last_user_text([
        {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "x"}}]}
    ]) is None


def test_normalize_and_doc_key():
    assert normalize_prompt_text("  What   is Redis? ") == "What is Redis?"
    assert semantic_doc_key("m", "What   is Redis?") == semantic_doc_key("m", "What is Redis?")
    assert semantic_doc_key("m", "What is Redis?") != semantic_doc_key("m", "What is Docker?")
