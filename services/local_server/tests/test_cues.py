import tempfile
import unittest
from pathlib import Path

from ytwhisper.cache import CacheStore
from ytwhisper.cues import make_cues


class MakeCuesTests(unittest.TestCase):
    def test_clamps_one_overlong_word_without_duplicating_its_text(self):
        # Catches the duration guard skipping a word when the group is empty.
        self.assertEqual(make_cues([
            {"word": "Hello", "start": 0.0, "end": 7.0},
        ]), [{"startMs": 0, "endMs": 6000, "text": "Hello"}])

    def test_splits_one_overwide_cjk_token_with_proportional_timestamps(self):
        # Catches emitting one 86-column token despite the 84-column limit.
        self.assertEqual(make_cues([
            {"word": "中" * 43, "start": 1.0, "end": 3.0},
        ]), [
            {"startMs": 1000, "endMs": 2953, "text": "中" * 42},
            {"startMs": 2953, "endMs": 3000, "text": "中"},
        ])

    def test_split_and_clamped_pieces_remain_nonoverlapping_and_cacheable(self):
        # Catches splitting that duplicates text, overlaps cues or yields invalid cache data.
        cues = make_cues([
            {"word": "中" * 42 + "。", "start": 1.0, "end": 8.0},
            {"word": " Next.", "start": 8.0, "end": 8.5},
        ])
        self.assertEqual(cues, [
            {"startMs": 1000, "endMs": 7000, "text": "中" * 42},
            {"startMs": 7837, "endMs": 8000, "text": "。"},
            {"startMs": 8000, "endMs": 8500, "text": "Next."},
        ])
        document = {
            "schemaVersion": 1, "videoId": "dQw4w9WgXcQ", "language": "zh",
            "durationMs": 8500, "model": "mlx-community/whisper-large-v3-turbo",
            "generatedAt": "2026-10-15T12:00:00Z", "cues": cues,
        }
        with tempfile.TemporaryDirectory() as directory:
            cache = CacheStore(Path(directory))
            cache.store(document)
            self.assertEqual(cache.load("dQw4w9WgXcQ", 8500, document["model"]), document)

    def test_six_second_limit_keeps_exact_boundary_and_splits_before_overflow(self):
        # Catches dropping the exact duration boundary or merging beyond six seconds.
        words = [
            {"word": " One", "start": 0.0, "end": 3.0},
            {"word": " two", "start": 3.0, "end": 6.0},
            {"word": " three", "start": 6.0, "end": 6.5},
        ]
        self.assertEqual(make_cues(words), [
            {"startMs": 0, "endMs": 6000, "text": "One two"},
            {"startMs": 6000, "endMs": 6500, "text": "three"},
        ])

    def test_cjk_width_accepts_the_exact_limit_before_splitting(self):
        # Catches counting CJK glyphs as one column or splitting at equality.
        words = [
            {"word": "中文", "start": 0.0, "end": 0.5},
            {"word": "字幕", "start": 0.5, "end": 1.0},
            {"word": "好", "start": 1.0, "end": 1.5},
        ]
        self.assertEqual(make_cues(words, max_display_width=8), [
            {"startMs": 0, "endMs": 1000, "text": "中文字幕"},
            {"startMs": 1000, "endMs": 1500, "text": "好"},
        ])

    def test_splits_long_words_at_punctuation_with_word_times(self):
        words = [
            {"word": " Hello", "start": 0.0, "end": 0.4},
            {"word": " world.", "start": 0.4, "end": 0.9},
            {"word": " This", "start": 1.0, "end": 1.3},
            {"word": " is", "start": 1.3, "end": 1.5},
            {"word": " next.", "start": 1.5, "end": 2.0},
        ]

        self.assertEqual(make_cues(words, max_duration_s=6, max_display_width=84), [
            {"startMs": 0, "endMs": 900, "text": "Hello world."},
            {"startMs": 1000, "endMs": 2000, "text": "This is next."},
        ])


    def test_splits_cjk_by_display_width_and_never_emits_empty_text(self):
        words = [
            {"word": "這是一段", "start": 0.0, "end": 0.8},
            {"word": "很長的中文", "start": 0.8, "end": 1.6},
            {"word": "字幕", "start": 1.6, "end": 2.0},
            {"word": " ", "start": 2.0, "end": 2.1},
        ]

        self.assertEqual(make_cues(words, max_duration_s=6, max_display_width=12), [
            {"startMs": 0, "endMs": 800, "text": "這是一段"},
            {"startMs": 800, "endMs": 1600, "text": "很長的中文"},
            {"startMs": 1600, "endMs": 2000, "text": "字幕"},
        ])

