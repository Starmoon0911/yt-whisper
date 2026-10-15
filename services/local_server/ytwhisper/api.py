import shutil
from contextlib import asynccontextmanager
from threading import Lock

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException

from .auth import InvalidPairingCode, PairingManager
from .config import Config
from .jobs import JobManager
from .models import ApiError, JobRequest, PairRequest
from .transcriber import MODEL


def _error(status: int, code: str, message: str, retryable: bool = False) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content=ApiError(code=code, message=message, retryable=retryable).model_dump(),
    )


def create_app(config: Config, pairing: PairingManager, jobs: JobManager) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app):
        yield
        await run_in_threadpool(jobs.close)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.config = config
    app.state.jobs = jobs
    pairing_lock = Lock()

    @app.middleware("http")
    async def security(request: Request, call_next):
        if request.headers.get("origin") != config.extension_origin:
            return _error(403, "ORIGIN_FORBIDDEN", "This extension Origin is not allowed.")
        if request.method == "OPTIONS":
            method = request.headers.get("access-control-request-method", "")
            headers = {
                value.strip().lower()
                for value in request.headers.get("access-control-request-headers", "").split(",")
                if value.strip()
            }
            if method not in {"GET", "POST", "DELETE"} or not headers <= {
                "authorization", "content-type",
            }:
                response = _error(400, "INVALID_REQUEST", "Unsupported CORS preflight request.")
            else:
                response = JSONResponse(content={"ok": True})
                response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
                response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
                response.headers["Access-Control-Max-Age"] = "600"
        elif request.url.path == "/v1/jobs" or request.url.path.startswith("/v1/jobs/"):
            authorization = request.headers.get("authorization", "")
            scheme, separator, token = authorization.partition(" ")
            if scheme.lower() != "bearer" or not separator or not token or not pairing.verify(token):
                response = _error(401, "UNAUTHORIZED", "Pair this extension with the local service.")
                response.headers["WWW-Authenticate"] = "Bearer"
            else:
                response = await call_next(request)
        else:
            response = await call_next(request)
        response.headers["Access-Control-Allow-Origin"] = config.extension_origin
        response.headers["Vary"] = "Origin"
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, error):
        return _error(422, "INVALID_REQUEST", "The request contains invalid or unsupported fields.")

    @app.exception_handler(HTTPException)
    async def http_error(request, error):
        code = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}.get(error.status_code, "HTTP_ERROR")
        return _error(error.status_code, code, str(error.detail))

    @app.exception_handler(Exception)
    async def unexpected_error(request, error):
        response = _error(
            500, "INTERNAL_ERROR", "The local service encountered an unexpected error.", True,
        )
        # Starlette's ServerErrorMiddleware runs outside user middleware, so
        # these responses cannot receive CORS headers on the normal return path.
        if request.headers.get("origin") == config.extension_origin:
            response.headers["Access-Control-Allow-Origin"] = config.extension_origin
            response.headers["Vary"] = "Origin"
        return response

    # Host-permitted Chrome extension GETs may omit Origin. POST read aliases
    # use the browser's Origin header without relaxing the middleware check.
    @app.post("/v1/health")
    @app.get("/v1/health")
    def health():
        return {
            "status": "ok", "pairingRequired": pairing.pairing_required,
            "ffmpegAvailable": shutil.which("ffmpeg") is not None, "model": MODEL,
        }

    @app.post("/v1/pair")
    def pair(request: PairRequest):
        try:
            with pairing_lock:
                return {"token": pairing.pair(request.code)}
        except InvalidPairingCode as error:
            return _error(400, "PAIRING_FAILED", str(error))

    @app.post("/v1/jobs")
    def create_job(request: JobRequest):
        snapshot, cache_hit = jobs.create(request)
        return {"jobId": snapshot.jobId, "cacheHit": cache_hit}

    @app.post("/v1/jobs/{job_id}")
    @app.get("/v1/jobs/{job_id}")
    def get_job(job_id: str):
        try:
            return jobs.get(job_id)
        except KeyError:
            return _error(404, "JOB_NOT_FOUND", "This job does not exist.")

    @app.delete("/v1/jobs/{job_id}")
    def cancel_job(job_id: str):
        try:
            return jobs.cancel(job_id)
        except KeyError:
            return _error(404, "JOB_NOT_FOUND", "This job does not exist.")

    return app
