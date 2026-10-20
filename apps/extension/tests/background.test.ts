import { describe, expect, it } from "vitest";
import { BackgroundController, installBackground } from "../src/background";
import { ApiFailure, LocalApiClient } from "../src/api";
import type { ContentRequest, ContentResponse, JobSnapshot, PageState } from "../src/contracts";
import { documentFixture, invalidDocuments } from "./documents";

const page: PageState = { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", videoId: "dQw4w9WgXcQ", title: "Example", durationMs: 10000, hasSubtitles: false, subtitlesEnabled: true };
const snapshot = (status: JobSnapshot["status"]): JobSnapshot => ({ jobId: "job-1", videoId: page.videoId, status, stage: status, progress: status === "completed" ? 1 : null, speed: null, error: null, result: status === "completed" ? documentFixture() : null });
function harness(options: { cacheHit?: boolean; offline?: boolean; paired?: boolean; initialJobs?: unknown[]; initialPageMissing?: boolean; createError?: boolean; getJob?: () => Promise<JobSnapshot> } = {}) {
  const messages: ContentRequest[] = [];
  const pending: (() => void)[] = [];
  let currentPage: PageState | null = options.initialPageMissing ? null : { ...page };
  let blockedMessage: ContentRequest["type"] | "all" | null = options.initialPageMissing ? "all" : null;
  let deliveryCode = "NO_VIDEO";
  let next = snapshot(options.cacheHit ? "completed" : "transcribing");
  let stored: unknown[] = options.initialJobs ?? [];
  let creates = 0;
  let polls = 0;
  let delayedPoll: Promise<JobSnapshot> | null = null;
  let lastForce: boolean | undefined;
  const api = {
    async health() { if (options.offline) throw new ApiFailure("SERVICE_OFFLINE", "offline", true); return { status: "ok" as const, pairingRequired: false, ffmpegAvailable: true, model: "whisper" }; },
    async isPaired() { return options.paired !== false; },
    async pair(code: string) { if (code !== "123456") throw new ApiFailure("PAIRING_FAILED", "wrong code", false); },
    async createJob(request: { force?: boolean }) { creates++; lastForce = request.force; if (options.createError) throw new ApiFailure("DOWNLOAD_FAILED", "cannot download", true); return { jobId: "job-1", cacheHit: !!options.cacheHit }; },
    async getJob() { polls++; return options.getJob ? options.getJob() : delayedPoll ?? next; },
    async cancelJob() { next = snapshot("canceled"); return next; },
  };
  const controller = new BackgroundController(api, {
    async activeTab() { return 7; },
    async sendToTab(_tabId: number, message: ContentRequest): Promise<ContentResponse> {
      messages.push(message);
      if (message.type !== "GET_PAGE_STATE" && (blockedMessage === "all" || blockedMessage === message.type)) return { ok: false, error: { code: deliveryCode, message: "delivery unavailable", retryable: true } };
      if (message.type === "SET_SUBTITLES" && currentPage) currentPage = { ...currentPage, subtitlesEnabled: message.enabled, hasSubtitles: !!message.document || currentPage.hasSubtitles };
      return { ok: true, page: currentPage };
    },
    async loadJobs() { return stored; },
    async saveJobs(jobs: unknown[]) { stored = jobs; },
    schedule(callback: () => void) { pending.push(callback); return () => { const i = pending.indexOf(callback); if (i >= 0) pending.splice(i, 1); }; },
  });
  return { controller, messages, pending, get stored() { return stored; }, get creates() { return creates; }, get polls() { return polls; }, get force() { return lastForce; }, complete() { next = snapshot("completed"); }, navigate() { currentPage = { ...page, videoId: "abcdefghijk", url: "https://www.youtube.com/watch?v=abcdefghijk" }; },
    metadata(ready: boolean) { currentPage = ready ? { ...page } : null; },
    blockDelivery(type: ContentRequest["type"] | "all" | null, code = "NO_VIDEO") { blockedMessage = type; deliveryCode = code; },
    terminal(status: "failed" | "canceled" | "completed") { next = snapshot(status); },
    holdPoll() { let resolve!: (job: JobSnapshot) => void; delayedPoll = new Promise(r => { resolve = r; }); return resolve; },
  };
}

describe("background job orchestration", () => {
  it("keeps a cancelable job when its first status response is malformed", async () => {
    const client = new LocalApiClient({ async get() { return { token: "secret" }; }, async set() {}, async remove() {} }, async () => new Response(JSON.stringify({ ...snapshot("completed"), result: null })));
    const h = harness({ getJob: () => client.getJob("job-1") });
    expect(await h.controller.handle({ type: "START_JOB", tabId: 7 })).toMatchObject({ ok: true, state: { job: { status: "queued", speed: null }, error: { code: "INVALID_RESPONSE" } } });
    await h.controller.handle({ type: "START_JOB", tabId: 7 });
    expect(h.creates).toBe(1);
    expect(h.pending).toHaveLength(1);
    expect(await h.controller.handle({ type: "CANCEL_JOB", tabId: 7 })).toMatchObject({ ok: true, state: { job: { status: "canceled" } } });
    expect(h.pending).toHaveLength(0);
  });

  it("drops pending delivery when the content response confirms a different video", async () => {
    const h = harness();
    await h.controller.handle({ type: "START_JOB", tabId: 7 });
    h.blockDelivery("all", "VIDEO_CHANGED"); h.complete();
    await h.pending.shift()!();
    expect(h.pending).toHaveLength(0);
    expect(h.stored).toEqual([]);
  });

  it("keeps a completed result after autoplay rejection without replaying it repeatedly", async () => {
    const h = harness();
    await h.controller.handle({ type: "START_JOB", tabId: 7 });
    h.blockDelivery("SET_SUBTITLES", "PLAYBACK_BLOCKED"); h.complete();
    await h.pending.shift()!();
    expect(await h.controller.handle({ type: "GET_PAGE_STATE", tabId: 7 })).toMatchObject({ ok: true, state: { job: { status: "completed" }, error: { code: "PLAYBACK_BLOCKED" } } });
    expect(h.pending).toHaveLength(0);
    expect(h.stored).toEqual([]);
  });

  it("keeps active work when a page snapshot is temporarily null", async () => {
    const h = harness();
    await h.controller.handle({ type: "START_JOB", tabId: 7 });
    h.metadata(false);
    expect(await h.controller.handle({ type: "GET_PAGE_STATE", tabId: 7 })).toMatchObject({ ok: true, state: { page: null, job: { status: "transcribing" } } });
    expect(h.pending).toHaveLength(1);
    expect(h.stored).toHaveLength(1);
    h.metadata(true); h.complete();
    await h.pending.shift()!();
    expect(h.messages.at(-1)).toMatchObject({ type: "SET_SUBTITLES", document: documentFixture() });
  });

  it.each(["completed", "failed", "canceled"] as const)("retains %s for retry when terminal delivery cannot reach the page", async status => {
    const h = harness();
    await h.controller.handle({ type: "START_JOB", tabId: 7 });
    h.blockDelivery("all"); h.terminal(status);
    if (status === "canceled") await h.controller.handle({ type: "CANCEL_JOB", tabId: 7 });
    else await h.pending.shift()!();
    expect(await h.controller.handle({ type: "GET_PAGE_STATE", tabId: 7 })).toMatchObject({ ok: true, state: { job: { status } } });
    expect(h.stored).toHaveLength(1);
    expect(h.pending).toHaveLength(1);
    const fetched = h.polls;
    h.blockDelivery(null);
    await h.pending.shift()!();
    expect(h.polls).toBe(fetched); // Retry the retained terminal, without replacing it.
    expect(h.messages.filter(m => m.type === "SET_PROGRESS").at(-1)).toMatchObject({ snapshot: { status } });
    if (status === "completed") expect(h.messages.at(-1)).toMatchObject({ type: "SET_SUBTITLES", document: documentFixture() });
    expect(h.pending).toHaveLength(0);
    expect(h.stored).toEqual([]);
  });

  it("retries a completed document when progress succeeds but subtitle delivery fails", async () => {
    const h = harness();
    await h.controller.handle({ type: "START_JOB", tabId: 7 });
    h.blockDelivery("SET_SUBTITLES"); h.complete();
    await h.pending.shift()!();
    expect(h.messages.filter(m => m.type === "SET_PROGRESS").at(-1)).toMatchObject({ snapshot: { status: "completed" } });
    expect(h.pending).toHaveLength(1);
    expect(h.stored).toHaveLength(1);
    h.blockDelivery(null);
    await h.pending.shift()!();
    expect(h.messages.at(-1)).toMatchObject({ type: "SET_SUBTITLES", document: documentFixture() });
    expect(h.stored).toEqual([]);
  });

  it("restores undelivered work after worker restart while page metadata is missing", async () => {
    const h = harness({ initialPageMissing: true, cacheHit: true, initialJobs: [{ tabId: 7, videoId: page.videoId, jobId: "job-1", cacheHit: false }] });
    await h.controller.handle({ type: "GET_PAGE_STATE", tabId: 7 });
    expect(h.stored).toHaveLength(1);
    expect(h.pending).toHaveLength(1);
    h.metadata(true); h.blockDelivery(null);
    await h.pending.shift()!();
    expect(h.messages.at(-1)).toMatchObject({ type: "SET_SUBTITLES", document: documentFixture() });
    expect(h.creates).toBe(0);
  });

  it.each(["abcdefghijk", null])("discards pending delivery only on confirmed navigation or removal (%s)", async videoId => {
    const h = harness();
    await h.controller.handle({ type: "START_JOB", tabId: 7 });
    h.blockDelivery("all"); h.complete();
    await h.pending.shift()!();
    expect(h.pending).toHaveLength(1);
    await h.controller.pageChanged(7, videoId);
    expect(h.pending).toHaveLength(0);
    expect(h.stored).toEqual([]);
  });

  it.each(invalidDocuments)("continues polling after a malformed completed $name", async ({ value }) => {
    const responses = [snapshot("transcribing"), { ...snapshot("completed"), result: value }, snapshot("completed")];
    const client = new LocalApiClient({ async get() { return { token: "secret" }; }, async set() {}, async remove() {} }, async () => new Response(JSON.stringify(responses.shift())));
    const h = harness({ getJob: () => client.getJob("job-1") });
    await h.controller.handle({ type: "START_JOB", tabId: 7 });
    await h.pending.shift()!();
    expect(h.messages.some(m => m.type === "SET_SUBTITLES")).toBe(false);
    expect(h.pending).toHaveLength(1);
    expect(h.stored).toHaveLength(1);
    expect(await h.controller.handle({ type: "GET_PAGE_STATE", tabId: 7 })).toMatchObject({ ok: true, state: { job: { status: "transcribing" }, error: { code: "INVALID_RESPONSE" } } });
    await h.pending.shift()!();
    expect(h.messages.at(-1)).toMatchObject({ type: "SET_SUBTITLES", document: documentFixture() });
    expect(h.pending).toHaveLength(0);
    expect(h.stored).toEqual([]);
  });

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
    expect(h.messages.at(-1)).toMatchObject({ type: "SET_PROGRESS", snapshot: { status: "failed", stage: "failed", speed: null, error: { code: "DOWNLOAD_FAILED" } } });
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
