import json
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from unittest.mock import patch
import wave

import pytest

from ytwhisper.cues import make_cues
from ytwhisper.transcriber import Transcriber, validate_result
from ytwhisper.whisper_worker import main


def test_mlx_instantaneous_words_survive_worker_validation_and_cue_generation(tmp_path):
    # Exercise upstream-shaped segments through the real worker and validator.
    fixture = json.loads((Path(__file__).parent / "fixtures/mlx_instantaneous_words.json").read_text())
    audio = tmp_path / "audio.wav"
    with wave.open(str(audio), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\x00\x00" * 32000)

    class WorkerRunner:
        def run(self, command, on_progress, cancel_event):
            with patch.dict("sys.modules", {"mlx_whisper": SimpleNamespace(transcribe=lambda *a, **k: fixture)}):
                main(command[3:])

    result = Transcriber(WorkerRunner()).transcribe(audio, tmp_path / "result.json", Event())
    cues = make_cues(result["words"])
    assert cues == [{"startMs": 0, "endMs": 1400, "text": "Well, this is a test."}]
    assert all(cue["endMs"] > cue["startMs"] for cue in cues)


@pytest.mark.parametrize("words", [
    [{"start": 1, "end": 0.5, "word": "backward"}],
    [{"start": float("nan"), "end": 1, "word": "nan"}],
    [{"start": 0, "end": float("inf"), "word": "infinite"}],
    [{"start": 0, "end": 1, "word": "first"}, {"start": 0.5, "end": 0.5, "word": "overlap"}],
    [{"start": 0.5, "end": 0.5, "word": "no timed neighbor"}],
])
def test_normalization_still_rejects_malformed_or_untimed_results(words):
    with pytest.raises(ValueError):
        validate_result({"language": "en", "duration": 2, "words": words})
