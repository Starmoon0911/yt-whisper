from contextlib import contextmanager
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from ytwhisper.auth import PairingManager
from ytwhisper.cache import CacheStore

VIDEO_ID = "dQw4w9WgXcQ"
EXTENSION_ID = "a" * 32
ORIGIN = f"chrome-extension://{EXTENSION_ID}"
REQUEST = {"url": f"https://youtu.be/{VIDEO_ID}", "videoId": VIDEO_ID, "durationMs": 10000}
DOCUMENT = {
    "schemaVersion": 1, "videoId": VIDEO_ID, "language": "en", "durationMs": 10000,
    "model": "mlx-community/whisper-large-v3-turbo", "generatedAt": "2026-10-15T00:00:00Z",
    "cues": [{"startMs": 0, "endMs": 900, "text": "Hello"}],
}


@contextmanager
def client_for(tmp_path):
    from ytwhisper.api import create_app
    from ytwhisper.config import Config
    from ytwhisper.jobs import JobManager

    config = Config(extension_id=EXTENSION_ID, data_dir=tmp_path)
    pairing = PairingManager(config.token_file, pairing_code="123456")
    cache = CacheStore(config.cache_dir)
    cache.store(DOCUMENT)
    jobs = JobManager(cache, None, config.work_dir)
    with TestClient(create_app(config, pairing, jobs), raise_server_exceptions=False) as client:
        client.headers["Origin"] = ORIGIN
        yield client, pairing, config


def assert_error(response, status, code):
    assert response.status_code == status
    error = response.json()
    assert set(error) == {"code", "message", "retryable"}
    assert error["code"] == code
    assert isinstance(error["message"], str) and error["message"]
    assert type(error["retryable"]) is bool


def authorize(client):
    response = client.post("/v1/pair", json={"code": "123456"})
    assert response.status_code == 200
    token = response.json()["token"]
    client.headers["Authorization"] = f"Bearer {token}"
    return token


def test_health_pairing_and_authenticated_cache_job_lifecycle(tmp_path):
    # Missing security/route wiring or incompatible output shapes breaks this workflow.
    with client_for(tmp_path) as (client, pairing, _):
        with patch("ytwhisper.api.shutil.which", return_value="/opt/homebrew/bin/ffmpeg"):
            assert client.get("/v1/health").json() == {
                "status": "ok", "pairingRequired": True, "ffmpegAvailable": True,
                "model": "mlx-community/whisper-large-v3-turbo",
            }
        token = authorize(client)
        assert pairing.verify(token)
        assert not client.get("/v1/health").json()["pairingRequired"]
        created = client.post("/v1/jobs", json=REQUEST)
        assert created.status_code == 200
        assert created.json()["cacheHit"] is True
        job_id = created.json()["jobId"]
        snapshot = client.get(f"/v1/jobs/{job_id}")
        assert snapshot.status_code == 200
        assert snapshot.json() == {
            "jobId": job_id, "videoId": VIDEO_ID, "status": "completed", "stage": "completed",
            "progress": None, "error": None, "result": DOCUMENT,
        }
        assert client.delete(f"/v1/jobs/{job_id}").json()["status"] == "completed"
        assert_error(client.post("/v1/pair", json={"code": "123456"}), 400, "PAIRING_FAILED")


def test_post_reads_match_get_without_mutating_jobs_and_allow_cache_without_ffmpeg(tmp_path):
    # Chrome host-permitted GET fetches can omit Origin; POST reads keep strict Origin.
    with client_for(tmp_path) as (client, _, _):
        with patch("ytwhisper.api.shutil.which", return_value=None):
            health = client.post("/v1/health")
            assert health.status_code == 200
            assert health.json() == client.get("/v1/health").json()
            assert health.json()["ffmpegAvailable"] is False
            assert health.headers["Access-Control-Allow-Origin"] == ORIGIN
            authorize(client)
            created = client.post("/v1/jobs", json=REQUEST).json()
            assert created["cacheHit"] is True
            route = f'/v1/jobs/{created["jobId"]}'
            snapshot = client.post(route)
            assert snapshot.status_code == 200
            assert snapshot.json() == client.get(route).json()
            assert snapshot.json()["result"] == DOCUMENT
            assert_error(client.post("/v1/jobs/unknown"), 404, "JOB_NOT_FOUND")


@pytest.mark.parametrize("origin", [None, "null", "https://www.youtube.com", ORIGIN + ".evil",
                                    "chrome-extension://" + "b" * 32])
def test_every_route_rejects_missing_or_unapproved_origin(tmp_path, origin):
    with client_for(tmp_path) as (client, _, _):
        if origin is None:
            del client.headers["Origin"]
        else:
            client.headers["Origin"] = origin
        for method, route in (("get", "/v1/health"), ("post", "/v1/health"), ("post", "/v1/pair"),
                              ("post", "/v1/jobs"), ("get", "/v1/jobs/unknown"),
                              ("post", "/v1/jobs/unknown"),
                              ("delete", "/v1/jobs/unknown")):
            assert_error(getattr(client, method)(route), 403, "ORIGIN_FORBIDDEN")


@pytest.mark.parametrize("header", [None, "Bearer wrong", "Basic abc", "Bearer", "Bearer "])
def test_job_routes_require_valid_bearer(tmp_path, header):
    with client_for(tmp_path) as (client, _, _):
        authorize(client)
        if header is None:
            del client.headers["Authorization"]
        else:
            client.headers["Authorization"] = header
        assert_error(client.post("/v1/jobs", json=REQUEST), 401, "UNAUTHORIZED")
        assert_error(client.get("/v1/jobs/unknown"), 401, "UNAUTHORIZED")
        assert_error(client.post("/v1/jobs/unknown"), 401, "UNAUTHORIZED")
        assert_error(client.delete("/v1/jobs/unknown"), 401, "UNAUTHORIZED")


def test_pairing_code_failure_and_unknown_routes_have_unified_errors(tmp_path):
    with client_for(tmp_path) as (client, _, _):
        assert_error(client.post("/v1/pair", json={"code": "999999"}), 400, "PAIRING_FAILED")
        authorize(client)
        assert_error(client.get("/v1/jobs/unknown"), 404, "JOB_NOT_FOUND")
        assert_error(client.delete("/v1/jobs/unknown"), 404, "JOB_NOT_FOUND")
        assert_error(client.get("/unknown"), 404, "NOT_FOUND")
        assert_error(client.put("/v1/health"), 405, "METHOD_NOT_ALLOWED")


@pytest.mark.parametrize("change", [
    {"url": "http://www.youtube.com/watch?v=dQw4w9WgXcQ"},
    {"url": "https://127.0.0.1/private"},
    {"url": "https://www.youtube.com/watch?v=abcdefghijk"},
    {"url": "https://www.youtube.com/shorts/dQw4w9WgXcQ"},
    {"durationMs": -1}, {"durationMs": 0}, {"durationMs": True}, {"durationMs": "10000"},
    {"durationMs": 10.5}, {"videoId": "../bad"}, {"force": "true"}, {"cookies": "secret"},
])
def test_invalid_job_inputs_never_create_work(tmp_path, change):
    with client_for(tmp_path) as (client, _, _):
        authorize(client)
        assert_error(client.post("/v1/jobs", json={**REQUEST, **change}), 422, "INVALID_REQUEST")


def test_malformed_json_pair_schema_and_unexpected_errors_are_unified(tmp_path):
    with client_for(tmp_path) as (client, _, _):
        assert_error(client.post("/v1/pair", json={"code": 123456}), 422, "INVALID_REQUEST")
        authorize(client)
        assert_error(client.post("/v1/jobs", content="{"), 422, "INVALID_REQUEST")
        with patch("ytwhisper.api.shutil.which", side_effect=RuntimeError("private internal detail")):
            response = client.get("/v1/health")
        assert_error(response, 500, "INTERNAL_ERROR")
        assert "private internal detail" not in response.text
        assert response.headers.get("Access-Control-Allow-Origin") == ORIGIN


def test_exact_origin_cors_preflight_and_missing_ffmpeg(tmp_path):
    with client_for(tmp_path) as (client, _, _):
        response = client.options("/v1/jobs", headers={
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        })
        assert response.status_code == 200
        assert response.headers["Access-Control-Allow-Origin"] == ORIGIN
        assert "authorization" in response.headers["Access-Control-Allow-Headers"].lower()
        with patch("ytwhisper.api.shutil.which", return_value=None):
            assert client.get("/v1/health").json()["ffmpegAvailable"] is False
        assert_error(client.options("/v1/jobs", headers={
            "Origin": "https://evil.example", "Access-Control-Request-Method": "POST",
        }), 403, "ORIGIN_FORBIDDEN")


def test_cli_serve_pins_loopback_port_and_reset_revokes_pairing(tmp_path, capsys):
    from ytwhisper.cli import main
    from ytwhisper.config import Config

    with patch("ytwhisper.cli.uvicorn.run") as serve:
        assert main(["serve", "--extension-id", EXTENSION_ID, "--data-dir", str(tmp_path)]) == 0
    args, options = serve.call_args
    assert options["host"] == "127.0.0.1"
    assert options["port"] == 8765
    assert options["workers"] == 1
    assert args[0].state.config.extension_origin == ORIGIN
    assert "Pairing code:" in capsys.readouterr().out
    config = Config(extension_id=EXTENSION_ID, data_dir=tmp_path)
    pairing = PairingManager(config.token_file, pairing_code="123456")
    token = pairing.pair("123456")
    assert main(["reset-pairing", "--data-dir", str(tmp_path)]) == 0
    assert not pairing.verify(token)
    args[0].state.jobs.close()


@pytest.mark.parametrize("extension_id", ["", "*", "A" * 32, "a" * 31, "q" * 32,
                                          "a" * 32 + "/evil"])
def test_config_rejects_invalid_extension_ids(extension_id):
    from ytwhisper.config import Config

    with pytest.raises(ValueError):
        Config(extension_id=extension_id)


def test_default_data_path_is_macos_application_support():
    from pathlib import Path

    from ytwhisper.config import Config

    config = Config(extension_id=EXTENSION_ID)
    assert config.data_dir == Path.home() / "Library" / "Application Support" / "ytWhisper"
    assert config.token_file.parent == config.data_dir
    assert config.cache_dir.parent == config.data_dir
    assert config.work_dir.parent == config.data_dir


def test_cli_rejects_invalid_origin_configuration_and_port_override(tmp_path):
    from ytwhisper.cli import main

    for arguments in (["serve", "--extension-id", "*"],
                      ["serve", "--extension-id", EXTENSION_ID, "--port", "9000"],
                      ["serve"]):
        with pytest.raises(SystemExit) as raised:
            main(arguments)
        assert raised.value.code == 2
