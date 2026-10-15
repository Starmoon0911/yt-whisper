import hashlib
import hmac
import json
import os
import secrets
from pathlib import Path


class InvalidPairingCode(ValueError):
    pass


class PairingManager:
    def __init__(self, token_file: Path, pairing_code: str | None = None):
        self.token_file = token_file
        self._pairing_code = None if token_file.exists() else pairing_code or f"{secrets.randbelow(1_000_000):06d}"

    @property
    def pairing_required(self) -> bool:
        return not self.token_file.exists()

    @property
    def pairing_code(self) -> str | None:
        return self._pairing_code

    def pair(self, code: str) -> str:
        if not self.pairing_required or not self._pairing_code:
            raise InvalidPairingCode("This service has already been paired")
        if not hmac.compare_digest(code, self._pairing_code):
            raise InvalidPairingCode("The pairing code is invalid")

        token = secrets.token_urlsafe(32)
        self.token_file.parent.mkdir(parents=True, exist_ok=True)
        payload = {"tokenHash": hashlib.sha256(token.encode()).hexdigest()}
        self.token_file.write_text(json.dumps(payload), encoding="utf-8")
        os.chmod(self.token_file, 0o600)
        self._pairing_code = None
        return token

    def verify(self, token: str) -> bool:
        try:
            payload = json.loads(self.token_file.read_text(encoding="utf-8"))
            expected = str(payload["tokenHash"])
        except (OSError, KeyError, TypeError, json.JSONDecodeError):
            return False
        actual = hashlib.sha256(token.encode()).hexdigest()
        return hmac.compare_digest(actual, expected)

    def reset(self) -> None:
        self.token_file.unlink(missing_ok=True)
        self._pairing_code = f"{secrets.randbelow(1_000_000):06d}"

