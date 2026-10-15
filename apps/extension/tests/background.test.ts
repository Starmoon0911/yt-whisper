import { describe, expect, it } from "vitest";
import { BackgroundController, installBackground } from "../src/background";
import { ApiFailure } from "../src/api";
import type { ContentRequest, ContentResponse, JobSnapshot, PageState } from "../src/contracts";

const page: PageState = { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", videoId: "dQw4w9WgXcQ", title: "Example", durationMs: 10000, hasSubtitles: false, subtitlesEnabled: true };
const snapshot = (status: JobSnapshot["status"]): JobSnapshot => ({ jobId: "job-1", videoId: page.videoId, status, stage: status, progress: status === "completed" ? 1 : null, error: null, result: status === "completed" ? { schemaVersion: 1, videoId: page.videoId, language: "en", model: "whisper", durationMs: 10000, generatedAt: "2026-10-15T00:00:00Z", cues: [{ startMs: 0, endMs: 900, text: "Hello" }] } : null });
function harness(options: { cacheHit?: boolean; offline?: boolean; paired?: boolean; initialJobs?: unknown[]; createError?: boolean } = {}) {
  const messages: ContentRequest[] = [];
  const pending: (() => void)[] = [];
  let currentPage = { ...page };
  let next = snapshot(options.cacheHit ? "completed" : "transcribing");
  let stored: unknown[] = options.initialJobs ?? [];
  let creates = 0;
  let delayedPoll: Promise<JobSnapshot> | null = null;
  let lastForce: boolean | undefined;
  const api = {
    async health() { if (options.offline) throw new ApiFailure("SERVICE_OFFLINE", "offline", true); return { status: "ok" as const, pairingRequired: false, ffmpegAvailable: true, model: "whisper" }; },
    async isPaired() { return options.paired !== false; },
    async pair(code: string) { if (code !== "123456") throw new ApiFailure("PAIRING_FAILED", "wrong code", false); },
    async createJob(request: { force?: boolean }) { creates++; lastForce = request.force; if (options.createError) throw new ApiFailure("DOWNLOAD_FAILED", "cannot download", true); return { jobId: "job-1", cacheHit: !!options.cacheHit }; },
    async getJob() { return delayedPoll ?? next; },
    async cancelJob() { next = snapshot("canceled"); return next; },
  };
  const controller = new BackgroundController(api, {
    async activeTab() { return 7; },
    async sendToTab(_tabId: number, message: ContentRequest): Promise<ContentResponse> {
      messages.push(message);
      if (message.type === "SET_SUBTITLES") currentPage = { ...currentPage, subtitlesEnabled: message.enabled, hasSubtitles: !!message.document || currentPage.hasSubtitles };
      return { ok: true, page: currentPage };
    },
    async loadJobs() { return stored; },
    async saveJobs(jobs: unknown[]) { stored = jobs; },
    schedule(callback: () => void) { pending.push(callback); return () => { const i = pending.indexOf(callback); if (i >= 0) pending.splice(i, 1); }; },
  });
  return { controller, messages, pending, get stored() { return stored; }, get creates() { return creates; }, get force() { return lastForce; }, complete() { next = snapshot("completed"); }, navigate() { currentPage = { ...page, videoId: "abcdefghijk", url: "https://www.youtube.com/watch?v=abcdefghijk" }; },
    holdPoll() { let resolve!: (job: JobSnapshot) => void; delayedPoll = new Promise(r => { resolve = r; }); return resolve; },
  };
}

describe("background job orchestration", () => {
  it("reports offline and unpaired state without exposing credentials", async () => {
    const { controller } = harness({ offline: true, paired: false });
    const response = await controller.handle({ type: "GET_PAGE_STATE" });
    expect(response).toMatchObject({ ok: true, state: { paired: false, health: null, page, error: { code: "SERVICE_OFFLINE" } } });
    expect(JSON.stringify(response)).not.toContain("token");
  });

  it("pauses first, polls to completion, and delivers subtitles to the original video", async () => {
    const h = harness();
    const response = await h.controller.handle({ type: "START_JOB", tabId: 7 });
    expect(response).toMatchObject({ ok: true, state: { job: { status: "transcribing" } } });
    expect(h.messages.slice(0, 3).map(m => m.type)).toEqual(["GET_PAGE_STATE", "START_JOB", "SET_PROGRESS"]);
    expect(h.stored).toEqual([{ tabId: 7, videoId: page.videoId, jobId: "job-1", cacheHit: false }]);
    h.complete();
    await h.pending.shift()!();
    expect(h.messages.at(-1)).toMatchObject({ type: "SET_SUBTITLES", videoId: page.videoId, enabled: true, document: { cues: [{ text: "Hello" }] } });
    expect(h.pending).toHaveLength(0);
    expect(h.stored).toEqual([]);
  });

  it("loads cache hits immediately without leaving a poll timer", async () => {
    const h = harness({ cacheHit: true });
    const response = await h.controller.handle({ type: "START_JOB", tabId: 7, force: false });
    expect(response).toMatchObject({ ok: true, state: { cacheHit: true, job: { status: "completed" } } });
    expect(h.messages.some(m => m.type === "SET_SUBTITLES" && m.document?.videoId === page.videoId)).toBe(true);
    expect(h.pending).toHaveLength(0);
  });

  it("cancels the backend and delivers its terminal state", async () => {
    const h = harness();
    await h.controller.handle({ type: "START_JOB", tabId: 7 });
    expect(await h.controller.handle({ type: "CANCEL_JOB", tabId: 7 })).toMatchObject({ ok: true, state: { job: { status: "canceled" } } });
    expect(h.messages.filter(m => m.type === "SET_PROGRESS").at(-1)).toMatchObject({ snapshot: { status: "canceled" } });
    expect(h.pending).toHaveLength(0);
  });

  it("stops delivery after SPA navigation and does not create another job", async () => {
    const h = harness();
    await h.controller.handle({ type: "START_JOB", tabId: 7 });
    await h.controller.pageChanged(7, "abcdefghijk");
    h.complete();
    expect(h.pending).toHaveLength(0);
    expect(h.creates).toBe(1);
    expect(h.messages.some(m => m.type === "SET_SUBTITLES")).toBe(false);
    expect(h.stored).toEqual([]);
  });

  it("resumes persisted active work after a service-worker restart", async () => {
    const h = harness({ cacheHit: true, initialJobs: [{ tabId: 7, videoId: page.videoId, jobId: "job-1", cacheHit: false }] });
    await h.controller.handle({ type: "GET_PAGE_STATE", tabId: 7 });
    expect(h.creates).toBe(0);
    expect(h.messages.some(m => m.type === "SET_SUBTITLES" && !!m.document)).toBe(true);
  });

  it("does not let an in-flight poll overwrite a successful cancellation", async () => {
    const h = harness();
    await h.controller.handle({ type: "START_JOB", tabId: 7 });
    const resolve = h.holdPoll();
    const polling = h.pending.shift()!();
    await h.controller.handle({ type: "CANCEL_JOB", tabId: 7 });
    resolve(snapshot("transcribing"));
    await polling;
    expect(h.messages.filter(m => m.type === "SET_PROGRESS").at(-1)).toMatchObject({ snapshot: { status: "canceled" } });
    expect(h.pending).toHaveLength(0);
  });

  it("restores the processing UI when job creation fails after pausing", async () => {
    const h = harness({ createError: true });
    expect(await h.controller.handle({ type: "START_JOB", tabId: 7 })).toMatchObject({ ok: false, error: { code: "DOWNLOAD_FAILED", retryable: true } });
    expect(h.messages.at(-1)).toMatchObject({ type: "SET_PROGRESS", snapshot: { status: "failed", error: { code: "DOWNLOAD_FAILED" } } });
    expect(h.pending).toHaveLength(0);
  });

  it("rejects unpaired starts before pausing and forwards force for regeneration", async () => {
    const unpaired = harness({ paired: false });
    expect(await unpaired.controller.handle({ type: "START_JOB", tabId: 7 })).toMatchObject({ ok: false, error: { code: "UNPAIRED" } });
    expect(unpaired.messages.some(m => m.type === "START_JOB")).toBe(false);
    const h = harness();
    await h.controller.handle({ type: "START_JOB", tabId: 7, force: true });
    expect(h.force).toBe(true);
  });
});

describe("service-worker entry boundary", () => {
  it("restricts token access and ignores privileged runtime requests from content scripts", async () => {
    type Listener = (message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => boolean | undefined;
    let listener!: Listener;
    let accessLevel = "";
    const replies: unknown[] = [];
    const browser = {
      runtime: { getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: { addListener(callback: Listener) { listener = callback; } } },
      storage: {
        local: { async setAccessLevel(options: { accessLevel: string }) { accessLevel = options.accessLevel; } },
        session: { async get() { return {}; }, async set() {} },
      },
      tabs: { onRemoved: { addListener() {} } },
    } as unknown as typeof chrome;
    installBackground(browser);
    const result = listener({ type: "START_JOB", tabId: 7 }, { url: page.url, tab: { id: 7 } as chrome.tabs.Tab }, value => replies.push(value));
    expect(result).toBe(false);
    expect(accessLevel).toBe("TRUSTED_CONTEXTS");
    expect(replies).toEqual([]);
  });
});
