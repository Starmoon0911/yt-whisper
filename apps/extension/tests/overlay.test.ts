// @vitest-environment-options {"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubtitleOverlay } from "../src/overlay";
import type { JobSnapshot } from "../src/contracts";
import type { SubtitleDocument } from "../src/subtitles";
import { mediaFixture, otherVideoId, resetPage, videoId } from "./media";
import { invalidDocuments } from "./documents";

const subtitles = (): SubtitleDocument => ({ schemaVersion: 1, videoId, language: "en", durationMs: 10000, model: "mlx-community/whisper-large-v3-turbo", generatedAt: "2026-10-15T00:00:00Z", cues: [
  { startMs: 0, endMs: 1000, text: "First" }, { startMs: 1000, endMs: 2000, text: "Second\nline" }, { startMs: 3000, endMs: 4000, text: "<img src=x onerror=alert(1)>" },
] });
const progress = (status: JobSnapshot["status"], value: number | null = null, speed: number | null = null): JobSnapshot => ({ jobId: "job-1", videoId, status, stage: status, progress: value, speed, error: null, result: null });
let frames: Map<number, FrameRequestCallback>;
let overlays: SubtitleOverlay[];
beforeEach(() => {
  resetPage(); overlays = []; frames = new Map(); let id = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++id, callback); return id; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
});
afterEach(() => { overlays.forEach(overlay => overlay.destroy()); vi.restoreAllMocks(); });
function fixture(paused = true) {
  const media = mediaFixture(paused);
  const overlay = new SubtitleOverlay(media.container, media.video, videoId);
  overlays.push(overlay);
  return { ...media, overlay, caption: media.container.querySelector<HTMLElement>(".ytwhisper-caption")!, card: media.container.querySelector<HTMLElement>(".ytwhisper-status")! };
}
function frame() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(123456)); }

describe("subtitle overlay timeline", () => {
  it.each(invalidDocuments)("keeps usable cues when a $name document is rejected", ({ value }) => {
    const { overlay, video, caption } = fixture();
    video.currentTime = 0;
    overlay.setDocument(subtitles());
    expect(overlay.setDocument(value as SubtitleDocument)).toBe(false);
    expect(caption.textContent).toBe("First");
  });

  it("mounts inside the player and renders half-open cue boundaries and gaps", () => {
    const { overlay, video, container, caption } = fixture();
    video.currentTime = 0; overlay.setDocument(subtitles());
    expect(container.querySelector("[data-ytwhisper-overlay]")?.contains(caption)).toBe(true);
    expect(caption.textContent).toBe("First");
    for (const [time, text] of [[0.999, "First"], [1, "Second\nline"], [2, ""], [2.999, ""], [3, "<img src=x onerror=alert(1)>"], [4, ""]] as const) {
      video.currentTime = time; video.dispatchEvent(new Event("seeked"));
      expect(caption.textContent).toBe(text);
      expect(caption.hidden).toBe(text === "");
    }
    expect(container.querySelector("img")).toBeNull();
  });

  it("uses currentTime at any playback rate and only schedules frames while playing", async () => {
    const { overlay, video, caption } = fixture();
    video.currentTime = 0; overlay.setDocument(subtitles());
    expect(frames.size).toBe(0);
    await video.play();
    expect(frames.size).toBe(1);
    video.playbackRate = 2; video.currentTime = 1.2; frame();
    expect(caption.textContent).toBe("Second\nline");
    expect(frames.size).toBe(1);
    video.currentTime = 3.5; video.pause();
    expect(caption.textContent).toContain("<img");
    expect(frames.size).toBe(0);
    video.currentTime = 0.3; video.dispatchEvent(new Event("seeking"));
    expect(caption.textContent).toBe("First");
  });

  it("toggles visibility without discarding cues or changing playback", () => {
    const { overlay, video, caption } = fixture(false);
    video.currentTime = 0.5; overlay.setDocument(subtitles());
    overlay.setEnabled(false);
    expect(caption.hidden).toBe(true);
    expect(overlay.hasDocument).toBe(true);
    expect(frames.size).toBe(0);
    expect(video.currentTime).toBe(0.5);
    expect(video.paused).toBe(false);
    video.currentTime = 1.5; overlay.setEnabled(true);
    expect(caption.hidden).toBe(false);
    expect(caption.textContent).toBe("Second\nline");
    expect(frames.size).toBe(1);
  });

  it("rejects mismatched and malformed documents without replacing good cues", () => {
    const { overlay, video, caption } = fixture();
    video.currentTime = 0; expect(overlay.setDocument(subtitles())).toBe(true);
    expect(overlay.setDocument({ ...subtitles(), videoId: otherVideoId })).toBe(false);
    expect(overlay.setDocument({ ...subtitles(), cues: [{ startMs: 1000, endMs: 0, text: "bad" }] })).toBe(false);
    expect(overlay.setDocument({ ...subtitles(), cues: [{ startMs: 0, endMs: 2000, text: "a" }, { startMs: 1000, endMs: 3000, text: "b" }] })).toBe(false);
    expect(caption.textContent).toBe("First");
  });

  it("clears cues, progress and frames and removes media listeners on disposal", async () => {
    const { overlay, video, container, caption, card } = fixture(false);
    overlay.setDocument(subtitles()); overlay.setProgress(progress("downloading", 0.4));
    overlay.clear();
    expect(overlay.hasDocument).toBe(false);
    expect(caption.hidden).toBe(true);
    expect(card.hidden).toBe(true);
    expect(frames.size).toBe(0);
    overlay.destroy();
    await video.play();
    expect(container.querySelector("[data-ytwhisper-overlay]")).toBeNull();
    expect(frames.size).toBe(0);
  });

  it("does not report an overlay in a detached player as mounted", () => {
    const { overlay, container } = fixture();
    expect(overlay.mounted).toBe(true);
    container.remove();
    expect(overlay.mounted).toBe(false);
  });

  it.each(["normal", "theater", "fullscreen"])("keeps the overlay in the player when layout becomes %s", mode => {
    const { overlay, video, container, caption } = fixture();
    video.currentTime = 0; overlay.setDocument(subtitles());
    const layout = document.createElement("section"); layout.dataset.mode = mode; document.body.append(layout); layout.append(container);
    if (mode === "fullscreen") { Object.defineProperty(document, "fullscreenElement", { configurable: true, value: container }); document.dispatchEvent(new Event("fullscreenchange")); }
    expect(container.querySelector("[data-ytwhisper-overlay]")?.contains(caption)).toBe(true);
    expect(caption.textContent).toBe("First");
  });
});

describe("processing card", () => {
  it("shows determinate and indeterminate progress, hides cues, and clears completion", () => {
    const { overlay, video, caption, card } = fixture();
    video.currentTime = 0; overlay.setDocument(subtitles());
    overlay.setProgress(progress("downloading", 0.4));
    expect(card.hidden).toBe(false);
    expect(card.textContent).toContain("下載");
    expect(card.querySelector("progress")?.value).toBe(0.4);
    expect(caption.hidden).toBe(true);
    overlay.setProgress(progress("transcribing"));
    expect(card.textContent).toContain("辨識");
    expect(card.querySelector("progress")?.hasAttribute("value")).toBe(false);
    overlay.setProgress(progress("completed", 1));
    expect(card.hidden).toBe(true);
    expect(caption.textContent).toBe("First");
    expect(video.currentTime).toBe(0);
  });

  it("renders failure text safely and leaves cancellation without stale progress", () => {
    const { overlay, video, container, card } = fixture();
    overlay.setProgress({ ...progress("failed"), error: { code: "DOWNLOAD_FAILED", message: "<img src=x onerror=alert(1)>", retryable: true } });
    expect(card.hidden).toBe(false);
    expect(card.textContent).toContain("<img");
    expect(container.querySelector("img")).toBeNull();
    expect(card.querySelector("progress")?.hidden).toBe(true);
    expect(video.currentTime).toBe(4.25);
    overlay.setProgress(progress("canceled"));
    expect(card.hidden).toBe(true);
    expect(video.currentTime).toBe(4.25);
  });

  it("ignores progress belonging to another video", () => {
    const { overlay, card } = fixture();
    overlay.setProgress({ ...progress("downloading"), videoId: otherVideoId });
    expect(card.hidden).toBe(true);
  });
});
