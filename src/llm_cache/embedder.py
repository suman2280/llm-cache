"""In-process sentence-transformers embedder (MiniLM-L6-v2, 384-d).

Kept in-process rather than calling Ollama's /v1/embeddings so the semantic
tier never competes with llama3.2:3b for the same CPU while it generates, and
so the cache is usable even when Ollama is busy or restarting.
"""

from __future__ import annotations

import numpy as np


class Embedder:
    def __init__(self, model_name: str) -> None:
        from sentence_transformers import SentenceTransformer

        self.model_name = model_name
        self._model = SentenceTransformer(model_name)
        # Deterministic warm-up: loads weights/kernels and pins the dim.
        self.dim = int(self._model.get_sentence_embedding_dimension())
        self._model.encode(["warm-up"], normalize_embeddings=True)

    def embed(self, text: str) -> np.ndarray:
        vec = self._model.encode([text], normalize_embeddings=True, convert_to_numpy=True)[0]
        return vec.astype(np.float32)

    def embed_many(self, texts: list[str]) -> np.ndarray:
        vecs = self._model.encode(texts, normalize_embeddings=True, convert_to_numpy=True)
        return vecs.astype(np.float32)

    @staticmethod
    def to_bytes(vec: np.ndarray) -> bytes:
        """FLOAT32 little-endian bytes for Redis binary vector params."""
        return np.asarray(vec, dtype=np.float32).tobytes()
