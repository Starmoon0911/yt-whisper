from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .youtube import normalize_watch_url

JobStatus = Literal[
    "queued", "downloading", "converting", "transcribing", "completed", "failed", "canceled",
]


class ApiError(BaseModel):
    code: str
    message: str
    retryable: bool


class JobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    url: str
    videoId: str = Field(pattern=r"^[A-Za-z0-9_-]{11}$")
    durationMs: int = Field(gt=0)
    force: bool = False

    @model_validator(mode="after")
    def normalize_url(self):
        self.url = normalize_watch_url(self.url, self.videoId)
        return self


class PairRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    code: str = Field(pattern=r"^[0-9]{6}$")


class JobSnapshot(BaseModel):
    jobId: str
    videoId: str
    status: JobStatus
    stage: JobStatus
    progress: float | None = None
    speed: float | None = None
    error: ApiError | None = None
    result: dict[str, Any] | None = None
