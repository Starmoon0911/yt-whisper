import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Literal, TypedDict

from .cues import SubtitleCue


class SubtitleDocument(TypedDict):
    schemaVersion: Literal[1]
    videoId: str
    language: str
    durationMs: int
    model: str
    generatedAt: str
    cues: list[SubtitleCue]


SCHEMA_VERSION = 1
_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


class CacheStore:
    def __init__(self, directory: Path):
        self.directory = directory

    def path_for(self, video_id: str) -> Path:
        if not _VIDEO_ID.fullmatch(video_id):
            raise ValueError("Invalid YouTube video ID")
        return self.directory / f"{video_id}.json"

    def load(self, video_id: str, duration_ms: int, model: str) -> SubtitleDocument | None:
        try:
            document = json.loads(self.path_for(video_id).read_text(encoding="utf-8"))
        except (OSError, TypeError, UnicodeError, json.JSONDecodeError):
            return None

        if not isinstance(document, dict):
            return None
        if (
            type(document.get("schemaVersion")) is not int
            or document["schemaVersion"] != SCHEMA_VERSION
        ):
            return None
        if document.get("videoId") != video_id or document.get("model") != model:
            return None
        if type(document.get("durationMs")) is not int:
            return None
        if abs(document["durationMs"] - duration_ms) > 2000:
            return None
        if any(
            not isinstance(document.get(key), str) or not document[key].strip()
            for key in ("language", "generatedAt")
        ):
            return None
        if not isinstance(document.get("cues"), list):
            return None
        previous_end = 0
        for cue in document["cues"]:
            if not isinstance(cue, dict):
                return None
            start, end, text = cue.get("startMs"), cue.get("endMs"), cue.get("text")
            if type(start) is not int or type(end) is not int:
                return None
            if start < previous_end or end <= start:
                return None
            if not isinstance(text, str) or not text.strip():
                return None
            previous_end = end
        return document

    def store(self, document: dict[str, Any]) -> None:
        path = self.path_for(str(document["videoId"]))
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.stem}-", suffix=".tmp", dir=path.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(document, handle, ensure_ascii=False, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
