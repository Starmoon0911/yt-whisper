"""Subprocess entry point: MLX is imported only inside this worker."""

import argparse
import json
import wave
from pathlib import Path

from .transcriber import MODEL


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args(argv)

    import mlx_whisper

    result = mlx_whisper.transcribe(
        str(arguments.audio), path_or_hf_repo=MODEL, word_timestamps=True,
        task="transcribe", language=None,
    )
    with wave.open(str(arguments.audio), "rb") as audio:
        duration = audio.getnframes() / audio.getframerate()
    output = {
        "language": result["language"],
        "duration": duration,
        "words": [word for segment in result["segments"] for word in segment["words"]],
    }
    arguments.output.write_text(json.dumps(output, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
