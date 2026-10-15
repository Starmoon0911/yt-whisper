import json
import math
import sys
from pathlib import Path
from threading import Event
from typing import Any, TypedDict, cast


MODEL = "mlx-community/whisper-large-v3-turbo"


class WhisperResult(TypedDict):
    language: str
    duration: float
    words: list[dict[str, Any]]


def _finite_number(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def validate_result(value: Any) -> WhisperResult:
    """Reject incomplete or unrenderable worker output before cache publication."""
    if not isinstance(value, dict):
        raise ValueError("Whisper output must be an object")
    language = value.get("language")
    duration = value.get("duration")
    words = value.get("words")
    if not isinstance(language, str) or not language.strip():
        raise ValueError("Whisper output is missing the detected language")
    if not _finite_number(duration) or duration <= 0:
        raise ValueError("Whisper output has an invalid audio duration")
    if not isinstance(words, list):
        raise ValueError("Whisper output is missing word timestamps")
    previous_end = 0.0
    normalized: list[dict[str, Any]] = []
    leading_text = ""
    for word in words:
        if not isinstance(word, dict) or not isinstance(word.get("word"), str):
            raise ValueError("Whisper output has an invalid word")
        start, end = word.get("start"), word.get("end")
        if (
            not _finite_number(start) or not _finite_number(end)
            or start < previous_end or end < start or end > duration
            or (end != start and round(end * 1000) <= round(start * 1000))
        ):
            raise ValueError("Whisper output has invalid or overlapping word timestamps")
        previous_end = end
        # MLX alignment can place a real word at an instantaneous boundary.
        # Preserve its text on a timed neighbor, without inventing an interval.
        if start == end:
            if normalized:
                normalized[-1]["word"] += word["word"]
            else:
                leading_text += word["word"]
        else:
            normalized.append({**word, "word": leading_text + word["word"]})
            leading_text = ""
    if leading_text.strip():
        raise ValueError("Whisper words have no timed neighbor")
    return cast(WhisperResult, {**value, "words": normalized})


class Transcriber:
    def __init__(self, runner):
        self.runner = runner

    def transcribe(self, audio_path: Path, output_path: Path, cancel_event: Event) -> WhisperResult:
        self.runner.run(
            [sys.executable, "-m", "ytwhisper.whisper_worker", "--audio", str(audio_path),
             "--output", str(output_path)],
            lambda progress: None,
            cancel_event,
        )
        return validate_result(json.loads(output_path.read_text(encoding="utf-8")))
