import { describe, expect, it } from "vitest";
import { ApiFailure, LocalApiClient } from "../src/api";
import { documentFixture, invalidDocuments } from "./documents";

function harness(responses: (Response | Error)[], token?: string) {
  const calls: { url: string; init: RequestInit }[] = [];
  const values: Record<string, unknown> = token ? { token } : {};
  const storage = {
    async get(key: string) { return { [key]: values[key] }; },
    async set(items: Record<string, unknown>) { Object.assign(values, items); },
    async remove(key: string) { delete values[key]; },
  };
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("Unexpected request");
    return next;
  };
  return { api: new LocalApiClient(storage, fetcher), calls, values };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const request = { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", videoId: "dQw4w9WgXcQ", durationMs: 10000 };

describe("localhost API boundary", () => {
  it("calls fetch with the WorkerGlobalScope receiver", async () => {
    const storage = {
      async get() { return {}; },
      async set() {},
      async remove() {},
    };
    const fetcher = function (this: typeof globalThis) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(json({ status: "ok", pairingRequired: true, ffmpegAvailable: true, model: "whisper" }));
    };

    await expect(new LocalApiClient(storage, fetcher).health()).resolves.toMatchObject({ status: "ok" });
  });

  it.each(invalidDocuments)("rejects completed $name before exposing a terminal job", async ({ value }) => {
    const completed = { jobId: "job-1", videoId: request.videoId, status: "completed", stage: "completed", progress: 1, speed: null, error: null, result: value };
    await expect(harness([json(completed)], "secret").api.getJob("job-1")).rejects.toMatchObject({ code: "INVALID_RESPONSE", retryable: true });
  });

  it("validates the download speed field alongside progress", async () => {
    const base = { jobId: "job-1", videoId: request.videoId, status: "downloading", stage: "downloading", progress: 0.5, error: null, result: null };
    for (const speed of [null, 0, 2048.5]) {
      await expect(harness([json({ ...base, speed })], "secret").api.getJob("job-1")).resolves.toMatchObject({ speed });
    }
    // NaN/Infinity cannot survive JSON, so the realistic wire corruptions are strings and omissions.
    for (const speed of ["2048", true]) {
      await expect(harness([json({ ...base, speed })], "secret").api.getJob("job-1")).rejects.toMatchObject({ code: "INVALID_RESPONSE", retryable: true });
    }
    await expect(harness([json(base)], "secret").api.getJob("job-1")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("uses Origin-bearing POST reads with bearer auth only for job status", async () => {
    const job = { jobId: "job-1", videoId: request.videoId, status: "transcribing", stage: "transcribing", progress: null, speed: null, error: null, result: null };
    const { api, calls } = harness([
      json({ status: "ok", pairingRequired: false, ffmpegAvailable: true, model: "whisper" }), json(job),
    ], "secret");
    await api.health();
    expect(await api.getJob("job-1")).toEqual(job);
    expect(calls.map(({ url, init }) => [url, init.method])).toEqual([
      ["http://127.0.0.1:8765/v1/health", "POST"],
      ["http://127.0.0.1:8765/v1/jobs/job-1", "POST"],
    ]);
    expect(calls[0].init.headers).not.toHaveProperty("Authorization");
    expect(calls[1].init.headers).toMatchObject({ Authorization: "Bearer secret" });
    for (const { init } of calls) {
      expect(init.headers).not.toHaveProperty("Origin"); // Browser owns this forbidden header.
      expect(init).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store" });
    }
  });

  it("reports an offline service as a retryable failure", async () => {
    const { api } = harness([new TypeError("Failed to fetch")]);
    await expect(api.health()).rejects.toMatchObject({ code: "SERVICE_OFFLINE", retryable: true });
  });

  it("requires pairing before issuing a protected request", async () => {
    const { api, calls } = harness([]);
    await expect(api.createJob(request)).rejects.toMatchObject({ code: "UNPAIRED", retryable: false });
    expect(calls).toHaveLength(0);
  });

  it("keeps bearer credentials only in local storage and sends none to public routes", async () => {
    const { api, calls, values } = harness([
      json({ status: "ok", pairingRequired: false, ffmpegAvailable: true, model: "whisper" }),
      json({ token: "new-secret" }), json({ jobId: "job-1", cacheHit: false }),
    ], "old-secret");
    await api.health();
    await api.pair("123456");
    await api.createJob({ ...request, force: true });
    expect(values).toEqual({ token: "new-secret" });
    expect(calls.map(({ url }) => url)).toEqual([
      "http://127.0.0.1:8765/v1/health", "http://127.0.0.1:8765/v1/pair", "http://127.0.0.1:8765/v1/jobs",
    ]);
    expect(calls[0].init.headers).not.toHaveProperty("Authorization");
    expect(calls[1].init.headers).not.toHaveProperty("Authorization");
    expect(calls[2].init.headers).toMatchObject({ Authorization: "Bearer new-secret" });
    expect(JSON.parse(calls[2].init.body as string)).toEqual({ ...request, force: true });
    expect(calls[2].init).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store" });
    expect(calls[2].init.headers).not.toHaveProperty("Origin");
  });

  it("clears a rejected token and preserves the server error contract", async () => {
    const error = { code: "UNAUTHORIZED", message: "Pair again.", retryable: false };
    const { api, values } = harness([json(error, 401)], "expired");
    await expect(api.getJob("job-1")).rejects.toMatchObject(error);
    expect(values).toEqual({});
  });

  it("maps invalid HTTP responses to a stable retryable error", async () => {
    const { api } = harness([new Response("proxy error", { status: 502 })]);
    await expect(api.health()).rejects.toBeInstanceOf(ApiFailure);
    const next = harness([json({ detail: "wrong contract" }, 500)]);
    await expect(next.api.health()).rejects.toMatchObject({ code: "INVALID_RESPONSE", retryable: true });
  });

  it("reads cache-hit job snapshots and uses DELETE for cancellation", async () => {
    const snapshot = { jobId: "job/1", videoId: request.videoId, status: "completed", stage: "completed", progress: 1, speed: null, error: null, result: documentFixture() };
    const { api, calls } = harness([json({ jobId: "job/1", cacheHit: true }), json(snapshot), json({ ...snapshot, status: "canceled" })], "secret");
    expect(await api.createJob(request)).toEqual({ jobId: "job/1", cacheHit: true });
    expect(await api.getJob("job/1")).toEqual(snapshot);
    expect((await api.cancelJob("job/1")).status).toBe("canceled");
    expect(calls[1].url).toBe("http://127.0.0.1:8765/v1/jobs/job%2F1");
    expect(calls[2].init.method).toBe("DELETE");
  });

  it("rejects malformed success payloads instead of treating them as usable API state", async () => {
    await expect(harness([json({})]).api.health()).rejects.toMatchObject({ code: "INVALID_RESPONSE", retryable: true });
    await expect(harness([json(null)]).api.pair("123456")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(harness([json({ jobId: 4, cacheHit: true })], "token").api.createJob(request)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
