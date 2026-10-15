import argparse
from pathlib import Path

import uvicorn

from .api import create_app
from .auth import PairingManager
from .cache import CacheStore
from .config import HOST, PORT, Config
from .jobs import JobManager


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Local Whisper subtitles for YouTube")
    commands = parser.add_subparsers(dest="command", required=True)
    serve = commands.add_parser("serve", help="Run the loopback-only subtitle service")
    serve.add_argument("--extension-id", required=True, help="Chrome extension ID (32 a-p letters)")
    serve.add_argument("--data-dir", type=Path, help="Override the Application Support directory")
    reset = commands.add_parser("reset-pairing", help="Revoke the token; restart serve to pair again")
    reset.add_argument("--data-dir", type=Path, help="Override the Application Support directory")
    arguments = parser.parse_args(argv)
    options = {"data_dir": arguments.data_dir} if arguments.data_dir is not None else {}
    try:
        # Reset needs only the token path; it does not authorize any extension.
        config = Config(extension_id=getattr(arguments, "extension_id", "a" * 32), **options)
    except ValueError as error:
        parser.error(str(error))
    pairing = PairingManager(config.token_file)
    if arguments.command == "reset-pairing":
        pairing.reset()
        print("Pairing reset. Restart the service to obtain a new pairing code.")
        return 0
    jobs = JobManager(CacheStore(config.cache_dir), None, config.work_dir)
    if pairing.pairing_required:
        print(f"Pairing code: {pairing.pairing_code}", flush=True)
    try:
        uvicorn.run(create_app(config, pairing, jobs), host=HOST, port=PORT, workers=1)
    finally:
        jobs.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
