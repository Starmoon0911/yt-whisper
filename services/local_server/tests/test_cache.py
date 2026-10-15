import json
import tempfile
import unittest
from pathlib import Path

from ytwhisper.cache import CacheStore


DOCUMENT = {
    "schemaVersion": 1,
    "videoId": "dQw4w9WgXcQ",
    "language": "en",
    "durationMs": 10000,
    "model": "mlx-community/whisper-large-v3-turbo",
    "generatedAt": "2026-10-15T12:00:00Z",
    "cues": [{"startMs": 0, "endMs": 900, "text": "Hello"}],
}


class CacheStoreTests(unittest.TestCase):
    def test_load_returns_matching_document(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = CacheStore(Path(directory))
            cache.store(DOCUMENT)

            loaded = cache.load(
                "dQw4w9WgXcQ",
                duration_ms=11500,
                model="mlx-community/whisper-large-v3-turbo",
            )

            self.assertEqual(loaded, DOCUMENT)

    def test_load_rejects_wrong_model_schema_or_duration(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = CacheStore(Path(directory))
            cache.store(DOCUMENT)

            self.assertIsNone(cache.load("dQw4w9WgXcQ", 13000, DOCUMENT["model"]))
            self.assertIsNone(cache.load("dQw4w9WgXcQ", 10000, "another-model"))

            incompatible = {**DOCUMENT, "schemaVersion": 0}
            cache.path_for("dQw4w9WgXcQ").write_text(__import__("json").dumps(incompatible))
            self.assertIsNone(cache.load("dQw4w9WgXcQ", 10000, DOCUMENT["model"]))

    def test_corrupt_cache_is_treated_as_a_miss(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = CacheStore(Path(directory))
            cache.path_for("dQw4w9WgXcQ").write_text("not-json")

            self.assertIsNone(cache.load("dQw4w9WgXcQ", 10000, DOCUMENT["model"]))

    def test_malformed_documents_cannot_be_loaded_as_complete_subtitles(self):
        # Catches accepting incomplete JSON or crashing on malformed cached fields.
        malformed = [None, [], 1, {**DOCUMENT, "durationMs": "invalid"},
                     {**DOCUMENT, "durationMs": None}, {**DOCUMENT, "durationMs": True},
                     {**DOCUMENT, "schemaVersion": True},
                     {key: value for key, value in DOCUMENT.items() if key != "language"},
                     {**DOCUMENT, "generatedAt": ""}]
        bad_cues = [None, {}, {"startMs": 0, "endMs": 900},
                    {"startMs": -1, "endMs": 900, "text": "Hello"},
                    {"startMs": 900, "endMs": 900, "text": "Hello"},
                    {"startMs": 0, "endMs": 900, "text": " "},
                    {"startMs": "0", "endMs": 900, "text": "Hello"}]
        malformed.extend({**DOCUMENT, "cues": [cue]} for cue in bad_cues)
        malformed.append({**DOCUMENT, "cues": [
            {"startMs": 500, "endMs": 900, "text": "First"},
            {"startMs": 800, "endMs": 1000, "text": "Overlap"},
        ]})
        with tempfile.TemporaryDirectory() as directory:
            cache = CacheStore(Path(directory))
            for document in malformed:
                with self.subTest(document=document):
                    cache.path_for(DOCUMENT["videoId"]).write_text(json.dumps(document))
                    self.assertIsNone(cache.load(DOCUMENT["videoId"], 10000, DOCUMENT["model"]))
            cache.path_for(DOCUMENT["videoId"]).write_bytes(b"\xff")
            self.assertIsNone(cache.load(DOCUMENT["videoId"], 10000, DOCUMENT["model"]))

    def test_duration_tolerance_includes_exactly_two_seconds(self):
        # Catches an off-by-one duration check invalidating a reusable transcript.
        with tempfile.TemporaryDirectory() as directory:
            cache = CacheStore(Path(directory))
            cache.store(DOCUMENT)
            for duration in (8000, 12000):
                self.assertEqual(cache.load(DOCUMENT["videoId"], duration, DOCUMENT["model"]), DOCUMENT)
            for duration in (7999, 12001):
                self.assertIsNone(cache.load(DOCUMENT["videoId"], duration, DOCUMENT["model"]))
