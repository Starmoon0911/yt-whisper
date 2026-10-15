import re
from dataclasses import dataclass, field
from pathlib import Path

HOST = "127.0.0.1"
PORT = 8765


@dataclass(frozen=True)
class Config:
    extension_id: str
    data_dir: Path = field(
        default_factory=lambda: Path.home() / "Library" / "Application Support" / "ytWhisper",
    )

    def __post_init__(self):
        if not re.fullmatch(r"[a-p]{32}", self.extension_id):
            raise ValueError("Extension ID must contain 32 lowercase characters from a to p")

    @property
    def extension_origin(self) -> str:
        return f"chrome-extension://{self.extension_id}"

    @property
    def token_file(self) -> Path:
        return self.data_dir / "pairing.json"

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "subtitles"

    @property
    def work_dir(self) -> Path:
        return self.data_dir / "work"
