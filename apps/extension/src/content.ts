import { isActiveJob, type ContentRequest, type ContentResponse, type JobSnapshot, type PageChanged, type PageState } from "./contracts";
import { SubtitleOverlay } from "./overlay";
import { PlayerController } from "./player";
import { extractVideoId, type SubtitleDocument } from "./subtitles";

const commandTypes = ["GET_PAGE_STATE", "START_JOB", "SET_PROGRESS", "SET_SUBTITLES"];
const statuses = ["queued", "downloading", "converting", "transcribing", "completed", "failed", "canceled"];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const failure = (code: string, message: string, retryable = true): ContentResponse => ({ ok: false, error: { code, message, retryable } });

function validSnapshot(value: unknown): value is JobSnapshot {
  if (!record(value)) return false;
  const error = value.error;
  return typeof value.jobId === "string" && typeof value.videoId === "string" && statuses.includes(value.status as string) && statuses.includes(value.stage as string)
    && (value.progress === null || typeof value.progress === "number" && Number.isFinite(value.progress))
    && (error === null || record(error) && typeof error.code === "string" && typeof error.message === "string" && typeof error.retryable === "boolean")
    && (value.result === null || record(value.result));
}

class ContentController {
  private player: PlayerController;
  private overlay: SubtitleOverlay | null = null;
  private boundVideo: HTMLVideoElement | null = null;
  private boundContainer: HTMLElement | null = null;
  private videoId: string | null | undefined;
  private subtitles: SubtitleDocument | null = null;
  private progress: JobSnapshot | null = null;
  private enabled = true;
  private observer: MutationObserver;
  private disposed = false;
  private mediaEvents = ["loadedmetadata", "durationchange", "emptied"];

  constructor(private document: Document, private notify: (message: PageChanged) => Promise<unknown>) {
    this.player = new PlayerController(document);
    this.observer = new MutationObserver(this.refresh);
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("yt-navigate-finish", this.refresh);
    for (const name of this.mediaEvents) document.addEventListener(name, this.refresh, true);
    this.refresh();
  }

  async handle(value: unknown): Promise<ContentResponse> {
    if (!record(value) || !commandTypes.includes(value.type as string)) return failure("INVALID_MESSAGE", "無效的播放器訊息。", false);
    this.refresh();
    if (value.type === "GET_PAGE_STATE") return { ok: true, page: this.page() };
    if (typeof value.videoId !== "string") return failure("INVALID_MESSAGE", "訊息缺少影片識別碼。", false);
    if (value.videoId !== this.videoId) return failure("VIDEO_CHANGED", "影片已切換，請在目前影片重新操作。");
    if (!this.player.snapshot() || !this.overlay) return failure("NO_VIDEO", "請等待一般 YouTube 影片載入；不支援直播。", false);

    if (value.type === "START_JOB") {
      this.player.pauseForProcessing();
      this.progress = { jobId: "", videoId: value.videoId, status: "queued", stage: "queued", progress: null, error: null, result: null };
      this.overlay.setProgress(this.progress);
    } else if (value.type === "SET_PROGRESS") {
      if (!validSnapshot(value.snapshot) || value.snapshot.videoId !== this.videoId) return failure("INVALID_MESSAGE", "工作與目前影片不相符。", false);
      this.progress = value.snapshot;
      this.overlay.setProgress(this.progress);
      if (this.progress.status === "failed" || this.progress.status === "canceled") {
        // An autoplay restriction must not replace the original job failure.
        await this.player.restoreAfterProcessing().catch(() => {});
      }
    } else if (value.type === "SET_SUBTITLES") {
      if (typeof value.enabled !== "boolean") return failure("INVALID_MESSAGE", "無效的字幕開關。", false);
      if (value.document !== undefined) {
        if (!record(value.document) || !this.overlay.setDocument(value.document as unknown as SubtitleDocument)) {
          return failure("INVALID_SUBTITLES", "字幕文件無效或與目前影片不相符。", false);
        }
        this.subtitles = value.document as unknown as SubtitleDocument;
        this.progress = null;
      }
      this.enabled = value.enabled;
      this.overlay.setEnabled(this.enabled);
      if (value.document !== undefined) {
        try { await this.player.playFromStart(); }
        catch { return failure("PLAYBACK_BLOCKED", "字幕已載入，請按影片播放鍵開始播放。"); }
        finally { this.overlay?.setEnabled(this.enabled); }
      }
    }
    return { ok: true, page: this.page() };
  }

  destroy(): void {
    this.disposed = true;
    this.observer.disconnect();
    this.document.removeEventListener("yt-navigate-finish", this.refresh);
    for (const name of this.mediaEvents) this.document.removeEventListener(name, this.refresh, true);
    this.overlay?.destroy();
    this.player.forgetProcessing();
  }

  private page(): PageState | null {
    const state = this.player.snapshot();
    return state ? { url: state.url, videoId: state.videoId, title: state.title, durationMs: state.durationMs, subtitlesEnabled: this.enabled, hasSubtitles: this.subtitles !== null } : null;
  }

  private refresh = (): void => {
    if (this.disposed) return;
    const videoId = extractVideoId(this.document.location.href);
    if (videoId !== this.videoId) {
      this.overlay?.destroy(); this.overlay = null; this.boundVideo = null; this.boundContainer = null;
      this.videoId = videoId; this.subtitles = null; this.progress = null; this.enabled = true;
      this.player.forgetProcessing();
      // This is the only content -> worker message. Worker commands stay local.
      void this.notify({ type: "PAGE_CHANGED", videoId }).catch(() => {});
    }
    // Metadata readiness can change without changing media identity. Retain the
    // processing snapshot until the actual video element or watch ID changes.
    const video = this.player.video;
    const container = this.player.container;
    const eligible = this.player.snapshot() !== null;
    if (video === this.boundVideo && container === this.boundContainer && (eligible ? this.overlay?.mounted : !this.overlay)) return;
    if (video !== this.boundVideo) this.player.forgetProcessing();
    this.overlay?.destroy(); this.overlay = null; this.boundVideo = video; this.boundContainer = container;
    if (eligible && video && videoId && container) {
      this.overlay = new SubtitleOverlay(container, video, videoId);
      if (this.subtitles) this.overlay.setDocument(this.subtitles);
      this.overlay.setEnabled(this.enabled);
      if (this.progress) {
        if (isActiveJob(this.progress)) this.player.pauseForProcessing();
        this.overlay.setProgress(this.progress);
      }
    }
  };
}

export function installContent(browser: typeof chrome, document: Document = globalThis.document): () => void {
  const controller = new ContentController(document, message => browser.runtime.sendMessage(message));
  const listener = (message: unknown, sender: chrome.runtime.MessageSender, reply: (response: ContentResponse) => void): boolean => {
    if (sender.id !== browser.runtime.id || sender.tab || !record(message) || !commandTypes.includes(message.type as string)) return false;
    void controller.handle(message as unknown as ContentRequest).then(reply, () => reply(failure("PLAYER_ERROR", "播放器無法完成操作，請重新整理後再試。")));
    return true;
  };
  browser.runtime.onMessage.addListener(listener);
  return () => { browser.runtime.onMessage.removeListener(listener); controller.destroy(); };
}

if (typeof chrome !== "undefined" && chrome.runtime?.id && typeof document !== "undefined") installContent(chrome, document);
