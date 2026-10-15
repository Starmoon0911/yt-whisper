import os
import signal
import subprocess
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


class CommandRunner:
    def run(
        self, command: list[str], on_progress: Callable[[str], None], cancel_event: Event,
    ) -> CompletedCommand:
        check_cancelled(cancel_event)
        process = subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            start_new_session=True,
        )
        try:
            while True:
                check_cancelled(cancel_event)
                try:
                    stdout, stderr = process.communicate(timeout=0.05)
                    break
                except subprocess.TimeoutExpired:
                    continue
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
