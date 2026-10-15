import shutil
import tempfile
from concurrent.futures import CancelledError
from dataclasses import dataclass, field
from pathlib import Path
from queue import Queue
from threading import Event, RLock, Thread
from uuid import uuid4

from .cache import CacheStore
from .models import ApiError, JobRequest, JobSnapshot
from .pipeline import MediaPipeline, MissingJsRuntime
from .transcriber import MODEL

_TERMINAL = {"completed", "failed", "canceled"}


@dataclass
class _Job:
    request: JobRequest
    snapshot: JobSnapshot
    cancel_event: Event = field(default_factory=Event)
    finished: Event = field(default_factory=Event)


class JobManager:
    """Own one worker thread, its queue, and all per-job temporary directories."""

    def __init__(self, cache: CacheStore, pipeline: MediaPipeline | None, work_dir: Path):
        self.cache = cache
        self.pipeline = pipeline if pipeline is not None else MediaPipeline(cache)
        self.work_dir = work_dir
        self._lock = RLock()
        self._jobs: dict[str, _Job] = {}
        self._active: dict[tuple[str, str], str] = {}
        self._queue: Queue[str | None] = Queue()
        self._closed = False
        self._worker = Thread(target=self._run, name="ytwhisper-worker", daemon=True)
        self._worker.start()

    def create(self, request: JobRequest | dict) -> tuple[JobSnapshot, bool]:
        request = JobRequest.model_validate(request).model_copy(deep=True)
        key = (request.videoId, MODEL)
        with self._lock:
            if self._closed:
                raise RuntimeError("Job manager is closed")
            active_id = self._active.get(key)
            if active_id is not None:
                active = self._jobs[active_id]
                if not active.cancel_event.is_set():
                    return active.snapshot.model_copy(deep=True), False
            document = None if request.force else self.cache.load(
                request.videoId, request.durationMs, MODEL,
            )
            status = "completed" if document is not None else "queued"
            snapshot = JobSnapshot(
                jobId=uuid4().hex, videoId=request.videoId, status=status, stage=status,
                result=document,
            )
            job = _Job(request, snapshot)
            self._jobs[snapshot.jobId] = job
            if document is not None:
                job.finished.set()
            else:
                self._active[key] = snapshot.jobId
                self._queue.put(snapshot.jobId)
            return snapshot.model_copy(deep=True), document is not None

    def get(self, job_id: str) -> JobSnapshot:
        with self._lock:
            return self._jobs[job_id].snapshot.model_copy(deep=True)

    def cancel(self, job_id: str) -> JobSnapshot:
        with self._lock:
            job = self._jobs[job_id]
            if job.snapshot.status in _TERMINAL:
                return job.snapshot.model_copy(deep=True)
            job.cancel_event.set()
            if job.snapshot.status == "queued":
                self._finish(job, "canceled")
        # The pipeline owns the publication boundary: a returned document has
        # already committed; CancelledError guarantees no new cache publication.
        # Wait for cleanup so DELETE cannot report a contradictory terminal state.
        job.finished.wait()
        return self.get(job_id)

    def close(self) -> None:
        with self._lock:
            if not self._closed:
                self._closed = True
                for job in self._jobs.values():
                    if job.snapshot.status not in _TERMINAL:
                        job.cancel_event.set()
                        if job.snapshot.status == "queued":
                            self._finish(job, "canceled")
                self._queue.put(None)
        self._worker.join()

    def _finish(self, job: _Job, status: str, *, result=None, error=None) -> None:
        job.snapshot = job.snapshot.model_copy(update={
            "status": status, "stage": status, "result": result, "error": error,
        })
        key = (job.request.videoId, MODEL)
        if self._active.get(key) == job.snapshot.jobId:
            del self._active[key]
        job.finished.set()

    def _run(self) -> None:
        while (job_id := self._queue.get()) is not None:
            with self._lock:
                job = self._jobs[job_id]
                if job.snapshot.status in _TERMINAL:
                    continue
                job.snapshot = job.snapshot.model_copy(update={
                    "status": "downloading", "stage": "downloading",
                })
            work_dir = None
            result = error = None
            status = "failed"

            def on_state(state: str, job: _Job = job) -> None:
                if state not in {"downloading", "converting", "transcribing"}:
                    raise ValueError("Invalid pipeline stage")
                with self._lock:
                    job.snapshot = job.snapshot.model_copy(update={"status": state, "stage": state})

            try:
                self.work_dir.mkdir(parents=True, exist_ok=True)
                work_dir = Path(tempfile.mkdtemp(prefix=f"{job_id}-", dir=self.work_dir))
                result = self.pipeline.process(
                    job.request.model_dump(exclude={"force"}), work_dir, on_state, job.cancel_event,
                )
                status = "completed"
            except CancelledError:
                status = "canceled"
            except Exception as exception:  # noqa: BLE001 - each failed job must release the worker.
                error = _pipeline_error(exception, job.snapshot.stage)
            finally:
                # MediaPipeline cleans its own paths; this also covers injected
                # pipelines and errors that occur before pipeline setup finishes.
                if work_dir is not None:
                    shutil.rmtree(work_dir, ignore_errors=True)
                with self._lock:
                    self._finish(job, status, result=result, error=error)


def _pipeline_error(error: Exception, stage: str) -> ApiError:
    if isinstance(error, MissingJsRuntime):
        return ApiError(
            code="JS_RUNTIME_MISSING",
            message="Install Deno or Node.js to download YouTube audio, then restart the local "
                    "service.",
            retryable=False,
        )
    if isinstance(error, FileNotFoundError) and stage == "converting":
        return ApiError(code="FFMPEG_NOT_FOUND", message="Install ffmpeg and restart the service.",
                        retryable=False)
    errors = {
        "downloading": ("DOWNLOAD_FAILED", "Could not download this public YouTube video."),
        "converting": ("CONVERSION_FAILED", "Could not convert the downloaded audio."),
        "transcribing": ("TRANSCRIPTION_FAILED", "Could not load the model or transcribe audio."),
    }
    code, message = errors.get(stage, ("PIPELINE_FAILED", "Subtitle generation failed."))
    return ApiError(code=code, message=message, retryable=True)
