import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import threading
import unittest
import wave
from concurrent.futures import CancelledError
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from ytwhisper.cache import CacheStore


VIDEO_ID = "dQw4w9WgXcQ"
MODEL = "mlx-community/whisper-large-v3-turbo"
REQUEST = {"url": f"https://youtu.be/{VIDEO_ID}?t=2", "videoId": VIDEO_ID,
           "durationMs": 10000}
WHISPER_RESULT = {"language": "zh", "duration": 10.0, "words": [
    {"start": 0.0, "end": 0.9, "word": "你好。"},
    {"start": 1.1, "end": 2.4, "word": "世界！"},
]}


class ScriptedRunner:
    """Isolate network, ffmpeg, and MLX while preserving actual disk artifacts."""

    def __init__(self, work_dir):
        self.work_dir = work_dir
        self.commands = []

    def run(self, command, on_progress, cancel_event):
        from ytwhisper.media import CompletedCommand

        self.commands.append(command)
        if command[:3] == [sys.executable, "-m", "yt_dlp"]:
            source = self.work_dir / "source.webm"
            source.write_bytes(b"downloaded audio")
            return CompletedCommand(command, 0, str(source) + "\n", "")
        if command[0] == "ffmpeg":
            Path(command[-1]).write_bytes(b"converted audio")
        elif command[:3] == [sys.executable, "-m", "ytwhisper.whisper_worker"]:
            Path(command[-1]).write_text(json.dumps(WHISPER_RESULT), encoding="utf-8")
        else:
            raise AssertionError(f"Unexpected command: {command}")
        return CompletedCommand(command, 0, "", "")


class CommandRunnerTests(unittest.TestCase):
    def test_already_canceled_command_never_starts_a_process(self):
        # Catches spawning external work after cancellation was already requested.
        from ytwhisper.media import CommandRunner

        cancel_event = threading.Event()
        cancel_event.set()
        with patch("ytwhisper.media.subprocess.Popen",
                   side_effect=AssertionError("canceled command launched a process")):
            with self.assertRaises(CancelledError):
                CommandRunner().run(["unused"], lambda progress: None, cancel_event)

    def test_cancel_terminates_descendants_holding_output_pipes(self):
        # Catches yt-dlp children surviving their parent and blocking cleanup.
        from ytwhisper.media import CommandRunner

        with tempfile.TemporaryDirectory() as directory:
            child_pid_file = Path(directory) / "child-pid"
            cancel_event = threading.Event()
            outcomes = []
            child_code = ("import os,pathlib,sys,time; "
                          "pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(5)")
            command = [sys.executable, "-c",
                       "import subprocess,sys,time; "
                       "subprocess.Popen([sys.executable, '-c', sys.argv[1], sys.argv[2]]); "
                       "time.sleep(5)", child_code, str(child_pid_file)]

            def run():
                try:
                    outcomes.append(CommandRunner().run(command, lambda progress: None, cancel_event))
                except BaseException as error:
                    outcomes.append(error)

            thread = threading.Thread(target=run)
            thread.start()
            child_pid = None
            try:
                deadline = time.monotonic() + 2
                while not child_pid_file.exists() and time.monotonic() < deadline:
                    cancel_event.wait(0.01)
                self.assertTrue(child_pid_file.exists(), "local descendant did not start")
                child_pid = int(child_pid_file.read_text())
                cancel_event.set()
                thread.join(1.5)
                self.assertFalse(thread.is_alive(), "descendant survived cancellation")
                self.assertIsInstance(outcomes[0], CancelledError)
            finally:
                if thread.is_alive() and child_pid is not None:
                    try:
                        os.kill(child_pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                thread.join(2)

    def test_cancel_escalates_when_worker_ignores_termination(self):
        # Catches waiting forever for MLX/native code that ignores SIGTERM.
        from ytwhisper.media import CommandRunner

        with tempfile.TemporaryDirectory() as directory:
            pid_file = Path(directory) / "pid"
            cancel_event = threading.Event()
            outcomes = []
            command = [sys.executable, "-c",
                       "import os,pathlib,signal,sys,time; "
                       "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                       "pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(5)",
                       str(pid_file)]

            def run():
                try:
                    outcomes.append(CommandRunner().run(command, lambda progress: None, cancel_event))
                except BaseException as error:
                    outcomes.append(error)

            thread = threading.Thread(target=run)
            thread.start()
            pid = None
            try:
                deadline = time.monotonic() + 2
                while not pid_file.exists() and time.monotonic() < deadline:
                    cancel_event.wait(0.01)
                self.assertTrue(pid_file.exists(), "local child did not start")
                pid = int(pid_file.read_text())
                cancel_event.set()
                thread.join(1.5)
                self.assertFalse(thread.is_alive(), "worker ignored termination indefinitely")
                self.assertIsInstance(outcomes[0], CancelledError)
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
            finally:
                if thread.is_alive() and pid is not None:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                thread.join(2)

    def test_cancel_terminates_and_reaps_running_subprocess(self):
        # Catches a canceled job leaving an active worker or returning success.
        from ytwhisper.media import CommandRunner

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pid_file = root / "pid"
            finished_file = root / "finished"
            cancel_event = threading.Event()
            outcomes = []
            command = [sys.executable, "-c",
                       "import os,pathlib,sys,time; "
                       "pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); "
                       "time.sleep(5); pathlib.Path(sys.argv[2]).write_text('finished')",
                       str(pid_file), str(finished_file)]

            def run():
                try:
                    outcomes.append(CommandRunner().run(command, lambda progress: None, cancel_event))
                except BaseException as error:
                    outcomes.append(error)

            thread = threading.Thread(target=run)
            thread.start()
            pid = None
            try:
                deadline = time.monotonic() + 2
                while not pid_file.exists() and time.monotonic() < deadline:
                    cancel_event.wait(0.01)
                self.assertTrue(pid_file.exists(), "local child did not start")
                pid = int(pid_file.read_text())
                cancel_event.set()
                thread.join(1)
                self.assertFalse(thread.is_alive(), "cancellation did not terminate the child")
                self.assertEqual(len(outcomes), 1)
                self.assertIsInstance(outcomes[0], CancelledError)
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
                self.assertFalse(finished_file.exists())
            finally:
                if thread.is_alive() and pid is not None:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                thread.join(2)

    def test_nonzero_exit_exposes_tool_diagnostic_as_failure(self):
        # Catches treating a failed external command as usable pipeline output.
        from ytwhisper.media import CommandRunner

        command = [sys.executable, "-c",
                   "import sys; print('download denied', file=sys.stderr); sys.exit(7)"]
        with self.assertRaises(subprocess.CalledProcessError) as raised:
            CommandRunner().run(command, lambda progress: None, threading.Event())
        self.assertEqual(raised.exception.returncode, 7)
        self.assertEqual(raised.exception.cmd, command)
        self.assertIn("download denied", raised.exception.stderr)

    def test_runs_argument_vector_and_returns_output_without_shell_interpretation(self):
        # Catches shell interpolation, output loss, or ignoring progress callbacks.
        from ytwhisper.media import CommandRunner

        progress = []
        command = [sys.executable, "-c",
                   "import sys; print(sys.argv[1]); print('diagnostic', file=sys.stderr)",
                   "literal $(do-not-run); spaces"]
        result = CommandRunner().run(command, progress.append, threading.Event())

        self.assertEqual(result.command, command)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "literal $(do-not-run); spaces\n")
        self.assertEqual(result.stderr, "diagnostic\n")
        self.assertIn("literal $(do-not-run); spaces", "".join(progress))


class WhisperWorkerTests(unittest.TestCase):
    def test_worker_auto_detects_language_and_writes_wave_duration_and_words(self):
        # Catches translating, losing word times, or using speech end as video duration.
        from ytwhisper.whisper_worker import main

        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "audio.wav"
            output = Path(directory) / "whisper.json"
            with wave.open(str(audio), "wb") as handle:
                handle.setnchannels(1)
                handle.setsampwidth(2)
                handle.setframerate(16000)
                handle.writeframes(b"\x00\x00" * 76000)
            calls = []

            def transcribe(audio_path, **options):
                calls.append((audio_path, options))
                return {"language": "zh", "text": "你好。世界！", "segments": [
                    {"start": 0, "end": 2.4, "text": "你好。世界！",
                     "words": WHISPER_RESULT["words"]},
                ]}

            with patch.dict(sys.modules, {"mlx_whisper": SimpleNamespace(transcribe=transcribe)}):
                main(["--audio", str(audio), "--output", str(output)])

            self.assertEqual(calls, [(str(audio), {
                "path_or_hf_repo": MODEL, "word_timestamps": True,
                "task": "transcribe", "language": None,
            })])
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), {
                "language": "zh", "duration": 4.75, "words": WHISPER_RESULT["words"],
            })


class MediaPipelineTests(unittest.TestCase):
    def test_invalid_request_cleans_owned_directory_without_running_tools(self):
        # Catches bypassing URL normalization or leaking a precreated job directory.
        from ytwhisper.pipeline import MediaPipeline

        for url in ("https://example.com/audio", "https://www.youtube.com/watch?v=abcdefghijk"):
            with self.subTest(url=url), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                work_dir = root / "work"
                work_dir.mkdir()
                cache = CacheStore(root / "cache")
                runner = ScriptedRunner(work_dir)
                with self.assertRaises(ValueError):
                    MediaPipeline(cache, runner=runner).process(
                        {**REQUEST, "url": url}, work_dir, lambda state: None, threading.Event(),
                    )
                self.assertEqual(runner.commands, [])
                self.assertFalse(cache.path_for(VIDEO_ID).exists())
                self.assertFalse(work_dir.exists())

    def test_accepts_empty_work_directory_but_preserves_unowned_contents(self):
        # Catches rejecting mkdtemp callers or deleting preexisting user content.
        from ytwhisper.pipeline import MediaPipeline

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            work_dir = root / "work"
            work_dir.mkdir()
            cache = CacheStore(root / "cache")
            document = MediaPipeline(cache, runner=ScriptedRunner(work_dir)).process(
                REQUEST, work_dir, lambda state: None, threading.Event(),
            )
            self.assertEqual(document["language"], "zh")
            self.assertFalse(work_dir.exists())

            work_dir.mkdir()
            user_file = work_dir / "keep.txt"
            user_file.write_text("keep me")
            with self.assertRaises(ValueError):
                MediaPipeline(cache, runner=ScriptedRunner(work_dir)).process(
                    REQUEST, work_dir, lambda state: None, threading.Event(),
                )
            self.assertEqual(user_file.read_text(), "keep me")

    def test_pipeline_uses_default_command_runner_when_none_is_injected(self):
        # Catches a production-only constructor requiring test dependencies.
        from ytwhisper.pipeline import MediaPipeline

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            work_dir = root / "work"
            cache = CacheStore(root / "cache")
            scripted = ScriptedRunner(work_dir)
            with patch("ytwhisper.media.CommandRunner.run", side_effect=scripted.run):
                document = MediaPipeline(cache).process(
                    REQUEST, work_dir, lambda state: None, threading.Event(),
                )
            self.assertEqual(document["language"], "zh")
            self.assertEqual(cache.load(VIDEO_ID, 10000, MODEL), document)
            self.assertFalse(work_dir.exists())

    def test_malformed_worker_results_never_become_completed_cache(self):
        # Catches accepting invalid language/duration/timestamps as a complete document.
        from ytwhisper.pipeline import MediaPipeline

        malformed = [
            {**WHISPER_RESULT, "language": ""},
            {**WHISPER_RESULT, "language": True},
            {**WHISPER_RESULT, "duration": -1},
            {**WHISPER_RESULT, "duration": 0},
            {**WHISPER_RESULT, "duration": float("nan")},
            {**WHISPER_RESULT, "duration": True},
            {**WHISPER_RESULT, "words": {}},
            {**WHISPER_RESULT, "words": [{"start": -0.1, "end": 1, "word": "Bad"}]},
            {**WHISPER_RESULT, "words": [{"start": 1, "end": 1, "word": "Bad"}]},
            {**WHISPER_RESULT, "words": [{"start": 1, "end": 1.0001, "word": "Bad"}]},
            {**WHISPER_RESULT, "words": [{"start": 9, "end": 11, "word": "Bad"}]},
            {**WHISPER_RESULT, "words": [{"start": 0, "end": 1, "word": 123}]},
            {**WHISPER_RESULT, "words": [
                {"start": 0, "end": 2, "word": "First."},
                {"start": 1, "end": 3, "word": "Second."},
            ]},
        ]
        for result in malformed:
            with self.subTest(result=result), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                work_dir = root / "work"
                cache = CacheStore(root / "cache")

                class MalformedRunner(ScriptedRunner):
                    def run(self, command, on_progress, cancel_event):
                        completed = super().run(command, on_progress, cancel_event)
                        if len(self.commands) == 3:
                            Path(command[-1]).write_text(json.dumps(result), encoding="utf-8")
                        return completed

                with self.assertRaises(ValueError):
                    MediaPipeline(cache, runner=MalformedRunner(work_dir)).process(
                        REQUEST, work_dir, lambda state: None, threading.Event(),
                    )
                self.assertFalse(cache.path_for(VIDEO_ID).exists())
                self.assertFalse(work_dir.exists())

    def test_cancellation_from_state_callback_prevents_next_external_step(self):
        # Catches cancellation arriving just before each external command starts.
        from ytwhisper.pipeline import MediaPipeline

        for cancel_state, expected_commands in (("downloading", 0), ("converting", 1),
                                                 ("transcribing", 2)):
            with self.subTest(state=cancel_state), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                work_dir = root / "work"
                cache = CacheStore(root / "cache")
                runner = ScriptedRunner(work_dir)
                cancel_event = threading.Event()

                def on_state(state):
                    if state == cancel_state:
                        cancel_event.set()

                with self.assertRaises(CancelledError):
                    MediaPipeline(cache, runner=runner).process(
                        REQUEST, work_dir, on_state, cancel_event,
                    )
                self.assertEqual(len(runner.commands), expected_commands)
                self.assertFalse(cache.path_for(VIDEO_ID).exists())
                self.assertFalse(work_dir.exists())

    def test_cancellation_before_or_after_each_tool_never_publishes_result(self):
        # Catches ignoring an event once a tool returns, especially after recognition.
        from ytwhisper.pipeline import MediaPipeline

        class CancelingRunner(ScriptedRunner):
            def run(self, command, on_progress, cancel_event):
                result = super().run(command, on_progress, cancel_event)
                if len(self.commands) == cancel_after:
                    cancel_event.set()
                return result

        for cancel_after in (0, 1, 2, 3):
            with self.subTest(step=cancel_after), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                work_dir = root / "work"
                cache = CacheStore(root / "cache")
                runner = CancelingRunner(work_dir)
                cancel_event = threading.Event()
                if cancel_after == 0:
                    cancel_event.set()
                states = []
                with self.assertRaises(CancelledError):
                    MediaPipeline(cache, runner=runner).process(
                        REQUEST, work_dir, states.append, cancel_event,
                    )
                self.assertEqual(len(runner.commands), cancel_after)
                self.assertNotIn("completed", states)
                self.assertFalse(cache.path_for(VIDEO_ID).exists())
                self.assertFalse(work_dir.exists())

    def test_each_external_failure_cleans_partial_artifacts_without_cache(self):
        # Catches missing finally cleanup after any of the three tool failures.
        from ytwhisper.pipeline import MediaPipeline

        class FailingRunner(ScriptedRunner):
            def run(self, command, on_progress, cancel_event):
                result = super().run(command, on_progress, cancel_event)
                if len(self.commands) == failing_step:
                    raise RuntimeError("external tool failed")
                return result

        for failing_step in (1, 2, 3):
            with self.subTest(step=failing_step), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                work_dir = root / "work"
                cache = CacheStore(root / "cache")
                runner = FailingRunner(work_dir)
                states = []
                with self.assertRaisesRegex(RuntimeError, "external tool failed"):
                    MediaPipeline(cache, runner=runner).process(
                        REQUEST, work_dir, states.append, threading.Event(),
                    )
                self.assertEqual(len(runner.commands), failing_step)
                self.assertNotIn("completed", states)
                self.assertIsNone(cache.load(VIDEO_ID, 10000, MODEL))
                self.assertFalse(work_dir.exists())

    def test_success_uses_audio_commands_and_caches_original_language_cues(self):
        # Catches wrong tool arguments, translation, incomplete cache, or success leaks.
        from ytwhisper.pipeline import MediaPipeline

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            work_dir = root / "work"
            cache = CacheStore(root / "cache")
            runner = ScriptedRunner(work_dir)
            states = []

            document = MediaPipeline(cache, runner=runner).process(
                REQUEST, work_dir, states.append, threading.Event(),
            )

            self.assertEqual(runner.commands, [
                [sys.executable, "-m", "yt_dlp", "--no-playlist", "--no-progress",
                 "--match-filter", "!is_live", "--format", "bestaudio", "--output",
                 str(work_dir / "source.%(ext)s"), "--print", "after_move:filepath",
                 f"https://www.youtube.com/watch?v={VIDEO_ID}"],
                ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i",
                 str(work_dir / "source.webm"), "-vn", "-ac", "1", "-ar", "16000",
                 "-c:a", "pcm_s16le", str(work_dir / "audio.wav")],
                [sys.executable, "-m", "ytwhisper.whisper_worker", "--audio",
                 str(work_dir / "audio.wav"), "--output", str(work_dir / "whisper.json")],
            ])
            self.assertEqual(states, ["downloading", "converting", "transcribing"])
            self.assertEqual({key: value for key, value in document.items()
                              if key != "generatedAt"}, {
                "schemaVersion": 1, "videoId": VIDEO_ID, "language": "zh",
                "durationMs": 10000, "model": MODEL, "cues": [
                    {"startMs": 0, "endMs": 900, "text": "你好。"},
                    {"startMs": 1100, "endMs": 2400, "text": "世界！"},
                ],
            })
            self.assertIsNotNone(datetime.fromisoformat(document["generatedAt"]).tzinfo)
            self.assertEqual(cache.load(VIDEO_ID, 10000, MODEL), document)
            self.assertEqual(list(cache.directory.iterdir()), [cache.path_for(VIDEO_ID)])
            self.assertFalse(work_dir.exists())
