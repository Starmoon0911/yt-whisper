from dataclasses import dataclass
from concurrent.futures import CancelledError
from threading import Event
from typing import Callable
import subprocess
import os
import signal


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
        while True:
            if cancel_event.is_set():
                self._signal_group(process, signal.SIGTERM)
                try:
                    process.communicate(timeout=0.25)
                except subprocess.TimeoutExpired:
                    self._signal_group(process, signal.SIGKILL)
                    process.communicate()
                raise PipelineCancelled("Subtitle generation canceled")
            try:
                stdout, stderr = process.communicate(timeout=0.05)
                break
            except subprocess.TimeoutExpired:
                continue
        if stdout:
            on_progress(stdout)
        if process.returncode:
            raise CommandError(process.returncode, command, stdout, stderr)
        return CompletedCommand(command, process.returncode, stdout, stderr)

    @staticmethod
    def _signal_group(process: subprocess.Popen, sig: signal.Signals) -> None:
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            pass
