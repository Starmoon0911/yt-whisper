// @vitest-environment-options {"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installContent } from "../src/content";
import type { ContentRequest, ContentResponse, JobSnapshot, PageChanged } from "../src/contracts";
import type { SubtitleDocument } from "../src/subtitles";
import { mediaFixture, otherVideoId, resetPage, videoId } from "./media";

type Listener = (message: unknown, sender: chrome.runtime.MessageSender, reply: (response: ContentResponse) => void) => boolean;
const subtitles = (): SubtitleDocument => ({ schemaVersion: 1, videoId, language: "en", durationMs: 10000, model: "mlx-community/whisper-large-v3-turbo", generatedAt: "2026-10-15T00:00:00Z", cues: [{ startMs: 0, endMs: 1000, text: "Hello" }, { startMs: 4000, endMs: 5000, text: "Later" }] });
const progress = (status: JobSnapshot["status"]): JobSnapshot => ({ jobId: "", videoId, status, stage: status, progress: null, error: status === "failed" ? { code: "DOWNLOAD_FAILED", message: "下載失敗", retryable: true } : null, result: null });
let stops: (() => void)[];
let frames: Set<number>;
beforeEach(() => {
  resetPage(); stops = []; frames = new Set(); let frame = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => { frames.add(++frame); return frame; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
  vi.stubGlobal("fetch", () => { throw new Error("Content must never fetch localhost"); });
});
afterEach(() => { stops.forEach(stop => stop()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function harness() {
  let listener!: Listener;
  const sent: PageChanged[] = [];
  const browser = {
    runtime: {
      id: "extension-id",
      onMessage: { addListener(callback: Listener) { listener = callback; }, removeListener() {} },
      async sendMessage(message: PageChanged) { if (message.type !== "PAGE_CHANGED") throw new Error("Only navigation can go to worker"); sent.push(message); },
    },
    get storage() { throw new Error("Content cannot access token storage"); },
  } as unknown as typeof chrome;
  stops.push(installContent(browser, document));
  return {
    sent,
    send(message: ContentRequest | unknown, sender: chrome.runtime.MessageSender = { id: "extension-id" }): Promise<ContentResponse | undefined> {
      return new Promise(resolve => { if (!listener(message, sender, resolve)) resolve(undefined); });
    },
  };
}

describe("content message boundary", () => {
  it("returns eligible page state and acknowledges START_JOB only after pausing", async () => {
    const { video } = mediaFixture(); const h = harness();
    expect(await h.send({ type: "GET_PAGE_STATE" })).toMatchObject({ ok: true, page: { videoId, durationMs: 10000, title: "Example video", hasSubtitles: false, subtitlesEnabled: true } });
    expect(await h.send({ type: "START_JOB", videoId })).toMatchObject({ ok: true });
    expect(video.paused).toBe(true);
    expect(video.currentTime).toBe(4.25);
    expect(document.querySelector<HTMLElement>(".ytwhisper-status")?.hidden).toBe(false);
    expect(h.sent).toEqual([{ type: "PAGE_CHANGED", videoId }]);
  });

  it.each(["failed", "canceled"] as const)("restores prior playback without seeking when work is %s", async status => {
    const { video } = mediaFixture(); const h = harness();
    await h.send({ type: "START_JOB", videoId });
    await h.send({ type: "SET_PROGRESS", videoId, snapshot: progress("transcribing") });
    await h.send({ type: "SET_PROGRESS", videoId, snapshot: progress(status) });
    expect(video.currentTime).toBe(4.25);
    expect(video.paused).toBe(false);
    expect(video.playbackRate).toBe(1.5);
    expect(document.querySelector<HTMLElement>(".ytwhisper-status")?.hidden).toBe(status === "canceled");
  });

  it("loads matching completed subtitles from zero and toggles them without seeking", async () => {
    const { video } = mediaFixture(); const h = harness();
    await h.send({ type: "START_JOB", videoId });
    await h.send({ type: "SET_PROGRESS", videoId, snapshot: progress("completed") });
    expect(video.currentTime).toBe(4.25);
    expect(video.paused).toBe(true);
    expect(await h.send({ type: "SET_SUBTITLES", videoId, enabled: true, document: subtitles() })).toMatchObject({ ok: true, page: { hasSubtitles: true, subtitlesEnabled: true } });
    expect(video.currentTime).toBe(0);
    expect(video.paused).toBe(false);
    expect(document.querySelector(".ytwhisper-caption")?.textContent).toBe("Hello");
    video.currentTime = 4.5;
    await h.send({ type: "SET_SUBTITLES", videoId, enabled: false });
    expect(video.currentTime).toBe(4.5);
    expect(document.querySelector<HTMLElement>(".ytwhisper-caption")?.hidden).toBe(true);
    await h.send({ type: "SET_SUBTITLES", videoId, enabled: true });
    expect(document.querySelector(".ytwhisper-caption")?.textContent).toBe("Later");
    expect(h.sent.every(message => message.type === "PAGE_CHANGED")).toBe(true);
  });

  it("rejects stale outer and inner identities without pausing or loading anything", async () => {
    const { video } = mediaFixture(); const h = harness();
    expect(await h.send({ type: "START_JOB", videoId: otherVideoId })).toMatchObject({ ok: false, error: { code: "VIDEO_CHANGED" } });
    expect(await h.send({ type: "SET_PROGRESS", videoId, snapshot: { ...progress("downloading"), videoId: otherVideoId } })).toMatchObject({ ok: false });
    expect(await h.send({ type: "SET_SUBTITLES", videoId, enabled: true, document: { ...subtitles(), videoId: otherVideoId } })).toMatchObject({ ok: false });
    expect(await h.send({ type: "SET_SUBTITLES", videoId, enabled: true, document: { ...subtitles(), cues: [{ startMs: -1, endMs: 100, text: "bad" }] } })).toMatchObject({ ok: false });
    expect(video.paused).toBe(false);
    expect(video.currentTime).toBe(4.25);
    expect((await h.send({ type: "GET_PAGE_STATE" }))).toMatchObject({ ok: true, page: { hasSubtitles: false } });
  });

  it("ignores unknown messages and untrusted senders, including other content scripts", async () => {
    const { video } = mediaFixture(); const h = harness();
    expect(await h.send({ type: "START_JOB", videoId }, { id: "other-extension" })).toBeUndefined();
    expect(await h.send({ type: "START_JOB", videoId }, { id: "extension-id", tab: { id: 7 } as chrome.tabs.Tab })).toBeUndefined();
    expect(await h.send({ type: "PAGE_CHANGED", videoId })).toBeUndefined();
    expect(await h.send(null)).toBeUndefined();
    expect(await h.send({ type: "SET_SUBTITLES", videoId, enabled: "yes" })).toMatchObject({ ok: false });
    expect(video.paused).toBe(false);
  });

  it("reports a play rejection while leaving loaded cues available for manual playback", async () => {
    const { video } = mediaFixture(true); const h = harness();
    Object.defineProperty(video, "play", { value: () => Promise.reject(new Error("NotAllowedError")) });
    expect(await h.send({ type: "SET_SUBTITLES", videoId, enabled: true, document: subtitles() })).toMatchObject({ ok: false, error: { code: "PLAYBACK_BLOCKED", retryable: true } });
    expect(video.currentTime).toBe(0);
    expect(document.querySelector(".ytwhisper-caption")?.textContent).toBe("Hello");
    expect(await h.send({ type: "GET_PAGE_STATE" })).toMatchObject({ ok: true, page: { hasSubtitles: true } });
  });
});

describe("YouTube SPA lifecycle", () => {
  it.each(["failed", "canceled"] as const)("accepts %s during metadata loss and restores playback when metadata returns", async status => {
    const { video } = mediaFixture(); const h = harness();
    await h.send({ type: "START_JOB", videoId });
    Object.defineProperty(video, "duration", { configurable: true, value: NaN });
    video.dispatchEvent(new Event("emptied"));
    expect(await h.send({ type: "SET_PROGRESS", videoId, snapshot: progress(status) })).toEqual({ ok: true, page: null });
    expect(video.paused).toBe(true);
    Object.defineProperty(video, "duration", { value: 10 });
    video.dispatchEvent(new Event("loadedmetadata"));
    await vi.waitFor(() => expect(video.paused).toBe(false));
    expect(video.currentTime).toBe(4.25);
    expect(video.playbackRate).toBe(1.5);
    expect(document.querySelector<HTMLElement>(".ytwhisper-status")?.hidden).toBe(status === "canceled");
    expect(h.sent).toEqual([{ type: "PAGE_CHANGED", videoId }]);
  });

  it("accepts completed subtitles during metadata loss and plays from zero after recovery", async () => {
    const { video } = mediaFixture(); const h = harness();
    await h.send({ type: "START_JOB", videoId });
    Object.defineProperty(video, "duration", { configurable: true, value: NaN });
    video.dispatchEvent(new Event("emptied"));
    expect(await h.send({ type: "SET_PROGRESS", videoId, snapshot: progress("completed") })).toEqual({ ok: true, page: null });
    expect(await h.send({ type: "SET_SUBTITLES", videoId, enabled: true, document: subtitles() })).toEqual({ ok: true, page: null });
    expect(video.currentTime).toBe(4.25);
    expect(video.paused).toBe(true);
    Object.defineProperty(video, "duration", { value: 10 });
    video.dispatchEvent(new Event("loadedmetadata"));
    await vi.waitFor(() => expect(video.paused).toBe(false));
    expect(video.currentTime).toBe(0);
    expect(document.querySelector(".ytwhisper-caption")?.textContent).toBe("Hello");
    video.currentTime = 4.5;
    video.dispatchEvent(new Event("durationchange"));
    expect(video.currentTime).toBe(4.5); // Deferred playback is consumed only once.
  });

  it("discards deferred playback when a different video is confirmed before metadata returns", async () => {
    const { video } = mediaFixture(); const h = harness();
    await h.send({ type: "START_JOB", videoId });
    Object.defineProperty(video, "duration", { configurable: true, value: NaN });
    expect(await h.send({ type: "SET_SUBTITLES", videoId, enabled: true, document: subtitles() })).toEqual({ ok: true, page: null });
    history.replaceState(null, "", `/watch?v=${otherVideoId}`);
    document.dispatchEvent(new Event("yt-navigate-finish"));
    Object.defineProperty(video, "duration", { value: 10 });
    video.dispatchEvent(new Event("loadedmetadata"));
    await Promise.resolve();
    expect(video.paused).toBe(true);
    expect(video.currentTime).toBe(4.25);
    expect(document.querySelector(".ytwhisper-caption")?.textContent).toBe("");
  });

  it("clears cues, progress and animation on navigation without starting another job", async () => {
    const { video } = mediaFixture(); const h = harness();
    await h.send({ type: "SET_SUBTITLES", videoId, enabled: true, document: subtitles() });
    expect(frames.size).toBe(1);
    history.replaceState(null, "", `/watch?v=${otherVideoId}`);
    document.dispatchEvent(new Event("yt-navigate-finish"));
    expect(frames.size).toBe(0);
    expect(document.querySelector(".ytwhisper-caption")?.textContent).toBe("");
    expect(await h.send({ type: "GET_PAGE_STATE" })).toMatchObject({ ok: true, page: { videoId: otherVideoId, hasSubtitles: false } });
    expect(await h.send({ type: "SET_SUBTITLES", videoId, enabled: true, document: subtitles() })).toMatchObject({ ok: false });
    expect(h.sent).toEqual([{ type: "PAGE_CHANGED", videoId }, { type: "PAGE_CHANGED", videoId: otherVideoId }]);
    await h.send({ type: "START_JOB", videoId: otherVideoId });
    history.replaceState(null, "", "/results?search_query=test");
    document.dispatchEvent(new Event("yt-navigate-finish"));
    expect(document.querySelector("[data-ytwhisper-overlay]")).toBeNull();
    expect(await h.send({ type: "GET_PAGE_STATE" })).toEqual({ ok: true, page: null });
    expect(h.sent.at(-1)).toEqual({ type: "PAGE_CHANGED", videoId: null });
    expect(video.currentTime).toBe(0);
  });

  it("rejects old delivery immediately even before the navigation event arrives", async () => {
    const { video } = mediaFixture(); const h = harness();
    history.replaceState(null, "", `/watch?v=${otherVideoId}`);
    expect(await h.send({ type: "START_JOB", videoId })).toMatchObject({ ok: false, error: { code: "VIDEO_CHANGED" } });
    expect(video.paused).toBe(false);
  });

  it("reattaches existing cues to replacement video elements on the same watch page", async () => {
    const old = mediaFixture(); const h = harness();
    await h.send({ type: "SET_SUBTITLES", videoId, enabled: true, document: subtitles() });
    old.container.remove(); const replacement = mediaFixture(true);
    await vi.waitFor(() => expect(replacement.container.querySelector(".ytwhisper-caption")?.textContent).toBe("Later"));
    expect(old.container.querySelector("[data-ytwhisper-overlay]")).toBeNull();
    expect(frames.size).toBe(0);
    expect(replacement.video.currentTime).toBe(4.25);
    expect(h.sent).toEqual([{ type: "PAGE_CHANGED", videoId }]);
  });

  it("rebinds subtitles when the same video moves into a replacement player", async () => {
    const { video, container } = mediaFixture(); const h = harness();
    await h.send({ type: "SET_SUBTITLES", videoId, enabled: true, document: subtitles() });
    const replacement = document.createElement("div"); replacement.className = "html5-video-player";
    replacement.append(video); container.replaceWith(replacement);
    await vi.waitFor(() => expect(replacement.querySelector(".ytwhisper-caption")?.textContent).toBe("Hello"));
    expect(container.querySelector("[data-ytwhisper-overlay]")).toBeNull();
    expect(video.currentTime).toBe(0);
    expect(frames.size).toBe(1);
    expect(h.sent).toEqual([{ type: "PAGE_CHANGED", videoId }]);
  });

  it.each(["failed", "canceled"] as const)("preserves the original playing state across temporary metadata loss before %s", async status => {
    const { video } = mediaFixture(); const h = harness();
    await h.send({ type: "START_JOB", videoId });
    Object.defineProperty(video, "duration", { configurable: true, value: NaN });
    video.dispatchEvent(new Event("emptied"));
    expect(await h.send({ type: "GET_PAGE_STATE" })).toEqual({ ok: true, page: null });
    expect(document.querySelector("[data-ytwhisper-overlay]")).toBeNull();
    Object.defineProperty(video, "duration", { value: 10 });
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(await h.send({ type: "SET_PROGRESS", videoId, snapshot: progress(status) })).toMatchObject({ ok: true });
    expect(video.paused).toBe(false);
    expect(video.currentTime).toBe(4.25);
    expect(video.playbackRate).toBe(1.5);
    expect(h.sent).toEqual([{ type: "PAGE_CHANGED", videoId }]);
  });

  it("preserves the saved playback state when YouTube removes the overlay during processing", async () => {
    const { video } = mediaFixture(); const h = harness();
    await h.send({ type: "START_JOB", videoId });
    document.querySelector("[data-ytwhisper-overlay]")!.remove();
    await vi.waitFor(() => expect(document.querySelector("[data-ytwhisper-overlay]")).not.toBeNull());
    await h.send({ type: "SET_PROGRESS", videoId, snapshot: progress("canceled") });
    expect(video.paused).toBe(false);
    expect(video.currentTime).toBe(4.25);
  });

  it("waits for metadata when a watch page initially has no usable video", async () => {
    const h = harness();
    expect(await h.send({ type: "GET_PAGE_STATE" })).toEqual({ ok: true, page: null });
    const { video } = mediaFixture(true, 0);
    await Promise.resolve();
    expect(document.querySelector("[data-ytwhisper-overlay]")).toBeNull();
    Object.defineProperty(video, "duration", { value: 10 });
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(await h.send({ type: "GET_PAGE_STATE" })).toMatchObject({ ok: true, page: { videoId } });
    expect(document.querySelector("[data-ytwhisper-overlay]")).not.toBeNull();
  });
});
