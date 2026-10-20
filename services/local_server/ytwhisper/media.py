import os
import selectors
import signal
import subprocess
import time
from collections.abc import Callable
from concurrent.futures import CancelledError
from dataclasses import dataclass
from threading import Event


class PipelineCancelled(CancelledError):
    pass


class CommandError(subprocess.CalledProcessError):
    pass


def check_cancelled(cancel_event: Event) -> None:
    if cancel_event.is_set():
        raise PipelineCancelled("Subtitle generation canceled")


@dataclass(frozen=True)
class CompletedCommand:
    command: list[str]
    returncode: int
    stdout: str
    stderr: str


PROGRESS_PREFIX = "PROG "


class CommandRunner:
    def run(
        self, command: list[str], on_progress: Callable[[str], None], cancel_event: Event,
    ) -> CompletedCommand:
        check_cancelled(cancel_event)
        process = subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True,
        )
        try:
            stdout, stderr = self._stream(process, on_progress, cancel_event)
            check_cancelled(cancel_event)
            if stdout:
                on_progress(stdout)
            check_cancelled(cancel_event)
            if process.returncode:
                raise CommandError(process.returncode, command, stdout, stderr)
            return CompletedCommand(command, process.returncode, stdout, stderr)
        except BaseException:
            self._terminate_group(process)
            raise

    def _stream(
        self, process: subprocess.Popen, on_progress: Callable[[str], None], cancel_event: Event,
    ) -> tuple[str, str]:
        # Interleaved non-blocking reads keep ~50ms cancellation responsiveness;
        # a blocking readline() would drop checkpoints when the network stalls.
        selector = selectors.DefaultSelector()
        pipes = (process.stdout, process.stderr)
        open_pipes = set(pipes)
        remainder = dict.fromkeys(pipes, b"")
        chunks = {pipe: [] for pipe in pipes}
        try:
            for pipe in open_pipes:
                selector.register(pipe, selectors.EVENT_READ)
            while open_pipes or process.poll() is None:
                check_cancelled(cancel_event)
                if not open_pipes:
                    time.sleep(0.05)
                    continue
                for key, _events in selector.select(timeout=0.05):
                    pipe = key.fileobj
                    try:
                        chunk = os.read(pipe.fileno(), 65536)
                    except OSError:
                        chunk = b""
                    if chunk:
                        chunks[pipe].append(chunk)
                        lines = (remainder[pipe] + chunk).split(b"\n")
                        remainder[pipe] = lines.pop()
                        if pipe is process.stdout:
                            for raw in lines:
                                if raw.startswith(b"PROG "):
                                    on_progress(raw.decode("utf-8", "replace"))
                        continue
                    open_pipes.discard(pipe)
                    selector.unregister(pipe)
                    if remainder[pipe] and pipe is process.stdout:
                        tail = remainder[pipe].decode("utf-8", "replace")
                        if tail.startswith("PROG "):
                            on_progress(tail)
            stdout = b"".join(chunks[process.stdout]).decode("utf-8", "replace")
            stderr = b"".join(chunks[process.stderr]).decode("utf-8", "replace")
        finally:
            selector.close()
        return stdout, stderr

    def _terminate_group(self, process: subprocess.Popen) -> None:
        self._signal_group(process, signal.SIGTERM)
        try:
            process.communicate(timeout=0.25)
        except subprocess.TimeoutExpired:
            pass
        finally:
            # Descendants may ignore SIGTERM and close their output pipes before
            # the parent exits. Reaping the parent alone does not stop them.
            self._signal_group(process, signal.SIGKILL)
            process.communicate()

    @staticmethod
    def _signal_group(process: subprocess.Popen, sig: signal.Signals) -> None:
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            pass
