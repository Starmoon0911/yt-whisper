import copy
import subprocess
import threading
import time
from concurrent.futures import CancelledError

import pytest
from ytwhisper.cache import CacheStore
from ytwhisper.pipeline import MissingJsRuntime

VIDEO_ID = "dQw4w9WgXcQ"
OTHER_ID = "abcdefghijk"
MODEL = "mlx-community/whisper-large-v3-turbo"
REQUEST = {"url": f"https://youtu.be/{VIDEO_ID}", "videoId": VIDEO_ID, "durationMs": 10000}
DOCUMENT = {
    "schemaVersion": 1, "videoId": VIDEO_ID, "language": "en", "durationMs": 10000,
    "model": MODEL, "generatedAt": "2026-10-15T00:00:00Z",
    "cues": [{"startMs": 0, "endMs": 900, "text": "Hello"}],
}


class ControlledPipeline:
    """Control only external media work; exercise the real queue and cache."""

    def __init__(self, cache, *, fail=None, committed=False, failure_stage="downloading",
                 report=None):
        self.cache = cache
        self.fail = fail
        self.committed = committed
        self.failure_stage = failure_stage
        self.report = report
        self.started = threading.Event()
        self.release = threading.Event()
        self.calls = []
        self.active = 0
        self.max_active = 0

    def process(self, request, work_dir, on_state, cancel_event, download_progress=None):
        self.cancel_event = cancel_event
        self.calls.append(request)
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        work_dir.mkdir(parents=True, exist_ok=True)
        (work_dir / "audio.wav").write_bytes(b"temporary media")
        try:
            on_state("downloading")
            if self.report is not None and download_progress is not None:
                download_progress(*self.report)
            document = {**copy.deepcopy(DOCUMENT), "videoId": request["videoId"]}
            if self.committed:
                self.cache.store(document, cancel_event=cancel_event)
            self.started.set()
            assert self.release.wait(3), "test did not release pipeline"
            if self.committed:
                return document
            if cancel_event.is_set():
                raise CancelledError()
            if self.fail:
                on_state(self.failure_stage)
                raise self.fail
            on_state("converting")
            on_state("transcribing")
            self.cache.store(document, cancel_event=cancel_event)
            return document
        finally:
            self.active -= 1


def wait_terminal(manager, job_id):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        snapshot = manager.get(job_id)
        if snapshot.status in {"completed", "canceled", "failed"}:
            return snapshot
        time.sleep(0.005)
    raise AssertionError("job did not reach a terminal state")


@pytest.fixture
def setup_jobs(tmp_path):
    from ytwhisper.jobs import JobManager

    managers = []

    def make(**options):
        cache = CacheStore(tmp_path / f"cache-{len(managers)}")
        pipeline = ControlledPipeline(cache, **options)
        manager = JobManager(cache, pipeline, tmp_path / f"work-{len(managers)}")
        managers.append((manager, pipeline))
        return manager, pipeline, cache

    yield make
    for manager, pipeline in managers:
        pipeline.release.set()
        manager.close()


def test_queue_serializes_actual_work_and_deduplicates_same_video_model(setup_jobs):
    # A second worker or missing active-key lookup breaks serialization/deduplication.
    manager, pipeline, _ = setup_jobs()
    first, cache_hit = manager.create(REQUEST)
    assert not cache_hit
    assert pipeline.started.wait(1)
    duplicate, hit = manager.create({**REQUEST, "force": True})
    second, _ = manager.create({**REQUEST, "videoId": OTHER_ID,
                                "url": f"https://youtu.be/{OTHER_ID}"})
    assert duplicate.jobId == first.jobId
    assert not hit
    assert second.status == "queued"
    assert len(pipeline.calls) == 1
    pipeline.release.set()
    assert wait_terminal(manager, first.jobId).status == "completed"
    assert wait_terminal(manager, second.jobId).status == "completed"
    assert pipeline.max_active == 1
    assert [request["videoId"] for request in pipeline.calls] == [VIDEO_ID, OTHER_ID]
    assert pipeline.calls[0]["url"] == f"https://www.youtube.com/watch?v={VIDEO_ID}"


def test_cache_hit_skips_media_but_force_regenerates(setup_jobs):
    # Ignoring cache validation or the force flag changes observable work/results.
    manager, pipeline, cache = setup_jobs()
    cache.store(DOCUMENT)
    hit, cached = manager.create(REQUEST)
    assert cached
    assert hit.status == hit.stage == "completed"
    assert hit.result == DOCUMENT
    assert not pipeline.started.is_set()
    fresh, cached = manager.create({**REQUEST, "force": True})
    assert not cached
    assert fresh.jobId != hit.jobId
    assert pipeline.started.wait(1)


def test_stale_duration_is_not_a_cache_hit(setup_jobs):
    manager, pipeline, cache = setup_jobs()
    cache.store({**DOCUMENT, "durationMs": 12001})
    job, cached = manager.create(REQUEST)
    assert not cached
    assert pipeline.started.wait(1)
    assert manager.get(job.jobId).status == "downloading"


def test_queued_cancellation_does_not_run_media_and_can_be_recreated(setup_jobs):
    manager, pipeline, _ = setup_jobs()
    manager.create(REQUEST)
    assert pipeline.started.wait(1)
    request = {**REQUEST, "videoId": OTHER_ID, "url": f"https://youtu.be/{OTHER_ID}"}
    queued, _ = manager.create(request)
    canceled = manager.cancel(queued.jobId)
    assert canceled.status == canceled.stage == "canceled"
    assert canceled.result is None
    replacement, _ = manager.create(request)
    assert replacement.jobId != queued.jobId
    pipeline.release.set()
    assert wait_terminal(manager, replacement.jobId).status == "completed"
    assert [request["videoId"] for request in pipeline.calls] == [VIDEO_ID, OTHER_ID]


def test_running_cancellation_waits_for_cleanup_and_never_publishes_result(setup_jobs, tmp_path):
    manager, pipeline, cache = setup_jobs()
    job, _ = manager.create(REQUEST)
    assert pipeline.started.wait(1)
    outcomes = []
    cancellation = threading.Thread(target=lambda: outcomes.append(manager.cancel(job.jobId)))
    cancellation.start()
    assert pipeline.cancel_event.wait(1)
    pipeline.release.set()
    cancellation.join(2)
    assert not cancellation.is_alive()
    assert outcomes[0].status == "canceled"
    assert outcomes[0].result is None
    assert cache.load(VIDEO_ID, 10000, MODEL) is None
    assert not list((tmp_path / "work-0").glob("*"))
    assert manager.cancel(job.jobId).status == "canceled"


def test_cancel_after_publication_keeps_committed_completion(setup_jobs):
    # A post-process event check would mislabel a successfully published cache canceled.
    manager, pipeline, cache = setup_jobs(committed=True)
    job, _ = manager.create(REQUEST)
    assert pipeline.started.wait(1)
    outcomes = []
    cancellation = threading.Thread(target=lambda: outcomes.append(manager.cancel(job.jobId)))
    cancellation.start()
    assert pipeline.cancel_event.wait(1)
    pipeline.release.set()
    cancellation.join(2)
    assert not cancellation.is_alive()
    assert outcomes[0].status == "completed"
    assert outcomes[0].result == cache.load(VIDEO_ID, 10000, MODEL) == DOCUMENT


def test_failed_job_exposes_actionable_error_and_worker_continues(setup_jobs, tmp_path):
    manager, pipeline, _ = setup_jobs(fail=subprocess.CalledProcessError(1, ["yt-dlp"]))
    first, _ = manager.create(REQUEST)
    assert pipeline.started.wait(1)
    pipeline.release.set()
    failed = wait_terminal(manager, first.jobId)
    assert failed.status == failed.stage == "failed"
    assert failed.error.model_dump() == {
        "code": "DOWNLOAD_FAILED", "message": "Could not download this public YouTube video.",
        "retryable": True,
    }
    assert failed.result is None
    assert not list((tmp_path / "work-0").glob("*"))
    pipeline.fail = None
    replacement, _ = manager.create(REQUEST)
    assert replacement.jobId != first.jobId
    assert wait_terminal(manager, replacement.jobId).status == "completed"


def test_snapshots_are_independent_copies_and_unknown_ids_raise(setup_jobs):
    manager, _, cache = setup_jobs()
    cache.store(DOCUMENT)
    job, _ = manager.create(REQUEST)
    job.result["cues"][0]["text"] = "changed by client"
    assert manager.get(job.jobId).result["cues"][0]["text"] == "Hello"
    with pytest.raises(KeyError):
        manager.get("unknown")
    with pytest.raises(KeyError):
        manager.cancel("unknown")


def test_download_progress_is_recorded_then_cleared_on_stage_change(setup_jobs):
    # Speed must only surface while downloading and never bleed into later stages.
    manager, pipeline, _ = setup_jobs(report=(0.5, 1024.0))
    job, _ = manager.create(REQUEST)
    assert pipeline.started.wait(1)

    downloading = manager.get(job.jobId)
    assert downloading.status == "downloading"
    assert downloading.progress == 0.5
    assert downloading.speed == 1024.0

    pipeline.release.set()
    completed = wait_terminal(manager, job.jobId)
    assert completed.status == "completed"
    assert completed.progress is None
    assert completed.speed is None


def test_cancel_during_downloading_clears_live_progress_on_terminal_snapshot(setup_jobs):
    # Cancelling mid-download must not publish a "canceled" snapshot that still
    # carries the last live progress/speed values.
    manager, pipeline, _ = setup_jobs(report=(0.5, 1024.0))
    job, _ = manager.create(REQUEST)
    assert pipeline.started.wait(1)
    assert manager.get(job.jobId).speed == 1024.0

    canceller = threading.Thread(target=manager.cancel, args=(job.jobId,))
    canceller.start()
    deadline = time.monotonic() + 1
    while not pipeline.cancel_event.is_set():
        assert time.monotonic() < deadline
        time.sleep(0.005)
    pipeline.release.set()
    canceller.join(2)

    canceled = wait_terminal(manager, job.jobId)
    assert canceled.status == "canceled"
    assert canceled.progress is None
    assert canceled.speed is None


def test_shutdown_cancels_queue_and_rejects_new_work(setup_jobs):
    manager, pipeline, _ = setup_jobs()
    first, _ = manager.create(REQUEST)
    assert pipeline.started.wait(1)
    second, _ = manager.create({**REQUEST, "videoId": OTHER_ID,
                                "url": f"https://youtu.be/{OTHER_ID}"})
    shutdown = threading.Thread(target=manager.close)
    shutdown.start()
    assert pipeline.cancel_event.wait(1)
    pipeline.release.set()
    shutdown.join(2)
    assert not shutdown.is_alive()
    assert manager.get(first.jobId).status in {"canceled", "completed"}
    assert manager.get(second.jobId).status == "canceled"
    with pytest.raises(RuntimeError, match="closed"):
        manager.create(REQUEST)


def test_simultaneous_create_requests_share_one_job(setup_jobs):
    # Missing mutual exclusion allows callers to enqueue the same model work twice.
    manager, pipeline, _ = setup_jobs()
    gate = threading.Barrier(9)
    outcomes = []

    def create():
        gate.wait()
        outcomes.append(manager.create(REQUEST))

    callers = [threading.Thread(target=create) for _ in range(8)]
    for caller in callers:
        caller.start()
    gate.wait()
    for caller in callers:
        caller.join(1)
        assert not caller.is_alive()
    assert len(outcomes) == 8
    assert len({snapshot.jobId for snapshot, _ in outcomes}) == 1
    assert not any(cache_hit for _, cache_hit in outcomes)
    assert pipeline.started.wait(1)
    assert len(pipeline.calls) == 1


@pytest.mark.parametrize("stage,error,code,retryable", [
    ("converting", FileNotFoundError("ffmpeg"), "FFMPEG_NOT_FOUND", False),
    ("converting", RuntimeError("tool failed"), "CONVERSION_FAILED", True),
    ("transcribing", RuntimeError("model failed"), "TRANSCRIPTION_FAILED", True),
    ("downloading", MissingJsRuntime("no runtime"), "JS_RUNTIME_MISSING", False),
])
def test_external_failures_keep_stage_specific_error_codes(setup_jobs, stage, error, code, retryable):
    manager, pipeline, cache = setup_jobs(fail=error, failure_stage=stage)
    job, _ = manager.create(REQUEST)
    assert pipeline.started.wait(1)
    pipeline.release.set()
    failed = wait_terminal(manager, job.jobId)
    assert failed.status == "failed"
    assert failed.error.code == code
    assert failed.error.retryable is retryable
    assert cache.load(VIDEO_ID, 10000, MODEL) is None
