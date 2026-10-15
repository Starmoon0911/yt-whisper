import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountPopup } from "../src/popup";
import type { BackgroundRequest, BackgroundResponse, PopupState } from "../src/contracts";

const state = (): PopupState => ({ tabId: 7, page: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", videoId: "dQw4w9WgXcQ", title: "Example video", durationMs: 10000, subtitlesEnabled: true, hasSubtitles: false }, health: { status: "ok", pairingRequired: false, ffmpegAvailable: true, model: "whisper" }, paired: true, job: null, cacheHit: false, error: null });
const button = (id: string) => document.querySelector<HTMLButtonElement>(`#${id}`)!;
const tick = () => vi.waitFor(() => expect(button("refresh").disabled).toBe(false));
beforeEach(() => { document.documentElement.innerHTML = readFileSync("src/popup.html", "utf8"); });

describe("popup user flow", () => {
  it("shows offline guidance and disables work actions", async () => {
    const current = { ...state(), health: null, error: { code: "SERVICE_OFFLINE", message: "請啟動本機服務", retryable: true } };
    mountPopup(document, async () => ({ ok: true, state: current }), 0);
    await tick();
    expect(document.querySelector("#service-status")?.textContent).toContain("離線");
    expect(document.querySelector("#error")?.textContent).toContain("請啟動本機服務");
    expect(button("start").disabled).toBe(true);
    expect(button("regenerate").disabled).toBe(true);
  });

  it("pairs through the worker and clears the code from the form", async () => {
    const current = { ...state(), paired: false };
    const messages: BackgroundRequest[] = [];
    mountPopup(document, async message => { messages.push(message); if (message.type === "PAIR") current.paired = true; return { ok: true, state: current }; }, 0);
    await tick();
    expect(document.querySelector<HTMLFormElement>("#pair-form")?.hidden).toBe(false);
    const input = document.querySelector<HTMLInputElement>("#pair-code")!;
    input.value = "123456";
    document.querySelector("#pair-form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(input.value).toBe(""));
    expect(messages).toContainEqual({ type: "PAIR", code: "123456" });
    expect(document.querySelector<HTMLFormElement>("#pair-form")?.hidden).toBe(true);
  });

  it("starts and regenerates using the video tab shown in the popup", async () => {
    const messages: BackgroundRequest[] = [];
    mountPopup(document, async message => { messages.push(message); return { ok: true, state: state() }; }, 0);
    await tick();
    expect(document.querySelector("#video-title")?.textContent).toBe("Example video");
    button("start").click(); await tick();
    button("regenerate").click(); await tick();
    expect(messages).toContainEqual({ type: "START_JOB", tabId: 7, force: false });
    expect(messages).toContainEqual({ type: "START_JOB", tabId: 7, force: true });
  });

  it("shows progress and cancellation while preventing a duplicate start", async () => {
    const current = state();
    current.job = { jobId: "job-1", videoId: current.page!.videoId, status: "transcribing", stage: "transcribing", progress: 0.4, error: null, result: null };
    const messages: BackgroundRequest[] = [];
    mountPopup(document, async message => { messages.push(message); return { ok: true, state: current }; }, 0);
    await tick();
    expect(document.querySelector("#job-status")?.textContent).toContain("辨識");
    expect(document.querySelector<HTMLProgressElement>("#progress")?.value).toBe(0.4);
    expect(button("start").disabled).toBe(true);
    button("cancel").click(); await tick();
    expect(messages).toContainEqual({ type: "CANCEL_JOB", tabId: 7 });
  });

  it("toggles subtitles and labels a completed cache hit", async () => {
    const current = state(); current.page!.hasSubtitles = true; current.cacheHit = true;
    current.job = { jobId: "job-1", videoId: current.page!.videoId, status: "completed", stage: "completed", progress: 1, error: null, result: null };
    const messages: BackgroundRequest[] = [];
    mountPopup(document, async message => { messages.push(message); return { ok: true, state: current }; }, 0);
    await tick();
    expect(document.querySelector("#job-status")?.textContent).toContain("快取");
    const toggle = document.querySelector<HTMLInputElement>("#subtitles")!;
    toggle.checked = false; toggle.dispatchEvent(new Event("change")); await tick();
    expect(messages).toContainEqual({ type: "SET_SUBTITLES", tabId: 7, enabled: false });
  });

  it("renders errors as text and preserves page state after an action fails", async () => {
    const current = state();
    mountPopup(document, async (message: BackgroundRequest): Promise<BackgroundResponse> => message.type === "START_JOB"
      ? { ok: false, error: { code: "DOWNLOAD_FAILED", message: "<img src=x onerror=alert(1)>", retryable: true } }
      : { ok: true, state: current }, 0);
    await tick(); button("start").click(); await tick();
    expect(document.querySelector("#error")?.textContent).toContain("<img");
    expect(document.querySelector("#error img")).toBeNull();
    expect(button("start").disabled).toBe(false);
    expect(document.querySelector("#video-title")?.textContent).toBe("Example video");
  });
});
