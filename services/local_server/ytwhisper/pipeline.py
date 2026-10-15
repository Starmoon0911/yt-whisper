import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from threading import Event
from typing import Callable, TypedDict

from .cache import CacheStore, SubtitleDocument
from .cues import make_cues
from .media import CommandRunner, check_cancelled
from .transcriber import MODEL, Transcriber
from .youtube import normalize_watch_url


class PipelineRequest(TypedDict):
    url: str
    videoId: str
    durationMs: int


class MediaPipeline:
    def __init__(self, cache: CacheStore, *, runner=None, transcriber=None):
        self.cache = cache
        self.runner = runner if runner is not None else CommandRunner()
        self.transcriber = transcriber if transcriber is not None else Transcriber(self.runner)

    def process(
        self, request: PipelineRequest, work_dir: Path, on_state: Callable[[str], None],
        cancel_event: Event,
    ) -> SubtitleDocument:
        url = normalize_watch_url(request["url"], request["videoId"])
        if work_dir.is_symlink() or (
            work_dir.exists() and (not work_dir.is_dir() or any(work_dir.iterdir()))
        ):
            raise ValueError("Work directory must be new or empty")
        work_dir.mkdir(parents=True, exist_ok=True)
        try:
            check_cancelled(cancel_event)
            on_state("downloading")
            check_cancelled(cancel_event)
            downloaded = self.runner.run(
                [sys.executable, "-m", "yt_dlp", "--no-playlist", "--no-progress",
                 "--match-filter", "!is_live", "--format", "bestaudio", "--output",
                 str(work_dir / "source.%(ext)s"), "--print", "after_move:filepath", url],
                lambda progress: None,
                cancel_event,
            )
            check_cancelled(cancel_event)
            source = Path(downloaded.stdout.strip().splitlines()[-1])
            audio = work_dir / "audio.wav"
            on_state("converting")
            check_cancelled(cancel_event)
            self.runner.run(
                ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i",
                 str(source), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
                 str(audio)],
                lambda progress: None,
                cancel_event,
            )
            check_cancelled(cancel_event)
            on_state("transcribing")
            check_cancelled(cancel_event)
            result = self.transcriber.transcribe(audio, work_dir / "whisper.json", cancel_event)
            check_cancelled(cancel_event)
            document: SubtitleDocument = {
                "schemaVersion": 1,
                "videoId": request["videoId"],
                "language": result["language"],
                "durationMs": round(result["duration"] * 1000),
                "model": MODEL,
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "cues": make_cues(result["words"]),
            }
            self.cache.store(document)
            return document
        finally:
            shutil.rmtree(work_dir)
