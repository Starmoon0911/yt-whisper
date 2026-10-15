import unittest

from ytwhisper.youtube import UnsupportedVideoUrl, normalize_watch_url


class NormalizeWatchUrlTests(unittest.TestCase):
    def test_keeps_only_the_public_video_identity(self):
        cases = [
            ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
            ("https://youtu.be/dQw4w9WgXcQ?t=42", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
            ("https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=abc", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
        ]
        for url, expected in cases:
            with self.subTest(url=url):
                self.assertEqual(normalize_watch_url(url, "dQw4w9WgXcQ"), expected)


    def test_rejects_non_watch_or_mismatched_urls(self):
        urls = [
            "https://example.com/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com/live/dQw4w9WgXcQ",
            "file:///tmp/audio.wav",
            "https://www.youtube.com/watch?v=anotherId00",
        ]
        for url in urls:
            with self.subTest(url=url), self.assertRaises(UnsupportedVideoUrl):
                normalize_watch_url(url, "dQw4w9WgXcQ")

    def test_rejects_ambiguous_or_untrusted_url_authorities(self):
        # Catches accepting credentials, custom ports, duplicate IDs or lookalike hosts.
        urls = [
            "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
            "https://user:secret@www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com:bad/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&v=anotherId00",
        ]
        for url in urls:
            with self.subTest(url=url), self.assertRaises(UnsupportedVideoUrl):
                normalize_watch_url(url, "dQw4w9WgXcQ")

    def test_rejects_invalid_video_ids_even_when_the_expected_id_matches(self):
        # Catches normalization allowing malformed IDs into downloader/cache requests.
        for video_id in ("short", "a" * 12, "bad/id00000", "aaaaaaaaaa!"):
            with self.subTest(video_id=video_id), self.assertRaises(UnsupportedVideoUrl):
                normalize_watch_url(f"https://youtu.be/{video_id}", video_id)

