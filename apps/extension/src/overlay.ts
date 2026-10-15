import { isActiveJob, type JobSnapshot } from "./contracts";
import { cueAtTime, type SubtitleDocument } from "./subtitles";

function validDocument(value: SubtitleDocument, videoId: string): boolean {
  if (!value || value.schemaVersion !== 1 || value.videoId !== videoId || !Number.isSafeInteger(value.durationMs) || value.durationMs <= 0
    || typeof value.language !== "string" || typeof value.model !== "string" || typeof value.generatedAt !== "string" || !Array.isArray(value.cues)) return false;
  let previousEnd = 0;
  for (const cue of value.cues) {
    if (!cue || !Number.isSafeInteger(cue.startMs) || !Number.isSafeInteger(cue.endMs) || cue.startMs < previousEnd
      || cue.endMs <= cue.startMs || cue.endMs > value.durationMs || typeof cue.text !== "string") return false;
    previousEnd = cue.endMs;
  }
  return true;
}

export class SubtitleOverlay {
  private root: HTMLDivElement;
  private caption: HTMLDivElement;
  private status: HTMLDivElement;
  private statusText: HTMLDivElement;
  private progress: HTMLProgressElement;
  private document: SubtitleDocument | null = null;
  private visible = true;
  private processing = false;
  private frame: number | null = null;
  private disposed = false;
  private window: Window;
  private events = ["play", "playing", "pause", "seeking", "seeked", "ratechange", "timeupdate", "ended"];

  constructor(private container: HTMLElement, private video: HTMLVideoElement, private videoId: string) {
    const document = container.ownerDocument;
    this.window = document.defaultView!;
    this.root = document.createElement("div");
    this.root.dataset.ytwhisperOverlay = "";
    this.caption = document.createElement("div"); this.caption.className = "ytwhisper-caption"; this.caption.hidden = true;
    this.status = document.createElement("div"); this.status.className = "ytwhisper-status"; this.status.hidden = true;
    this.status.setAttribute("role", "status"); this.status.setAttribute("aria-live", "polite");
    this.statusText = document.createElement("div");
    this.progress = document.createElement("progress"); this.progress.max = 1; this.progress.setAttribute("aria-label", "字幕處理進度");
    this.status.append(this.statusText, this.progress); this.root.append(this.caption, this.status); container.append(this.root);
    for (const name of this.events) video.addEventListener(name, this.update);
  }

  get hasDocument(): boolean { return this.document !== null; }
  get enabled(): boolean { return this.visible; }
  get mounted(): boolean { return !this.disposed && this.root.parentElement === this.container; }

  setDocument(document: SubtitleDocument): boolean {
    if (this.disposed || !validDocument(document, this.videoId)) return false;
    this.document = document;
    this.processing = false;
    this.status.hidden = true;
    this.update();
    return true;
  }

  setEnabled(enabled: boolean): void { this.visible = enabled; this.update(); }

  setProgress(snapshot: JobSnapshot): void {
    if (this.disposed || snapshot.videoId !== this.videoId) return;
    this.processing = isActiveJob(snapshot);
    this.status.hidden = !this.processing && snapshot.status !== "failed";
    this.progress.hidden = !this.processing;
    const labels = { queued: "字幕工作排隊中…", downloading: "正在下載音訊…", converting: "正在轉換音訊…", transcribing: "正在辨識字幕…", completed: "", failed: "字幕處理失敗，請重試。", canceled: "" };
    this.statusText.textContent = snapshot.status === "failed" ? snapshot.error?.message || labels.failed : labels[snapshot.stage];
    if (snapshot.progress === null || !Number.isFinite(snapshot.progress)) this.progress.removeAttribute("value");
    else this.progress.value = Math.min(1, Math.max(0, snapshot.progress));
    this.update();
  }

  clear(): void {
    this.document = null; this.processing = false;
    this.status.hidden = true; this.statusText.textContent = ""; this.progress.removeAttribute("value");
    this.update();
  }

  destroy(): void {
    this.clear(); this.disposed = true;
    for (const name of this.events) this.video.removeEventListener(name, this.update);
    this.root.remove();
  }

  private update = (): void => {
    if (this.disposed) return;
    const cue = this.visible && !this.processing && this.document ? cueAtTime(this.document.cues, this.video.currentTime * 1000) : null;
    const text = cue?.text ?? "";
    if (this.caption.textContent !== text) this.caption.textContent = text;
    this.caption.hidden = text.length === 0;
    const animate = !!this.document && this.visible && !this.processing && !this.video.paused && !this.video.ended && this.root.isConnected;
    if (!animate && this.frame !== null) { this.window.cancelAnimationFrame(this.frame); this.frame = null; }
    if (animate && this.frame === null) this.frame = this.window.requestAnimationFrame(() => { this.frame = null; this.update(); });
  };
}
