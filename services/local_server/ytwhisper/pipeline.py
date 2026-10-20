import shutil
import sys
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from threading import Event
from typing import TypedDict

from .cache import CacheStore, SubtitleDocument
from .cues import make_cues
from .media import CommandRunner, check_cancelled
from .transcriber import MODEL, Transcriber
from .youtube import normalize_watch_url

JS_RUNTIMES = ("deno", "node", "bun", "quickjs", "qjs")

# A fixed prefix plus numeric fields keeps the progress parser independent of the
# terminal renderer. ``--print`` forces quiet mode, so ``--progress`` is required
# for these lines to be emitted at all; ``--newline`` keeps them one-per-line.
PROGRESS_TEMPLATE = (
    "PROG %(progress.downloaded_bytes)s %(progress.total_bytes)s "
    "%(progress.total_bytes_estimate)s %(progress.speed)s"
)


class MissingJsRuntime(RuntimeError):
    """Raised when yt-dlp has no JavaScript runtime to solve YouTube challenges."""


def _progress_value(token: str) -> float | None:
    return None if token == "NA" else float(token)


def parse_progress_line(line: str) -> tuple[float | None, float | None] | None:
    """Return ``(progress, speed)`` from a live progress line, or None if not one.

    ``progress`` is the downloaded/total ratio falling back to the estimated total
    (common for adaptive streams); ``speed`` is yt-dlp's native bytes/s. Unknown
    fields are None and malformed lines are ignored rather than raising.
    """
    if not line.startswith("PROG "):
        return None
    fields = line[len("PROG "):].split()
    if len(fields) != 4:
        return None
    try:
        downloaded, total, estimate, speed = (_progress_value(field) for field in fields)
    except ValueError:
        return None
    denominator = total if total is not None else estimate
    progress = None
    if downloaded is not None and denominator is not None and denominator > 0:
        progress = min(max(downloaded / denominator, 0.0), 1.0)
    return progress, speed


def js_runtime_args() -> list[str]:
    """Enable the first JavaScript runtime available for yt-dlp's YouTube extractor."""
    for runtime in JS_RUNTIMES:
        if shutil.which(runtime):
            return ["--js-runtimes", runtime]
    raise MissingJsRuntime("Deno or another JavaScript runtime is required for downloads")


def _download_observer(
    download_progress: Callable[[float | None, float | None], None] | None,
) -> Callable[[str], None]:
    """Translate CommandRunner output into live progress calls.

    Streaming hands over each stdout line on its own and then the full output once;
    only the single lines matter here, so the final dump cannot duplicate updates.
    """
    if download_progress is None:
        return lambda _text: None

    def observe(text: str) -> None:
        if "\n" in text:
            return
        parsed = parse_progress_line(text)
        if parsed is not None:
            download_progress(*parsed)

    return observe


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
        cancel_event: Event, *,
        download_progress: Callable[[float | None, float | None], None] | None = None,
    ) -> SubtitleDocument:
        """Own a new or empty per-job directory, including on invalid requests."""
        if work_dir.is_symlink() or (
            work_dir.exists() and (not work_dir.is_dir() or any(work_dir.iterdir()))
        ):
            raise ValueError("Work directory must be new or empty")
        work_dir.mkdir(parents=True, exist_ok=True)
        try:
            url = normalize_watch_url(request["url"], request["videoId"])
            check_cancelled(cancel_event)
            on_state("downloading")
            check_cancelled(cancel_event)
            downloaded = self.runner.run(
                [sys.executable, "-m", "yt_dlp", "--ignore-config", *js_runtime_args(),
                 "--no-playlist", "--progress", "--newline", "--progress-template",
                 PROGRESS_TEMPLATE, "--match-filter", "!is_live", "--format", "bestaudio",
                 "--output", str(work_dir / "source.%(ext)s"), "--print",
                 "after_move:filepath", url],
                _download_observer(download_progress),
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
            check_cancelled(cancel_event)
            self.cache.store(document, cancel_event=cancel_event)
            return document
        finally:
            shutil.rmtree(work_dir)
